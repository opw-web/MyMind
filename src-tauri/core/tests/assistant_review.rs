use anyhow::Result;
use mymind_core::{assistant::PlannerAssistant, database::PlannerDatabase};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    future::ready,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

fn fixture() -> (Arc<Mutex<PlannerDatabase>>, PlannerAssistant) {
    let db = Arc::new(Mutex::new(
        PlannerDatabase::open(":memory:".as_ref()).unwrap(),
    ));
    db.lock().unwrap().mutate(json!({
        "requestId":"seed","label":"Fixture","expectedRevision":0,
        "changes":[
            {"action":"create","entity":"task","id":"paper","fields":{"title":"Apply for Community Garden Plan"}},
            {"action":"create","entity":"task","id":"hall","fields":{"title":"Library fundraiser"}},
            {"action":"create","entity":"event","id":"linked","fields":{"title":"Prep work","startDate":"2026-11-12","linkedTaskId":"hall"}},
            {"action":"create","entity":"event","id":"standalone","fields":{"title":"Library fundraiser","startDate":"2026-11-12"}}
        ]
    })).unwrap();
    (db.clone(), PlannerAssistant::new(db))
}

fn decision(changes: &[Value]) -> String {
    json!({"kind":"changes","message":"Review the proposed changes.","changes":changes}).to_string()
}

fn reply_decision(message: &str) -> String {
    json!({"kind":"reply","message":message}).to_string()
}

fn kind_only(kind: &str, message: &str) -> String {
    json!({"kind":kind,"message":message}).to_string()
}

async fn attempt(
    service: &PlannerAssistant,
    request: Value,
    proposals: &[&str],
) -> (Result<Value>, usize) {
    let calls = Cell::new(0);
    let result = service
        .run_with(
            request,
            Some("qwen-test"),
            8192,
            &CancellationToken::new(),
            |_| {
                let n = calls.get();
                calls.set(n + 1);
                ready(Ok(
                    json!({"message":{"content":proposals[n.min(proposals.len() - 1)]}}),
                ))
            },
        )
        .await;
    (result, calls.get())
}

async fn chat(service: &PlannerAssistant, id: &str, text: &str, decision_content: &str) -> Value {
    let (result, calls) = attempt(
        service,
        json!({"text":text,"requestId":id}),
        &[decision_content],
    )
    .await;
    assert_eq!(calls, 1, "{text}: {result:?}");
    result.unwrap_or_else(|error| panic!("{text}: {error}"))
}

fn identity(draft: &Value, id: &str) -> Value {
    json!({"draftId":draft["id"],"version":draft["version"],"expectedRevision":draft["baseRevision"],"requestId":id})
}

