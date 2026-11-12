//! In-memory ownership of revision-bound planner proposals.
use crate::{
    database::{CompiledBatch, PlannerDatabase, RestoreToken, UndoToken},
    dates::{date, time},
    schema::{Action, Change, DraftApply, Entity},
};
use anyhow::{Result, anyhow, bail, ensure};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
};
use uuid::Uuid;

pub(crate) const DELETION_SCOPE: &str = "deletionScope";

#[derive(Clone)]
pub(crate) struct Issue {
    id: String,
    pub field: String,
    question: String,
    pub source: Option<String>,
    entity: Option<Entity>,
    target_id: Option<String>,
    conflicting_fields: Vec<String>,
    blocked: bool,
}

impl Issue {
    pub(crate) fn new(
        field: &str,
        question: String,
        source: Option<String>,
        target: Option<(Entity, String)>,
    ) -> Self {
        let (entity, target_id) =
            target.map_or((None, None), |(entity, id)| (Some(entity), Some(id)));
        Self {
            id: uid(),
            field: field.into(),
            question,
            source,
            entity,
            target_id,
            conflicting_fields: Vec::new(),
            blocked: false,
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn target_id(&self) -> Option<&str> {
        self.target_id.as_deref()
    }

    fn view(&self) -> Value {
        let mut value =
            json!({"id":self.id,"required":true,"field":self.field,"question":self.question});
        if let Some(entity) = self.entity {
            value["entity"] = json!(entity);
        }
        if let Some(id) = &self.target_id {
            value["targetId"] = json!(id);
        }
        if self.field == "conflict" {
            value["conflictingFields"] = json!(self.conflicting_fields);
        }
        value
    }
}

pub(crate) fn uid() -> String {
    Uuid::new_v4().to_string()
}

struct Proposal {
    id: String,
    version: i64,
    revision: i64,
    timezone: String,
    base: Value,
    clock: DateTime<Utc>,
    changes: Vec<Change>,
    batch: CompiledBatch,
    undo: Option<UndoToken>,
    restores: Vec<RestoreToken>,
    issues: Vec<Issue>,
}

#[derive(Default)]
struct State {
    generation: u64,
    active: HashSet<String>,
    current: Option<Proposal>,
    last_applied_revision: Option<i64>,
    deleted: HashMap<(Entity, String), (Value, RestoreToken)>,
}

pub(crate) struct Turn<'a> {
    owner: &'a PendingDraftService,
    job: String,
    generation: u64,
    pub snapshot: Value,
    pub current: Option<Value>,
    pub issues: Vec<Issue>,
    revision: i64,
    timezone: String,
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.owner.state.lock() {
            state.active.remove(&self.job);
        }
    }
}

#[derive(Default)]
pub(crate) struct Stage {
    pub changes: Vec<Change>,
    pub issue: Option<Issue>,
    pub resolve_deletion: bool,
    pub undo: bool,
    pub restore: Option<(Entity, String)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    draft_id: String,
    version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    draft_id: String,
    version: i64,
    expected_revision: i64,
    #[serde(default)]
    changes: Vec<Change>,
    #[serde(default)]
    repreview: bool,
    #[serde(default)]
    resolve_issue_ids: Vec<String>,
}

pub struct PendingDraftService {
    db: Arc<Mutex<PlannerDatabase>>,
    state: Mutex<State>,
}

