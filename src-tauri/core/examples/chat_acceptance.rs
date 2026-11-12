use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use mymind_core::{assistant::PlannerAssistant, database::PlannerDatabase};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
struct Trial {
    seed: Vec<Value>,
    text: String,
    followup: Option<String>,
    clock: String,
    model: String,
    context: u64,
}

fn read<T: serde::de::DeserializeOwned>() -> Result<T> {
    let mut line = String::new();
    ensure!(
        io::stdin().read_line(&mut line)? > 0,
        "Acceptance driver disconnected."
    );
    Ok(serde_json::from_str(&line)?)
}

fn write(payload: Value) -> Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "{payload}")?;
    output.flush()?;
    Ok(())
}

fn infer(body: Value) -> Result<Value> {
    write(json!({"inference":body}))?;
    let response: Value = read()?;
    if let Some(error) = response["error"].as_str() {
        anyhow::bail!("{error}");
    }
    response
        .get("response")
        .cloned()
        .context("Missing model response.")
}

fn records(snapshot: &Value) -> Value {
    json!({
        "tasks":snapshot["tasks"],"events":snapshot["events"],"projects":snapshot["projects"],
        "sections":snapshot["sections"],"categories":snapshot["categories"]
    })
}

async fn run(trial: Trial) -> Result<Value> {
    let clock = DateTime::parse_from_rfc3339(&trial.clock)?.with_timezone(&Utc);
    let db = Arc::new(Mutex::new(PlannerDatabase::open_with_clock(
        std::path::Path::new(":memory:"),
        move || clock,
    )?));
    if !trial.seed.is_empty() {
        db.lock().unwrap().mutate(json!({
            "changes":trial.seed,"label":"Acceptance fixture","expectedRevision":0,"requestId":"fixture"
        }))?;
    }
    let before = db.lock().unwrap().snapshot()?;
    let assistant = PlannerAssistant::with_clock(db.clone(), move || clock);
    let token = CancellationToken::new();
    let first = assistant
        .run_with(
            json!({"text":trial.text,"requestId":"chat"}),
            Some(&trial.model),
            trial.context,
            &token,
            |body| async { infer(body) },
        )
        .await?;
    ensure!(
        before == db.lock().unwrap().snapshot()?,
        "Planner changed before Apply."
    );
    let mut response = first.clone();
    if let Some(text) = trial.followup {
        let blocked = assistant
            .drafts()
            .get_draft()?
            .context("First turn did not stage its required question.")?;
        ensure!(
            blocked["unresolved"]
                .as_array()
                .is_some_and(|issues| issues.iter().any(|issue| issue["required"] == true)),
            "First turn did not block Apply."
        );
        ensure!(assistant.drafts().apply_draft(json!({
            "draftId":blocked["id"],"version":blocked["version"],"expectedRevision":blocked["baseRevision"],
            "requestId":"blocked"
        })).is_err(), "An unresolved draft was applied.");
        response = assistant
            .run_with(
                json!({"text":text,"requestId":"followup"}),
                Some(&trial.model),
                trial.context,
                &token,
                |body| async { infer(body) },
            )
            .await?;
        ensure!(
            before == db.lock().unwrap().snapshot()?,
            "Follow-up changed planner before Apply."
        );
    }
    let draft = assistant.drafts().get_draft()?;
    if let Some(draft) = &draft
        && draft["unresolved"].as_array().is_some_and(Vec::is_empty)
    {
        let input = json!({
            "draftId":draft["id"],"version":draft["version"],"expectedRevision":draft["baseRevision"],"requestId":"apply"
        });
        let receipt = assistant.drafts().apply_draft(input.clone())?;
        ensure!(
            assistant.drafts().apply_draft(input)? == receipt,
            "Retry did not reuse the receipt."
        );
        let mut db = db.lock().unwrap();
        let snapshot = db.snapshot()?;
        ensure!(
            records(&snapshot) == records(&draft["projectedSnapshot"]),
            "Apply saved different records from its preview."
        );
        let revision = db.revision()?;
        db.undo(Some(revision), Some("undo"))?;
        ensure!(
            records(&db.snapshot()?) == records(&before),
            "Undo did not restore the original records."
        );
    }
    Ok(json!({"response":response,"draft":draft,"before":before}))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let trial: Trial = read()?;
    let payload = match run(trial).await {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":format!("{error:#}")}),
    };
    write(payload)
}