#[tokio::test]
async fn compound_ai_proposal_is_previewed_together_and_undoable() {
    let (db, service) = fixture();
    let text = "Remove the Apply for Community Garden Plan task and the Library fundraiser task and their linked calendar events, then add a task called Write agenda due 2026-11-12";
    let reply = chat(
        &service,
        "compound",
        text,
        &decision(&[
            json!({"action":"delete","entity":"task","id":"paper","source":"Remove the Apply for Community Garden Plan task"}),
            json!({"action":"delete","entity":"task","id":"hall","source":"the Library fundraiser task"}),
            json!({"action":"delete","entity":"event","id":"linked","source":"their linked calendar events"}),
            json!({"action":"create","entity":"task","source":"add a task called Write agenda due 2026-11-12","fields":{"title":"Write agenda","dueDate":"2026-11-12"}}),
        ]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    assert_eq!(
        draft["projectedSnapshot"]["tasks"][0]["title"], "Write agenda",
        "{reply}"
    );
    assert_eq!(
        draft["projectedSnapshot"]["tasks"][0]["dueDate"],
        "2026-11-12"
    );
    assert_eq!(
        draft["projectedSnapshot"]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(draft["projectedSnapshot"]["events"][0]["id"], "standalone");
    assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
    let receipt = service
        .drafts()
        .apply_draft(identity(draft, "apply"))
        .unwrap();
    assert_eq!(
        service
            .drafts()
            .apply_draft(identity(draft, "retry"))
            .unwrap(),
        receipt
    );
    let undo = chat(&service, "undo", "Undo that", &kind_only("undo", "Undo prepared.")).await;
    let draft = &undo["preview"]["draft"];
    assert_eq!(
        draft["projectedSnapshot"]["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "{undo}"
    );
    service
        .drafts()
        .apply_draft(identity(draft, "undo-apply"))
        .unwrap();
    assert_eq!(
        db.lock().unwrap().snapshot().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn a_delete_without_a_unique_named_target_is_rejected_without_changes() {
    let (db, service) = fixture();
    db.lock().unwrap().mutate(json!({"requestId":"duplicate","expectedRevision":1,"label":"Duplicate","changes":[
        {"action":"create","entity":"task","id":"paper2","fields":{"title":"Apply for Community Garden Plan"}}
    ]})).unwrap();
    let before = db.lock().unwrap().snapshot().unwrap();
    let text = "Delete the Apply for Community Garden Plan task.";
    let (result, calls) = attempt(
        &service,
        json!({"text":text,"requestId":"ambiguous"}),
        &[&decision(&[
            json!({"action":"delete","entity":"task","id":"paper2","source":text}),
        ])],
    )
    .await;
    assert_eq!(calls, 2, "one repair may run: {result:?}");
    let error = result.expect_err("ambiguous delete must not stage");
    assert!(
        error.to_string().contains("unique named or selected delete target"),
        "{error}"
    );
    assert!(service.drafts().get_draft().unwrap().is_none());
    assert_eq!(db.lock().unwrap().snapshot().unwrap(), before);
}

#[tokio::test]
async fn an_existing_saved_revision_is_required_to_edit_or_apply() {
    let (db, service) = fixture();
    let text = "Add a task called Write agenda due 2026-11-12";
    let reply = chat(
        &service,
        "create",
        text,
        &decision(&[json!({
            "action":"create","entity":"task","source":text,
            "fields":{"title":"Write agenda","dueDate":"2026-11-12"}
        })]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    db.lock().unwrap().mutate(json!({"requestId":"external","expectedRevision":1,"label":"External","changes":[{"action":"update","entity":"task","id":"paper","fields":{"title":"New title"}}]})).unwrap();
    assert_eq!(
        service.drafts().get_draft().unwrap().unwrap()["stale"],
        true
    );
    assert!(
        service
            .drafts()
            .apply_draft(identity(draft, "stale"))
            .is_err()
    );
    let draft = service.drafts().edit_draft(json!({"draftId":draft["id"],"version":draft["version"],"expectedRevision":2,"repreview":true})).unwrap();
    assert_eq!(draft["stale"], false);
    assert_eq!(draft["baseRevision"], 2);
    assert!(
        service
            .drafts()
            .apply_draft(identity(&draft, "new"))
            .is_ok()
    );
}

#[tokio::test]
async fn deleting_tasks_and_their_linked_sessions_keeps_standalone_events() {
    let (_db, service) = fixture();
    let text = "Delete the Apply for Community Garden Plan task and the Library fundraiser task, including every calendar session linked to each task.";
    let reply = chat(
        &service,
        "each",
        text,
        &decision(&[
            json!({"action":"delete","entity":"task","id":"paper","source":"Delete the Apply for Community Garden Plan task"}),
            json!({"action":"delete","entity":"task","id":"hall","source":"the Library fundraiser task"}),
            json!({"action":"delete","entity":"event","id":"linked","source":"including every calendar session linked to each task"}),
        ]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    assert_eq!(draft["projectedSnapshot"]["tasks"], json!([]), "{reply}");
    assert_eq!(
        draft["projectedSnapshot"]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(draft["projectedSnapshot"]["events"][0]["id"], "standalone");
}

#[tokio::test]
async fn kept_linked_event_detaches_and_standalone_event_is_unchanged() {
    let (db, service) = fixture();
    let before = db.lock().unwrap().snapshot().unwrap();
    let text = "Delete the Library fundraiser task and its linked calendar events, but keep the Prep work event and the standalone Library fundraiser.";
    let reply = chat(
        &service,
        "protect",
        text,
        &decision(&[
            json!({"action":"delete","entity":"task","id":"hall","source":"Delete the Library fundraiser task"}),
        ]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    let events = draft["projectedSnapshot"]["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{reply}");
    assert!(events.iter().all(|e| e["linkedTaskId"].is_null()));
    let unchanged = events.iter().find(|e| e["id"] == "standalone").unwrap();
    assert_eq!(
        unchanged,
        before["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == "standalone")
            .unwrap()
    );
}

#[tokio::test]
async fn structured_create_rejects_ungrounded_deletions_and_unstated_dates() {
    let (db, service) = fixture();
    let token = CancellationToken::new();
    let text = "Add a task called Read paper due 2026-11-15 and a task called Summarize paper";
    let valid = json!({"action":"create","entity":"task","source":"Add a task called Read paper due 2026-11-15","fields":{"title":"Read paper","dueDate":"2026-11-15"}});
    for (id, second, accepted) in [
        (
            "deleted",
            json!({"action":"delete","entity":"task","id":"paper","source":"Add a task called Read paper"}),
            false,
        ),
        (
            "date",
            json!({"action":"create","entity":"task","source":"a task called Summarize paper","fields":{"title":"Summarize paper","dueDate":"2026-11-15"}}),
            false,
        ),
        (
            "valid",
            json!({"action":"create","entity":"task","source":"a task called Summarize paper","fields":{"title":"Summarize paper"}}),
            true,
        ),
    ] {
        let response = json!({"message":{"content":decision(&[valid.clone(),second])}});
        let result = service
            .run_with(
                json!({"requestId":id,"text":text}),
                Some("qwen-test"),
                8192,
                &token,
                |_| {
                    assert!(
                        db.try_lock().is_ok(),
                        "SQLite must not be held during inference"
                    );
                    std::future::ready(Ok(response.clone()))
                },
            )
            .await;
        assert_eq!(result.as_ref().map(|value| !value["preview"].is_null()).unwrap_or(false), accepted, "{result:?}");
        assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
    }
}

#[tokio::test]
async fn cancelling_model_inference_never_publishes_a_draft_or_leaves_it_busy() {
    let (_db, service) = fixture();
    let token = CancellationToken::new();
    let result = service.run_with(json!({"requestId":"cancel","text":"Add a task called Read paper and a task called Summarize paper"}), Some("qwen-test"), 8192, &token, |_| {
        token.cancel();
        std::future::pending()
    }).await;
    assert!(result.unwrap_err().to_string().contains("stopped"));
    assert!(service.drafts().get_draft().unwrap().is_none());
    let text = "Add a task called Write agenda";
    let (result, _) = attempt(
        &service,
        json!({"text":text,"requestId":"next"}),
        &[&decision(&[json!({
            "action":"create","entity":"task","source":text,"fields":{"title":"Write agenda"}
        })])],
    )
    .await;
    assert_eq!(result.unwrap()["preview"]["draft"]["busy"], false);
}

#[tokio::test]
async fn preview_retains_generated_category_ids_when_the_user_edits_them() {
    let db = Arc::new(Mutex::new(
        PlannerDatabase::open(":memory:".as_ref()).unwrap(),
    ));
    let assistant = PlannerAssistant::new(db.clone());
    let text = "Add a task called Buy milk";
    let reply = chat(
        &assistant,
        "category",
        text,
        &decision(&[json!({
            "action":"create","entity":"task","source":text,"fields":{"title":"Buy milk"}
        })]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    let category = &draft["projectedSnapshot"]["categories"][0]["id"];
    assert!(category.is_string());
    let changed = assistant.drafts().edit_draft(json!({
        "draftId":draft["id"],"version":draft["version"],"expectedRevision":draft["baseRevision"],
        "changes":[{"action":"update","entity":"category","id":category,"fields":{"title":"Groceries"}}]
    })).unwrap();
    assert_eq!(
        changed["projectedSnapshot"]["tasks"][0]["categoryId"],
        *category
    );
    assert_eq!(
        changed["projectedSnapshot"]["categories"][0]["id"],
        *category
    );
    assert_eq!(
        changed["projectedSnapshot"]["categories"][0]["title"],
        "Groceries"
    );
    assert_eq!(db.lock().unwrap().revision().unwrap(), 0);
    assistant
        .drafts()
        .apply_draft(identity(&changed, "save"))
        .unwrap();
    assert_eq!(
        db.lock().unwrap().snapshot().unwrap()["categories"][0]["id"],
        *category
    );
}

#[tokio::test]
async fn conversational_replies_pass_through_verbatim() {
    let (db, assistant) = fixture();
    let reply = chat(
        &assistant,
        "scheduled",
        "What is on my schedule on 2026-11-12?",
        &reply_decision("On 2026-11-12 you have the Library fundraiser."),
    )
    .await;
    assert_eq!(
        reply["content"],
        "On 2026-11-12 you have the Library fundraiser."
    );
    assert!(reply["preview"].is_null());
    assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
}

#[tokio::test]
async fn adding_a_step_preserves_existing_checklist_ids_and_waits_for_apply() {
    let (db, assistant) = fixture();
    db.lock().unwrap().mutate(json!({"requestId":"steps","expectedRevision":1,"label":"Seed steps","changes":[
        {"action":"update","entity":"task","id":"paper","fields":{"steps":[{"id":"original","title":"Draft application","completed":true}]}}
    ]})).unwrap();
    let text = "Add a step to Apply for Community Garden Plan: Review conclusions.";
    let result = chat(
        &assistant,
        "step",
        text,
        &decision(&[json!({
            "action":"update","entity":"task","id":"paper","source":text,
            "fields":{"steps":["Draft application","Review conclusions"]}
        })]),
    )
    .await;
    let draft = &result["preview"]["draft"];
    let task = draft["projectedSnapshot"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == "paper")
        .unwrap();
    assert_eq!(
        task["steps"][0],
        json!({"id":"original","title":"Draft application","completed":true})
    );
    assert_eq!(task["steps"][1]["title"], "Review conclusions");
    assert_eq!(db.lock().unwrap().revision().unwrap(), 2);
    assistant
        .drafts()
        .apply_draft(identity(draft, "apply-step"))
        .unwrap();
    assert_eq!(db.lock().unwrap().revision().unwrap(), 3);
}

#[tokio::test]
async fn restore_kind_brings_back_a_removed_record_after_apply() {
    let (db, service) = fixture();
    let text = "Delete the Library fundraiser task";
    let reply = chat(
        &service,
        "delete",
        text,
        &decision(&[json!({
            "action":"delete","entity":"task","id":"hall","source":text
        })]),
    )
    .await;
    let draft = &reply["preview"]["draft"];
    service
        .drafts()
        .apply_draft(identity(draft, "apply-delete"))
        .unwrap();
    assert!(db.lock().unwrap().snapshot().unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|task| task["id"] != "hall"));
    let (result, calls) = attempt(
        &service,
        json!({"text":"Bring back the Library fundraiser task","requestId":"restore"}),
        &[&json!({
            "kind":"restore","message":"Restoration prepared.",
            "targetEntity":"task","targetId":"hall"
        })
        .to_string()],
    )
    .await;
    assert_eq!(calls, 1);
    let restored = result.unwrap();
    let draft = &restored["preview"]["draft"];
    assert!(draft["projectedSnapshot"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["id"] == "hall"));
    service
        .drafts()
        .apply_draft(identity(draft, "apply-restore"))
        .unwrap();
    assert!(db.lock().unwrap().snapshot().unwrap()["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["id"] == "hall"));
}

#[tokio::test]
async fn a_missing_model_is_reported_instead_of_a_built_in_reply() {
    let (_db, service) = fixture();
    let error = service
        .run(
            json!({"text":"Add a task called Write agenda","requestId":"no-model"}),
            None,
            &CancellationToken::new(),
        )
        .await
        .expect_err("no model must not produce a canned planner reply");
    assert!(error.to_string().contains("model"), "{error}");
}