impl PendingDraftService {
    pub fn new(db: Arc<Mutex<PlannerDatabase>>) -> Self {
        Self {
            db,
            state: Mutex::new(State::default()),
        }
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| anyhow!("Draft state unavailable."))
    }

    fn db(&self) -> Result<MutexGuard<'_, PlannerDatabase>> {
        self.db
            .lock()
            .map_err(|_| anyhow!("Planner database unavailable."))
    }

    pub fn get_draft(&self) -> Result<Option<Value>> {
        let state = self.state()?;
        if let Some(current) = &state.current {
            Ok(Some(view(
                current,
                &self.db()?.snapshot()?,
                !state.active.is_empty(),
            )))
        } else {
            Ok(None)
        }
    }

    pub(crate) fn begin(&self) -> Result<Turn<'_>> {
        let mut state = self.state()?;
        let live = self.db()?.snapshot()?;
        let snapshot = state
            .current
            .as_ref()
            .map_or_else(|| live.clone(), |current| projected(current, &live));
        let current = state
            .current
            .as_ref()
            .map(|current| view(current, &live, true));
        let issues = state
            .current
            .as_ref()
            .map_or_else(Vec::new, |current| current.issues.clone());
        let job = uid();
        state.active.insert(job.clone());
        Ok(Turn {
            owner: self,
            job,
            generation: state.generation,
            snapshot,
            current,
            issues,
            revision: revision(&live),
            timezone: timezone(&live).into(),
        })
    }

    pub(crate) fn stage(&self, turn: &Turn<'_>, stage: Stage) -> Result<Value> {
        let mut state = self.state()?;
        let mut db = self.db()?;
        let live = db.snapshot()?;
        ensure!(
            state.active.contains(&turn.job) && state.generation == turn.generation,
            "This draft changed while the assistant was working. Your latest preview is preserved."
        );
        ensure!(
            turn.revision == revision(&live) && turn.timezone == timezone(&live),
            "Your planner changed while the assistant was working. Please send the request again."
        );
        if let Some(current) = &state.current {
            require_fresh(current, &live)?;
        }
        let mut undo = state.current.as_ref().and_then(|draft| draft.undo.clone());
        if stage.undo {
            let previous = state
                .last_applied_revision
                .ok_or_else(|| anyhow!("There is no applied change in this chat to undo."))?;
            undo = Some(db.capture_undo(previous)?);
        }
        let mut restores = state
            .current
            .as_ref()
            .map_or_else(Vec::new, |draft| draft.restores.clone());
        if let Some(key) = stage.restore {
            ensure!(
                record(&turn.snapshot, key.0, &key.1).is_none(),
                "This item is already in your planner."
            );
            let (_, token) = state
                .deleted
                .get(&key)
                .ok_or_else(|| anyhow!("This item was not deleted in this chat."))?;
            restores.push(token.clone());
        }
        let old = state.current.as_ref();
        let mut proposal = compile(&mut db, &live, old, stage.changes, undo, restores, &[])?;
        if stage.resolve_deletion {
            proposal
                .issues
                .retain(|issue| issue.field != DELETION_SCOPE);
        }
        if let Some(issue) = stage.issue {
            proposal.issues.push(issue);
        }
        let output = view(&proposal, &live, false);
        state.current = Some(proposal);
        state.generation += 1;
        Ok(output)
    }

    pub(crate) fn deleted_targets(&self) -> Result<Vec<(Entity, String, String)>> {
        Ok(self
            .state()?
            .deleted
            .iter()
            .map(|((entity, id), (item, _))| {
                (
                    *entity,
                    id.clone(),
                    item["title"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect())
    }

    pub fn edit_draft(&self, input: Value) -> Result<Value> {
        let p: Edit = serde_json::from_value(input)?;
        let mut state = self.state()?;
        let current = require(&state, &p.draft_id, p.version)?;
        let mut db = self.db()?;
        let live = db.snapshot()?;
        let proposal = if p.repreview {
            ensure!(
                p.expected_revision == revision(&live)
                    && p.changes.is_empty()
                    && p.resolve_issue_ids.is_empty(),
                "Re-preview using the current saved revision before editing fields."
            );
            repreview(&mut db, &live, current)?
        } else {
            ensure!(
                p.expected_revision == current.revision,
                "Use the current saved revision for this preview."
            );
            require_fresh(current, &live)?;
            compile(
                &mut db,
                &live,
                Some(current),
                p.changes,
                current.undo.clone(),
                current.restores.clone(),
                &p.resolve_issue_ids,
            )?
        };
        let output = view(&proposal, &live, !state.active.is_empty());
        state.current = Some(proposal);
        state.generation += 1;
        Ok(output)
    }

    pub fn apply_draft(&self, input: Value) -> Result<Value> {
        let p = DraftApply::parse(input.clone())?;
        let mut state = self.state()?;
        let mut db = self.db()?;
        if let Some(receipt) = db.draft_receipt(&input)? {
            return Ok(receipt);
        }
        ensure!(
            state.active.is_empty(),
            "Wait for the correction to finish or stop it before Apply."
        );
        let proposal = require(&state, &p.draft_id, p.version)?;
        require_fresh(proposal, &db.snapshot()?)?;
        ensure!(
            p.expected_revision == proposal.revision,
            "Use the current saved revision for this preview."
        );
        ensure!(
            proposal.issues.is_empty(),
            "Resolve the required draft questions before Apply."
        );
        ensure!(
            !proposal.batch.items().is_empty(),
            "There are no planner changes to apply."
        );
        let deleted = proposal
            .batch
            .items()
            .iter()
            .filter(|item| item["action"] == "delete")
            .filter_map(|item| {
                let entity = serde_json::from_value::<Entity>(item["entity"].clone()).ok()?;
                if !matches!(entity, Entity::Task | Entity::Event) {
                    return None;
                }
                let id = item["id"].as_str()?;
                let token = db.capture_restore(entity.name(), id).ok()?;
                Some(((entity, id.to_owned()), (item["before"].clone(), token)))
            })
            .collect::<Vec<_>>();
        let receipt = db.apply_batch(&proposal.batch, input)?;
        state.current = None;
        state.generation += 1;
        state.last_applied_revision = receipt["revision"].as_i64();
        state.deleted.extend(deleted);
        Ok(receipt)
    }

    pub fn dismiss_draft(&self, input: Value) -> Result<()> {
        let p: Identity = serde_json::from_value(input)?;
        let mut state = self.state()?;
        require(&state, &p.draft_id, p.version)?;
        state.current = None;
        state.generation += 1;
        state.active.clear();
        Ok(())
    }

    pub fn reset(&self) -> Result<()> {
        let mut state = self.state()?;
        *state = State {
            generation: state.generation + 1,
            ..State::default()
        };
        Ok(())
    }
}

pub(crate) fn revision(snapshot: &Value) -> i64 {
    snapshot["revision"].as_i64().unwrap_or_default()
}

pub(crate) fn timezone(snapshot: &Value) -> &str {
    snapshot["preferences"]["timezone"]
        .as_str()
        .unwrap_or("UTC")
}

pub(crate) fn record<'a>(snapshot: &'a Value, entity: Entity, id: &str) -> Option<&'a Value> {
    snapshot[entity.table()]
        .as_array()?
        .iter()
        .find(|item| item["id"] == id)
}

fn require<'a>(state: &'a State, id: &str, version: i64) -> Result<&'a Proposal> {
    state
        .current
        .as_ref()
        .filter(|p| p.id == id && p.version == version)
        .ok_or_else(|| anyhow!("That draft version is no longer current. Refresh the preview."))
}

