mod changes;
mod storage;

use crate::{
    categories,
    schema::{
        Action, Change, DraftApply, Entity, Mutation, validate_changes, validate_preferences,
    },
};
use anyhow::{Result, anyhow, ensure};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
struct SavedState {
    events: Vec<Value>,
    tasks: Vec<Value>,
    projects: Vec<Value>,
    sections: Vec<Value>,
    #[serde(default)]
    categories: Vec<Value>,
}

impl SavedState {
    fn records(&self, entity: Entity) -> &[Value] {
        match entity {
            Entity::Event => &self.events,
            Entity::Task => &self.tasks,
            Entity::Project => &self.projects,
            Entity::Section => &self.sections,
            Entity::Category => &self.categories,
        }
    }
}

struct History {
    id: i64,
    label: String,
    state: SavedState,
}

#[derive(Clone)]
pub struct UndoToken {
    database: Uuid,
    head: i64,
    revision: i64,
    state: SavedState,
    label: String,
}

#[derive(Clone)]
pub struct RestoreToken {
    database: Uuid,
    entity: Entity,
    record: Value,
}

/// A server-owned preview. Clients receive a projection and cannot supply its saved state to Apply.
pub struct CompiledBatch {
    database: Uuid,
    revision: i64,
    undo: Option<UndoToken>,
    state: SavedState,
    changes: Value,
    projected_snapshot: Value,
    descriptions: Vec<String>,
    items: Vec<Value>,
}

impl CompiledBatch {
    pub fn changes(&self) -> &Value {
        &self.changes
    }
    pub fn projected_snapshot(&self) -> &Value {
        &self.projected_snapshot
    }
    pub fn descriptions(&self) -> &[String] {
        &self.descriptions
    }
    pub fn items(&self) -> &[Value] {
        &self.items
    }
}

pub struct PlannerDatabase {
    connection: Connection,
    identity: Uuid,
    now: Box<dyn Fn() -> DateTime<Utc> + Send>,
}

