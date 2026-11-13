//! Local planner assistant. Model-intent turns produce a server-owned draft;
//! every user-facing word comes from the model, never from built-in replies.
mod ai;
mod intent;
mod model;
mod temporal;

use crate::{
    deletion::{Target, targets},
    model_runtime::ModelRuntime,
    pending_draft::{PendingDraftService, Stage, Turn, revision, timezone},
    schema::{Entity, length, validate_request_id},
};
use anyhow::{Result, anyhow, bail, ensure};
use chrono::Utc;
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

struct Completed {
    request_id: String,
    user: String,
    content: String,
    result: Value,
}

#[derive(Default)]
struct Conversation {
    generation: u64,
    completed: VecDeque<Completed>,
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
            if let Some(completed) = memory
                .completed
                .iter()
                .find(|completed| completed.request_id == input.request_id)
            {
                return Ok(completed.result.clone());
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
        memory.completed.push_back(Completed {
            request_id: input.request_id,
            user: input.text.trim().chars().take(600).collect(),
            content: result["content"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect(),
            result: result.clone(),
        });
        if memory.completed.len() > 128 {
            memory.completed.pop_front();
        }
        Ok(result)
    }

    async fn respond<F, Fut>(
        &self,
        input: &ChatInput,
        turn: &Turn<'_>,
        _refs: &[Target],
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
        let items = targets(snapshot);
        let selected = input
            .selection
            .as_ref()
            .and_then(|selection| selection.resolve(turn, &items));
        if let Some(id) = &input.clarification_issue_id {
            ensure!(
                turn.issues.iter().any(|issue| issue.id() == id),
                "That request clarification is no longer pending."
            );
        }
        let Some(model) = model else {
            bail!("The assistant model is not ready. Start Ollama or pick a model in Settings.");
        };
        let deleted = self.drafts.deleted_targets()?;
        let history: Vec<(String, String)> = {
            let memory = self
                .memory
                .lock()
                .map_err(|_| anyhow!("Assistant state unavailable."))?;
            memory
                .completed
                .iter()
                .rev()
                .take(10)
                .map(|completed| (completed.user.clone(), completed.content.clone()))
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        };
        let outcome = ai::decide(
            text,
            snapshot,
            &items,
            selected,
            &deleted,
            today,
            &history,
            model,
            model_context,
            token,
            &infer,
        )
        .await?;
        match outcome {
            ai::Outcome::Message(message) => Ok((message_result(message), None)),
            ai::Outcome::Undo { message } => {
                let draft = self.publish(
                    turn,
                    Stage {
                        undo: true,
                        ..Stage::default()
                    },
                    token,
                )?;
                Ok((preview_result(draft, &message), None))
            }
            ai::Outcome::Restore { entity, id, message } => {
                let draft = self.publish(
                    turn,
                    Stage {
                        restore: Some((entity, id)),
                        ..Stage::default()
                    },
                    token,
                )?;
                Ok((preview_result(draft, &message), None))
            }
            ai::Outcome::Changes { changes, message } => {
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
                    .collect::<Vec<_>>();
                let draft = self.publish(
                    turn,
                    Stage {
                        changes,
                        ..Stage::default()
                    },
                    token,
                )?;
                Ok((preview_result(draft, &message), Some(referenced)))
            }
        }
    }

    fn publish(&self, turn: &Turn<'_>, stage: Stage, token: &CancellationToken) -> Result<Value> {
        ensure!(!token.is_cancelled(), "Request stopped. No changes saved.");
        self.drafts.stage(turn, stage)
    }
}

fn message_result(content: String) -> Value {
    json!({"content":content,"contextTrimmed":false})
}

fn preview_result(draft: Value, content: &str) -> Value {
    json!({"content":content,"contextTrimmed":false,"preview":{"saved":false,"draft":draft}})
}