fn require_fresh(proposal: &Proposal, live: &Value) -> Result<()> {
    ensure!(
        proposal.revision == revision(live) && proposal.timezone == timezone(live),
        "Your planner changed. Re-preview this draft before Apply."
    );
    Ok(())
}

fn projected(proposal: &Proposal, live: &Value) -> Value {
    let mut result = proposal.batch.projected_snapshot().clone();
    result["preferences"] = live["preferences"].clone();
    result
}

fn view(proposal: &Proposal, live: &Value, busy: bool) -> Value {
    json!({
        "id":proposal.id,"version":proposal.version,"baseRevision":proposal.revision,
        "timezone":proposal.timezone,"stale":require_fresh(proposal, live).is_err(),"busy":busy,
        "changes":proposal.batch.changes(),"projectedSnapshot":projected(proposal, live),
        "items":proposal.batch.items(),"descriptions":proposal.batch.descriptions(),
        "unresolved":proposal.issues.iter().map(Issue::view).collect::<Vec<_>>(),
    })
}

fn compile(
    db: &mut PlannerDatabase,
    live: &Value,
    old: Option<&Proposal>,
    mut incoming: Vec<Change>,
    undo: Option<UndoToken>,
    restores: Vec<RestoreToken>,
    resolutions: &[String],
) -> Result<Proposal> {
    let snapshot = old.map_or(live, |p| p.batch.projected_snapshot());
    for change in &mut incoming {
        if change.action == Action::Create && change.id.is_none() {
            change.id = Some(uid());
        }
        ensure!(
            change.entity != Entity::Task || change.field("scheduledDate").is_none(),
            "Use explicit event sessions for calendar placement."
        );
        if change.entity == Entity::Event && change.field("completed").is_some() {
            ensure!(
                change.action == Action::Update
                    && change
                        .id
                        .as_deref()
                        .and_then(|id| record(snapshot, Entity::Event, id))
                        .is_some_and(|event| event["linkedTaskId"].is_string()),
                "Standalone events have no completion control."
            );
        }
    }
    let changes = merge(old.map_or(&[], |p| &p.changes), &incoming)?;
    let clock = old.map_or_else(Utc::now, |p| p.clock);
    let batch = db.preview_batch(
        revision(live),
        json!(changes),
        undo.as_ref(),
        &restores,
        Some(clock),
    )?;
    let changes: Vec<Change> = serde_json::from_value(batch.changes().clone())?;
    let mut issues = old.map_or_else(Vec::new, |p| p.issues.clone());
    for id in resolutions {
        let issue = issues
            .iter()
            .find(|issue| issue.id == *id)
            .ok_or_else(|| anyhow!("That clarification no longer exists."))?;
        validate_resolution(issue, &incoming, batch.projected_snapshot())?;
    }
    issues.retain(|issue| {
        !resolutions.contains(&issue.id)
            && (issue.field == "conflict"
                || validate_resolution(issue, &incoming, batch.projected_snapshot()).is_err())
    });
    Ok(Proposal {
        id: old.map_or_else(uid, |p| p.id.clone()),
        version: old.map_or(1, |p| p.version + 1),
        revision: revision(live),
        timezone: timezone(live).into(),
        base: live.clone(),
        clock,
        changes,
        batch,
        undo,
        restores,
        issues,
    })
}