impl PlannerDatabase {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_clock(path, Utc::now)
    }

    pub fn open_with_clock(
        path: &Path,
        now: impl Fn() -> DateTime<Utc> + Send + 'static,
    ) -> Result<Self> {
        let database = Self {
            connection: storage::connect(path)?,
            identity: Uuid::new_v4(),
            now: Box::new(now),
        };
        database.migrate(path)?;
        Ok(database)
    }

    pub fn revision(&self) -> Result<i64> {
        Ok(self.meta("revision")?.parse()?)
    }

    pub fn snapshot(&self) -> Result<Value> {
        if self.connection.is_autocommit() {
            self.transaction(TransactionBehavior::Deferred, true, || {
                self.snapshot_inner()
            })
        } else {
            self.snapshot_inner()
        }
    }

    fn snapshot_inner(&self) -> Result<Value> {
        let mut snapshot = serde_json::to_value(self.saved_state()?)?;
        snapshot["revision"] = self.revision()?.into();
        let stored: Value = serde_json::from_str(&self.meta("preferences")?)?;
        let mut preferences = json!({"appearance":"light"});
        if let Some(stored) = stored.as_object() {
            preferences.as_object_mut().unwrap().extend(stored.clone());
        }
        snapshot["preferences"] = preferences;
        snapshot["canUndo"] = self.history_head()?.is_some().into();
        Ok(snapshot)
    }

    pub fn preferences(&self, input: Value) -> Result<()> {
        let changes = validate_preferences(input)?;
        self.transaction(TransactionBehavior::Immediate, true, || {
            let mut previous: Value = serde_json::from_str(&self.meta("preferences")?)?;
            previous
                .as_object_mut()
                .ok_or_else(|| anyhow!("Invalid stored planner preferences."))?
                .extend(changes);
            self.set_meta("preferences", &previous.to_string())
        })
    }

    pub fn receipt(&self, request_id: &str) -> Result<Option<Value>> {
        let body: Option<String> = self
            .connection
            .query_row(
                "SELECT receipt FROM requests WHERE id=?",
                [request_id],
                |row| row.get(0),
            )
            .optional()?;
        body.map(|body| Ok(serde_json::from_str(&body)?))
            .transpose()
    }

    pub fn mutate(&mut self, input: Value) -> Result<Value> {
        let input = Mutation::parse(input)?;
        self.transaction(TransactionBehavior::Immediate, true, || {
            if let Some(existing) = self.receipt(&input.request_id)? { return Ok(existing); }
            let revision = self.revision()?;
            ensure!(input.expected_revision == revision, "Your planner changed. Please try again with the latest entries.");

            let before = self.saved_state()?;
            let result = self.apply_changes(categories::categorize(&before.categories, input.changes)?, None)?;
            let items = result.changes.iter().map(|change| {
                let id = change.id.as_deref().unwrap();
                let title = if change.action == Action::Delete {
                    before.records(change.entity).iter().find(|item| item["id"] == id)
                        .and_then(|item| item["title"].as_str()).unwrap_or("Item").to_owned()
                } else {
                    self.get(change.entity, id)?["title"].as_str().unwrap_or("Item").to_owned()
                };
                Ok(json!({"id":id,"entity":change.entity,"action":change.action,"title":title}))
            }).collect::<Result<Vec<_>>>()?;
            let receipt = json!({"label":input.label,"descriptions":result.descriptions,"revision":revision + 1,"items":items});
            self.store_change(&before, &receipt, &input.request_id)?;
            Ok(receipt)
        })
    }

    pub fn clear_tasks_and_events(&mut self, request_id: &str) -> Result<Option<Value>> {
        if let Some(existing) = self.receipt(request_id)? {
            return Ok(Some(existing));
        }
        let snapshot = self.snapshot()?;
        let mut changes = Vec::new();
        for entity in [Entity::Event, Entity::Task] {
            for item in snapshot[entity.table()].as_array().unwrap() {
                let id = item["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid saved {} ID.", entity.name()))?;
                changes.push(Change::new(Action::Delete, entity, id.into(), None));
            }
        }
        if changes.is_empty() {
            return Ok(None);
        }
        self.mutate(json!({
            "changes":changes,"label":"Clear all tasks and events",
            "expectedRevision":snapshot["revision"],"requestId":request_id,
        }))
        .map(Some)
    }

    pub fn undo(
        &mut self,
        expected_revision: Option<i64>,
        request_id: Option<&str>,
    ) -> Result<Value> {
        self.transaction(TransactionBehavior::Immediate, true, || {
            let request_id = request_id.filter(|id| !id.is_empty());
            if let Some(request_id) = request_id
                && let Some(existing) = self.receipt(request_id)?
            {
                return Ok(existing);
            }
            let revision = self.revision()?;
            ensure!(
                expected_revision.is_none_or(|expected| expected == revision),
                "A later change exists. Use the current Undo control."
            );
            let history = self.latest_history()?;
            self.replace_state(&history.state)?;
            self.connection
                .execute("DELETE FROM history WHERE id=?", [history.id])?;
            self.set_meta("revision", &(revision + 1).to_string())?;
            let receipt = json!({
                "label":format!("Undid {}",history.label),
                "descriptions":[format!("Restored the planner before {}",history.label)],
                "revision":revision + 1,
            });
            if let Some(request_id) = request_id {
                self.store_receipt(request_id, &receipt)?;
            }
            Ok(receipt)
        })
    }

    pub fn capture_undo(&self, expected_revision: i64) -> Result<UndoToken> {
        self.transaction(TransactionBehavior::Deferred, true, || {
            ensure!(self.revision()? == expected_revision,
                "A later change exists. Re-preview the original Undo; it cannot target a different batch.");
            let history = self.latest_history()?;
            Ok(UndoToken {
                database: self.identity, head: history.id, revision: expected_revision,
                state: history.state, label: history.label,
            })
        })
    }

    pub fn capture_restore(&self, entity: &str, id: &str) -> Result<RestoreToken> {
        let entity = match entity {
            "task" => Entity::Task,
            "event" => Entity::Event,
            _ => return Err(anyhow!("Only tasks and events can be restored.")),
        };
        Ok(RestoreToken {
            database: self.identity,
            entity,
            record: self.get(entity, id)?,
        })
    }

    pub fn preview(&mut self, changes: Value, expected_revision: i64) -> Result<Value> {
        let input = Mutation::parse(
            json!({"changes":changes,"expectedRevision":expected_revision,"label":"Preview","requestId":"preview"}),
        )?;
        self.transaction(TransactionBehavior::Deferred, false, || {
            ensure!(self.revision()? == expected_revision,
                "Your planner changed while the assistant was working. Please send the request again.");
            let result = self.apply_changes(categories::categorize(&self.rows(Entity::Category)?, input.changes)?, None)?;
            Ok(json!({"descriptions":result.descriptions,"changes":result.changes}))
        })
    }

    pub fn preview_batch(
        &mut self,
        expected_revision: i64,
        changes: Value,
        undo: Option<&UndoToken>,
        restores: &[RestoreToken],
        clock: Option<DateTime<Utc>>,
    ) -> Result<CompiledBatch> {
        let changes: Vec<Change> = serde_json::from_value(changes)?;
        validate_changes(&changes, true)?;
        self.transaction(TransactionBehavior::Deferred, false, || {
            ensure!(self.revision()? == expected_revision, "Your planner changed. Re-preview this draft before Apply.");
            if let Some(undo) = undo { self.validate_undo(undo)?; }
            let before = self.saved_state()?;
            if let Some(undo) = undo { self.replace_state(&undo.state)?; }
            for restore in restores {
                ensure!(restore.database == self.identity, "Untrusted restoration.");
                self.put(restore.entity, restore.record.clone())?;
            }
            let clock = clock.unwrap_or_else(|| (self.now)());
            let result = self.apply_changes(categories::categorize(&self.rows(Entity::Category)?, changes)?, Some(clock))?;
            let state = self.saved_state()?;
            let mut items = diff(&before, &state, undo.is_some() || !restores.is_empty());
            let mut descriptions = result.descriptions;
            if let Some(undo) = undo {
                items.insert(0, json!({"id":format!("undo:{}",undo.head),"entity":"project","action":"undo","title":format!("Undo {}",undo.label)}));
                descriptions.insert(0, format!("Proposed Undo: {}", undo.label));
            }
            Ok(CompiledBatch {
                database: self.identity, revision: expected_revision, undo: undo.cloned(), state,
                changes: serde_json::to_value(result.changes)?, projected_snapshot: self.snapshot_inner()?, descriptions, items,
            })
        })
    }

    pub fn draft_receipt(&self, input: &Value) -> Result<Option<Value>> {
        let id = input["draftId"]
            .as_str()
            .ok_or_else(|| anyhow!("Invalid draft ID."))?;
        let version = input["version"]
            .as_i64()
            .ok_or_else(|| anyhow!("Invalid draft version."))?;
        let revision = input["expectedRevision"]
            .as_i64()
            .ok_or_else(|| anyhow!("Invalid planner revision."))?;
        self.lookup_draft_receipt(&format!("draft:{id}:{version}"), revision)
    }

    pub fn apply_batch(&mut self, batch: &CompiledBatch, input: Value) -> Result<Value> {
        let input = DraftApply::parse(input)?;
        let key = format!("draft:{}:{}", input.draft_id, input.version);
        self.transaction(TransactionBehavior::Immediate, true, || {
            if let Some(existing) = self.lookup_draft_receipt(&key, input.expected_revision)? { return Ok(existing); }
            ensure!(batch.database == self.identity, "Untrusted draft state.");
            ensure!(batch.revision == input.expected_revision && self.revision()? == input.expected_revision,
                "Your planner changed. Re-preview this draft before Apply.");
            if let Some(undo) = &batch.undo { self.validate_undo(undo)?; }

            let before = self.saved_state()?;
            self.replace_state(&batch.state)?;
            let items = batch.items.iter().filter(|item| item["action"] != "undo").map(|item| {
                let action = if item["action"] == "restore" { "create".into() } else { item["action"].clone() };
                json!({"id":item["id"],"entity":item["entity"],"action":action,"title":item["title"]})
            }).collect::<Vec<_>>();
            let label = if batch.undo.is_some() { "Assistant Undo and changes" } else { "Assistant changes" };
            let receipt = json!({
                "label":label,"revision":input.expected_revision + 1,"descriptions":batch.descriptions,"items":items,
                "draft":{"id":input.draft_id,"version":input.version,"baseRevision":input.expected_revision},
            });
            self.store_change(&before, &receipt, &key)?;
            Ok(receipt)
        })
    }

    pub fn organize_preview(&mut self) -> Result<Value> {
        let snapshot = self.snapshot()?;
        let revision = snapshot["revision"].as_i64().unwrap();
        let mut changes = Vec::new();
        for entity in [Entity::Task, Entity::Event] {
            for item in snapshot[entity.table()]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["categoryId"].is_null())
            {
                let title = item["title"].as_str().unwrap_or_default();
                changes.push(json!({"action":"update","entity":entity,"id":item["id"],
                    "fields":{"categoryTitle":categories::infer(title, entity),"colorOverride":null}}));
            }
        }
        if changes.is_empty() {
            return Ok(json!({"changes":[],"descriptions":[],"revision":revision}));
        }
        let mut result = self.preview(Value::Array(changes), revision)?;
        result["revision"] = revision.into();
        Ok(result)
    }

    fn history_head(&self) -> Result<Option<i64>> {
        Ok(self
            .connection
            .query_row(
                "SELECT id FROM history ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn latest_history(&self) -> Result<History> {
        let row: Option<(i64, String, String)> = self
            .connection
            .query_row(
                "SELECT id,label,before_state FROM history ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (id, label, body) = row.ok_or_else(|| anyhow!("There are no changes to undo."))?;
        Ok(History {
            id,
            label,
            state: serde_json::from_str(&body)?,
        })
    }

    fn validate_undo(&self, token: &UndoToken) -> Result<()> {
        ensure!(
            token.database == self.identity
                && self.revision()? == token.revision
                && self.history_head()? == Some(token.head),
            "The original Undo is no longer the latest batch. Dismiss this proposal; Undo cannot be retargeted."
        );
        Ok(())
    }

    fn lookup_draft_receipt(&self, key: &str, expected_revision: i64) -> Result<Option<Value>> {
        let receipt = self.receipt(key)?;
        if let Some(receipt) = &receipt {
            ensure!(
                receipt["draft"]["baseRevision"] == expected_revision,
                "That Apply retry does not match the accepted draft revision."
            );
        }
        Ok(receipt)
    }

    fn store_receipt(&self, request_id: &str, receipt: &Value) -> Result<()> {
        self.connection.execute(
            "INSERT INTO requests VALUES (?,?)",
            params![request_id, receipt.to_string()],
        )?;
        Ok(())
    }

    fn store_change(&self, before: &SavedState, receipt: &Value, request_id: &str) -> Result<()> {
        self.set_meta("revision", &receipt["revision"].to_string())?;
        self.connection.execute(
            "INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)",
            params![
                receipt["label"].as_str(),
                serde_json::to_string(before)?,
                receipt["descriptions"].to_string()
            ],
        )?;
        self.connection.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)", [])?;
        self.store_receipt(request_id, receipt)
    }
}

fn diff(before: &SavedState, after: &SavedState, restoring: bool) -> Vec<Value> {
    let mut items = Vec::new();
    for entity in Entity::ALL {
        let previous = before.records(entity);
        let next = after.records(entity);
        let mut visited = HashSet::new();
        for id in previous
            .iter()
            .chain(next)
            .filter_map(|item| item["id"].as_str())
        {
            if !visited.insert(id) {
                continue;
            }
            let a = previous.iter().find(|item| item["id"] == id);
            let b = next.iter().find(|item| item["id"] == id);
            if a == b {
                continue;
            }
            let title = b
                .or(a)
                .and_then(|item| item["title"].as_str())
                .unwrap_or("Item");
            let action = match (a, b) {
                (_, None) => "delete",
                (None, _) if restoring => "restore",
                (None, _) => "create",
                _ => "update",
            };
            let mut item = json!({"entity":entity,"id":id,"title":title,"action":action});
            if let Some(a) = a {
                item["before"] = a.clone();
            }
            if let Some(b) = b {
                item["after"] = b.clone();
            }
            items.push(item);
        }
    }
    items
}

#[cfg(test)]
mod tests;
