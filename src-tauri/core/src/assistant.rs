//! Local planner assistant. Write intents produce a server-owned draft.
mod intent;
mod model;
mod temporal;

use crate::{
    deletion::{self, Context, Plan, Target, normalize, rx},
    model_runtime::ModelRuntime,
    pending_draft::{
        DELETION_SCOPE, Issue, PendingDraftService, Stage, Turn, record, revision, timezone, uid,
    },
    schema::{Entity, length, validate_request_id},
};
use anyhow::{Result, anyhow, ensure};
use chrono::Utc;
use intent::{Simple, creation_answer, existing_session, read, simple_creation, simple_edit};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChatInput {
    text: String,
    request_id: String,
    selection: Option<Selection>,
    clarification_issue_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    entity: Entity,
    id: String,
    revision: i64,
    entry_type: Option<String>,
    draft_id: Option<String>,
    draft_version: Option<i64>,
}

impl Selection {
    fn resolve<'a>(&self, turn: &Turn<'_>, items: &'a [Target]) -> Option<&'a Target> {
        let valid = match &self.draft_id {
            Some(id) => turn
                .current
                .as_ref()
                .is_some_and(|p| p["id"] == *id && p["version"].as_i64() == self.draft_version),
            None => self.revision == revision(&turn.snapshot),
        };
        if !valid {
            return None;
        }
        let deadline = self.entry_type.as_deref() == Some("deadline");
        let id = if deadline {
            self.id.strip_prefix("deadline:")?
        } else {
            &self.id
        };
        let entity = if deadline { Entity::Task } else { self.entity };
        items
            .iter()
            .find(|item| item.id == id && item.entity == entity)
    }
}

#[derive(Default)]
struct Conversation {
    generation: u64,
    completed: VecDeque<(String, Value)>,
    references: Vec<Target>,
}

pub struct PlannerAssistant {
    drafts: PendingDraftService,
    memory: Mutex<Conversation>,
    request: AsyncMutex<()>,
    now: Arc<dyn Fn() -> chrono::DateTime<Utc> + Send + Sync>,
}

impl PlannerAssistant {
    pub fn new(db: Arc<Mutex<crate::database::PlannerDatabase>>) -> Self {
        Self::with_clock(db, Utc::now)
    }

    pub fn with_clock(
        db: Arc<Mutex<crate::database::PlannerDatabase>>,
        now: impl Fn() -> chrono::DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self {
            drafts: PendingDraftService::new(db),
            memory: Mutex::new(Conversation::default()),
            request: AsyncMutex::new(()),
            now: Arc::new(now),
        }
    }

    pub fn drafts(&self) -> &PendingDraftService {
        &self.drafts
    }