fn merge(previous: &[Change], incoming: &[Change]) -> Result<Vec<Change>> {
    let mut changes = previous.to_vec();
    let mut cancelled = HashSet::new();
    for change in incoming {
        if let Some(index) = changes
            .iter()
            .position(|old| old.entity == change.entity && old.id == change.id)
        {
            let old = &mut changes[index];
            match (old.action, change.action) {
                (Action::Create, Action::Delete) => {
                    if old.entity == Entity::Task {
                        cancelled.extend(old.id.clone());
                    }
                    changes.remove(index);
                }
                (_, Action::Delete) => changes[index] = change.clone(),
                (Action::Delete, _) | (_, Action::Create) => {
                    bail!("That item has conflicting proposed changes.")
                }
                (_, Action::Update) => {
                    old.fields
                        .get_or_insert_default()
                        .extend(change.fields.clone().unwrap_or_default());
                }
            }
        } else {
            changes.push(change.clone());
        }
    }
    for change in &mut changes {
        if let Some(fields) = &mut change.fields {
            if fields
                .get("linkedTaskId")
                .and_then(Value::as_str)
                .is_some_and(|id| cancelled.contains(id))
            {
                fields.insert("linkedTaskId".into(), Value::Null);
                fields.insert("linkedStepId".into(), Value::Null);
            }
            if let Some(dependencies) = fields.get_mut("dependsOnIds").and_then(Value::as_array_mut)
            {
                dependencies.retain(|id| !id.as_str().is_some_and(|id| cancelled.contains(id)));
            }
        }
    }
    changes.sort_by_key(|c| match (c.action, c.entity) {
        (Action::Create, Entity::Category) => 0,
        (Action::Create, Entity::Project) => 1,
        (Action::Create, Entity::Section) => 2,
        (Action::Create, Entity::Task) => 3,
        _ => 4,
    });
    Ok(changes)
}

fn validate_resolution(issue: &Issue, incoming: &[Change], projected: &Value) -> Result<()> {
    ensure!(
        !issue.blocked && issue.field != DELETION_SCOPE,
        "This scope cannot be resolved by acknowledging the issue."
    );
    let entity = issue
        .entity
        .ok_or_else(|| anyhow!("Restate the request to resolve this question."))?;
    let id = issue
        .target_id
        .as_deref()
        .ok_or_else(|| anyhow!("Restate the request to resolve this question."))?;
    let fields = incoming
        .iter()
        .find(|c| c.entity == entity && c.action != Action::Delete && c.id.as_deref() == Some(id))
        .and_then(|c| c.fields.as_ref())
        .ok_or_else(|| {
            anyhow!("Resolve the question with a matching target and field correction.")
        })?;
    let target = record(projected, entity, id)
        .ok_or_else(|| anyhow!("The required target no longer exists."))?;
    let required = match issue.field.as_str() {
        "conflict" => issue
            .conflicting_fields
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        "interval" => vec!["startTime", "endTime"],
        field => vec![field],
    };
    ensure!(
        !required.is_empty() && required.iter().all(|field| fields.contains_key(*field)),
        "Explicitly choose each required field value."
    );
    if issue.field != "conflict" {
        for field in required {
            let value = target[field].as_str().unwrap_or_default();
            let valid = match field {
                "startDate" | "endDate" | "dueDate" => date(value).is_ok(),
                "startTime" | "endTime" => time(value),
                _ => !value.trim().is_empty(),
            };
            ensure!(valid, "Supply a valid value for {field}.");
        }
    }
    Ok(())
}

fn repreview(db: &mut PlannerDatabase, live: &Value, old: &Proposal) -> Result<Proposal> {
    let mut issues = old.issues.clone();
    for change in old.changes.iter().filter(|c| c.action != Action::Create) {
        let Some(id) = &change.id else { continue };
        let before = record(&old.base, change.entity, id);
        let current = record(live, change.entity, id);
        let fields = if let Some(current) = current {
            change
                .fields
                .iter()
                .flatten()
                .filter(|(key, proposed)| {
                    before.is_some_and(|before| before[*key] != current[*key])
                        && **proposed != current[*key]
                })
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if current.is_none() || !fields.is_empty() {
            if let Some(issue) = issues.iter_mut().find(|issue| {
                issue.field == "conflict"
                    && issue.entity == Some(change.entity)
                    && issue.target_id.as_ref() == Some(id)
            }) {
                issue.blocked |= current.is_none();
                issue.conflicting_fields.extend(fields);
                issue.conflicting_fields.sort();
                issue.conflicting_fields.dedup();
            } else {
                let mut issue = Issue::new(
                    "conflict",
                    format!(
                        "A saved {} changed since this proposal. Review the affected fields.",
                        change.entity.name()
                    ),
                    None,
                    Some((change.entity, id.clone())),
                );
                issue.blocked = current.is_none();
                issue.conflicting_fields = fields;
                issues.push(issue);
            }
        }
    }
    let rev = revision(live);
    let (batch, changes) = match db.preview_batch(
        rev,
        json!(old.changes),
        old.undo.as_ref(),
        &old.restores,
        Some(old.clock),
    ) {
        Ok(batch) => {
            let changes = serde_json::from_value(batch.changes().clone())?;
            (batch, changes)
        }
        Err(error) => {
            let question = error.to_string();
            if !issues
                .iter()
                .any(|issue| issue.blocked && issue.question == question)
            {
                let mut issue = Issue::new("conflict", question, None, None);
                issue.blocked = true;
                issues.push(issue);
            }
            (
                db.preview_batch(rev, json!([]), None, &[], Some(old.clock))?,
                old.changes.clone(),
            )
        }
    };
    Ok(Proposal {
        id: old.id.clone(),
        version: old.version + 1,
        revision: rev,
        timezone: timezone(live).into(),
        base: live.clone(),
        clock: old.clock,
        changes,
        batch,
        undo: old.undo.clone(),
        restores: old.restores.clone(),
        issues,
    })
}