    pub fn reset(&self) -> Result<()> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| anyhow!("Assistant state unavailable."))?;
        self.drafts.reset()?;
        *memory = Conversation {
            generation: memory.generation + 1,
            ..Conversation::default()
        };
        Ok(())
    }

    pub async fn run(
        &self,
        input: Value,
        runtime: Option<&ModelRuntime>,
        token: &CancellationToken,
    ) -> Result<Value> {
        let status = runtime.map(ModelRuntime::status);
        let model = status
            .as_ref()
            .filter(|status| status["state"] == "ready")
            .and_then(|status| status["model"].as_str());
        let options = runtime
            .map(ModelRuntime::model_options)
            .unwrap_or(Value::Null);
        let context = status
            .as_ref()
            .and_then(|status| status["context"].as_u64())
            .unwrap_or(8192);
        self.run_with(input, model, context, token, |mut body| {
            let options = options.clone();
            async move {
                if let Some(options) = options.as_object() {
                    body["options"]
                        .as_object_mut()
                        .unwrap()
                        .extend(options.clone());
                }
                runtime
                    .ok_or_else(|| anyhow!("The local model is unavailable."))?
                    .chat(body, token, Duration::from_secs(45), |_| {})
                    .await
            }
        })
        .await
    }

    /// Adapter for an Ollama-compatible inference provider. The callback sees
    /// the compact, schema-constrained request and returns its chat response.
    pub async fn run_with<F, Fut>(
        &self,
        input: Value,
        model: Option<&str>,
        context: u64,
        token: &CancellationToken,
        infer: F,
    ) -> Result<Value>
    where
        F: Fn(Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        let input: ChatInput = serde_json::from_value(input)?;
        validate_request_id(&input.request_id)?;
        ensure!(
            (1..=32_000).contains(&length(input.text.trim())),
            "Enter a request of up to 32,000 characters."
        );
        let _request = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(anyhow!("Request stopped. No changes saved.")),
            request = self.request.lock() => request,
        };
        let (generation, references, turn) = {
            let memory = self
                .memory
                .lock()
                .map_err(|_| anyhow!("Assistant state unavailable."))?;
            if let Some((_, result)) = memory
                .completed
                .iter()
                .find(|(id, _)| id == &input.request_id)
            {
                return Ok(result.clone());
            }
            (
                memory.generation,
                memory.references.clone(),
                self.drafts.begin()?,
            )
        };
        let (result, next_references) = self
            .respond(&input, &turn, &references, model, context, token, infer)
            .await?;
        drop(turn);
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| anyhow!("Assistant state unavailable."))?;
        if generation != memory.generation {
            return Ok(json!({"content":"This proposal was dismissed.","disposition":"dismissed"}));
        }
        if let Some(references) = next_references {
            memory.references = references;
        }
        memory
            .completed
            .push_back((input.request_id, result.clone()));
        if memory.completed.len() > 128 {
            memory.completed.pop_front();
        }
        Ok(result)
    }

    async fn respond<F, Fut>(
        &self,
        input: &ChatInput,
        turn: &Turn<'_>,
        refs: &[Target],
        model: Option<&str>,
        model_context: u64,
        token: &CancellationToken,
        infer: F,
    ) -> Result<(Value, Option<Vec<Target>>)>
    where
        F: Fn(Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        let text = input.text.trim();
        let snapshot = &turn.snapshot;
        let zone = timezone(snapshot)
            .parse::<chrono_tz::Tz>()
            .unwrap_or(chrono_tz::UTC);
        let today = (self.now)().with_timezone(&zone).date_naive();
        let items = deletion::targets(snapshot);
        let selected = input
            .selection
            .as_ref()
            .and_then(|selection| selection.resolve(turn, &items));
        let selection_unavailable = input.selection.is_some() && selected.is_none();
        if let Some(id) = &input.clarification_issue_id {
            ensure!(
                turn.issues.iter().any(|issue| issue.id() == id),
                "That request clarification is no longer pending."
            );
        }
        if deletion::explicit(text) {
            let context = Context {
                snapshot,
                items: &items,
                today,
                selected,
                references: refs,
                selection_unavailable,
            };
            let mut resolve_deletion = false;
            let issue = turn
                .issues
                .iter()
                .find(|issue| issue.field == DELETION_SCOPE);
            let mut plan = deletion::plan(text, &context, None);
            if plan.is_err()
                && let Some(model) = model
            {
                if let Some(confirmed) =
                    model::resolve_deletion(text, &context, model, model_context, token, &infer)
                        .await?
                {
                    plan = Ok(confirmed);
                }
            }
            if let Some(issue) = issue
                && plan.is_ok()
            {
                if deletion::replacement(text) {
                    resolve_deletion = true;
                } else if let Some(selected) = selected
                    && deletion::selected_pointer(text)
                    && let Some(source) = &issue.source
                    && let Ok(clarified) = deletion::plan(source, &context, None)
                    && clarified.companions.is_empty()
                    && clarified.changes.iter().any(|c| {
                        c.entity == selected.entity && c.id.as_deref() == Some(&selected.id)
                    })
                {
                    plan = Ok(clarified);
                    resolve_deletion = true;
                }
            }
            match plan {
                Ok(Plan {
                    mut changes,
                    companions,
                    explain,
                }) => {
                    for clause in companions {
                        if let Some(Simple::Changes(mut create)) = simple_creation(&clause, today) {
                            changes.append(&mut create);
                        } else {
                            return self.block_deletion(turn, text, "I need more specific details for the accompanying changes. Please restate the complete request.", token);
                        }
                    }
                    if changes.is_empty() {
                        return Ok((
                            reply("I’ll keep those planner items. No changes saved."),
                            None,
                        ));
                    }
                    let referenced = changes
                        .iter()
                        .filter_map(|change| {
                            items
                                .iter()
                                .find(|item| {
                                    item.entity == change.entity
                                        && change.id.as_deref() == Some(&item.id)
                                })
                                .cloned()
                        })
                        .collect();
                    let draft = self.publish(
                        turn,
                        Stage {
                            changes,
                            resolve_deletion,
                            ..Stage::default()
                        },
                        token,
                    )?;
                    let message = if explain {
                        "Review the exact items below. Removing a task leaves its calendar sessions independent unless you also asked to remove them. Apply to save."
                    } else {
                        "Review the proposed changes and Apply to save."
                    };
                    return Ok((preview(draft, message), Some(referenced)));
                }
                Err(error) => return self.block_deletion(turn, text, &error.to_string(), token),
            }
        }

        if rx!(r"(?i)^(?:please\s+)?undo(?: (?:that|the last change|the last batch|my last change))?[.!]?$").is_match(text) {
            return match self.publish(turn, Stage { undo: true, ..Stage::default() }, token) {
                Ok(draft) => Ok((preview(draft, "Review the proposed Undo and Apply to save."), None)),
                Err(error) if !token.is_cancelled() => Ok((reply(format!("{error} No changes saved.")), None)),
                Err(error) => Err(error),
            };
        }
        if let Some(c) =
            rx!(r"(?i)^(?:please\s+)?(?:restore|bring back)\s+(.+?)[.!]?$").captures(text)
        {
            let name = normalize(&c[1]);
            let targets = self
                .drafts
                .deleted_targets()?
                .into_iter()
                .filter(|(entity, id, title)| {
                    record(snapshot, *entity, id).is_none()
                        && (name == normalize(title)
                            || matches!(name.as_str(), "it" | "that" | "that task" | "that event")
                                && refs.iter().any(|r| r.entity == *entity && r.id == *id))
                })
                .collect::<Vec<_>>();
            if let [(entity, id, _)] = targets.as_slice() {
                let draft = self.publish(
                    turn,
                    Stage {
                        restore: Some((*entity, id.clone())),
                        ..Stage::default()
                    },
                    token,
                )?;
                return Ok((
                    preview(draft, "Review the proposed restoration and Apply to save."),
                    None,
                ));
            }
            return Ok((
                reply("Which removed planner item should I restore? No changes saved."),
                None,
            ));
        }

        if let Some((reply, references)) =
            read(text, snapshot, &items, today, turn.current.is_some())
        {
            return Ok((reply, Some(references)));
        }
        if let Some(changes) = creation_answer(input, turn, today) {
            let draft = self.publish(
                turn,
                Stage {
                    changes,
                    ..Stage::default()
                },
                token,
            )?;
            return Ok((
                preview(draft, "Review the proposed event and Apply to save."),
                None,
            ));
        }
        if let Some(changes) = intent::linked_creation(text) {
            let draft = self.publish(
                turn,
                Stage {
                    changes,
                    ..Stage::default()
                },
                token,
            )?;
            return Ok((
                preview(
                    draft,
                    "Review the task and linked sessions, then Apply to save.",
                ),
                None,
            ));
        }
        if let Some(work) = intent::existing_work(text, &items, selected, today) {
            return match work {
                Ok(changes) => {
                    let draft = self.publish(
                        turn,
                        Stage {
                            changes,
                            ..Stage::default()
                        },
                        token,
                    )?;
                    Ok((
                        preview(draft, "Review the proposed changes and Apply to save."),
                        None,
                    ))
                }
                Err(question) => Ok((reply(question), None)),
            };
        }
        match simple_creation(text, today) {
            Some(Simple::Changes(changes)) => {
                let changes = if rx!(
                    r"(?i)^(?:(?:please|also)\s+)*(?:(?:can|could|would) you\s+)?schedule\b"
                )
                .is_match(text)
                {
                    match existing_session(changes, &items, selected) {
                        Ok(changes) => changes,
                        Err(question) => return Ok((reply(question), None)),
                    }
                } else {
                    changes
                };
                let draft = self.publish(
                    turn,
                    Stage {
                        changes,
                        ..Stage::default()
                    },
                    token,
                )?;
                return Ok((
                    preview(draft, "Review the proposed changes and Apply to save."),
                    None,
                ));
            }
            Some(Simple::MissingDate(title)) => return self.missing_event(turn, title, token),
            None => {}
        }
        if let Some(c) = rx!(r"(?i)^(?:please\s+)?(?:add|create|schedule)\s+(?:a |an |the )?(?:planned )?(?:calendar )?event\s+(?:called|named|titled)\s+(.+?)[,.;]\s*(?:but\s+)?i (?:have not|haven['’]t) (?:picked|decided|chosen)\b.*\bdate\b").captures(text) {
            return self.missing_event(turn, c[1].trim_matches([' ', '"', '“', '”']).to_owned(), token);
        }
        if let Some(changes) = intent::actual_activity(text, snapshot) {
            if changes.is_empty() {
                return Ok((reply("Those activities are already recorded."), None));
            }
            let draft = self.publish(
                turn,
                Stage {
                    changes,
                    ..Stage::default()
                },
                token,
            )?;
            return Ok((
                preview(draft, "Review the recorded activities and Apply to save."),
                None,
            ));
        }
        if let Some(changes) = simple_edit(text, snapshot, &items, selected, today) {
            let draft = self.publish(
                turn,
                Stage {
                    changes,
                    ..Stage::default()
                },
                token,
            )?;
            return Ok((
                preview(draft, "Review the proposed changes and Apply to save."),
                None,
            ));
        }
        let (allow_create, allow_update) = model::authorized(text);
        if !allow_create && !allow_update {
            return Ok((
                reply("Tell me what you’d like to add, change, or look up in your planner."),
                None,
            ));
        }
        if let Some(model) = model
            && let Some(changes) = model::structured(
                text,
                &items,
                snapshot,
                selected,
                today,
                model,
                model_context,
                token,
                &infer,
            )
            .await?
        {
            return match self.publish(
                turn,
                Stage {
                    changes,
                    ..Stage::default()
                },
                token,
            ) {
                Ok(draft) => Ok((
                    preview(draft, "Review the proposed changes and Apply to save."),
                    None,
                )),
                Err(_) if !token.is_cancelled() => Ok((
                    reply(
                        "I couldn't prepare the full proposal. Please restate the items and dates. No changes saved.",
                    ),
                    None,
                )),
                Err(error) => Err(error),
            };
        }
        Ok((
            reply(
                "Could you give me the exact planner item and details you want to change? No changes saved.",
            ),
            None,
        ))
    }

    fn publish(&self, turn: &Turn<'_>, stage: Stage, token: &CancellationToken) -> Result<Value> {
        ensure!(!token.is_cancelled(), "Request stopped. No changes saved.");
        self.drafts.stage(turn, stage)
    }

    fn block_deletion(
        &self,
        turn: &Turn<'_>,
        text: &str,
        question: &str,
        token: &CancellationToken,
    ) -> Result<(Value, Option<Vec<Target>>)> {
        if turn.current.is_some() && !turn.issues.iter().any(|i| i.field == DELETION_SCOPE) {
            let question = format!(
                "{question} Select the matching card and repeat the deletion, or start a replacement with “Instead, delete…”."
            );
            self.publish(
                turn,
                Stage {
                    issue: Some(Issue::new(
                        DELETION_SCOPE,
                        question,
                        Some(text.into()),
                        None,
                    )),
                    ..Stage::default()
                },
                token,
            )?;
        }
        Ok((reply(format!("{question} No changes saved.")), None))
    }

    fn missing_event(
        &self,
        turn: &Turn<'_>,
        title: String,
        token: &CancellationToken,
    ) -> Result<(Value, Option<Vec<Target>>)> {
        let message = format!("What date should I use for “{title}”?");
        let issue = Issue::new(
            "startDate",
            message.clone(),
            Some(title),
            Some((Entity::Event, uid())),
        );
        let draft = self.publish(
            turn,
            Stage {
                issue: Some(issue),
                ..Stage::default()
            },
            token,
        )?;
        Ok((preview(draft, &message), None))
    }
}

fn reply(content: impl Into<String>) -> Value {
    json!({"content":content.into(),"contextTrimmed":false})
}

fn preview(draft: Value, content: &str) -> Value {
    json!({"content":content,"contextTrimmed":false,"preview":{"saved":false,"draft":draft}})
}
