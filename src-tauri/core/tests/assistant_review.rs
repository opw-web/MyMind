use mymind_core::{assistant::PlannerAssistant, database::PlannerDatabase};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
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

async fn chat(service: &PlannerAssistant, id: &str, text: &str) -> Value {
    service
        .run(
            json!({"text":text,"requestId":id}),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap()
}

fn identity(draft: &Value, id: &str) -> Value {
    json!({"draftId":draft["id"],"version":draft["version"],"expectedRevision":draft["baseRevision"],"requestId":id})
}

#[tokio::test]
async fn compound_delete_alias_and_addition_are_previewed_together_and_undoable() {
    let (db, service) = fixture();
    let reply = chat(&service, "compound", "Remove the community garden plan task and the library fundraiser task and their linked calendar events, then add a task called Write agenda due 2026-11-12").await;
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
    let undo = chat(&service, "undo", "Undo that").await;
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
async fn unresolved_deletion_blocks_existing_preview_until_explicit_replacement() {
    let (db, service) = fixture();
    chat(
        &service,
        "create",
        "Add a task called Write agenda due 2026-11-12",
    )
    .await;
    let ambiguous = chat(
        &service,
        "ambiguous",
        "Delete the Library fundraiser task and keep the Missing task",
    )
    .await;
    assert!(ambiguous["preview"].is_null());
    let draft = service.drafts().get_draft().unwrap().unwrap();
    assert_eq!(draft["unresolved"][0]["field"], "deletionScope");
    assert!(
        service
            .drafts()
            .apply_draft(identity(&draft, "blocked"))
            .is_err()
    );
    assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
    let reply = chat(
        &service,
        "replace",
        "Instead, delete the Library fundraiser task only",
    )
    .await;
    let draft = &reply["preview"]["draft"];
    assert_eq!(draft["unresolved"], json!([]), "{reply}");
    assert_eq!(
        draft["projectedSnapshot"]["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        draft["projectedSnapshot"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["linkedTaskId"].is_null())
    );
}

#[tokio::test]
async fn an_existing_saved_revision_is_required_to_edit_or_apply() {
    let (db, service) = fixture();
    let reply = chat(
        &service,
        "create",
        "Add a task called Write agenda due 2026-11-12",
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
async fn including_each_task_resolves_the_current_named_group_and_excludes_standalone_events() {
    let (_db, service) = fixture();
    let reply = chat(&service, "each", "Delete both Apply for Community Garden Plan and Library fundraiser, including every calendar session linked to each task.").await;
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
async fn both_named_targets_cannot_expand_one_of_them_into_duplicate_tasks() {
    let (db, service) = fixture();
    db.lock().unwrap().mutate(json!({"requestId":"duplicate","expectedRevision":1,"label":"Duplicate","changes":[
        {"action":"create","entity":"task","id":"paper2","fields":{"title":"Apply for Community Garden Plan"}}
    ]})).unwrap();
    let reply = chat(&service, "both", "Delete both Apply for Community Garden Plan task and Library fundraiser task, including every calendar session linked to each task.").await;
    assert!(reply["preview"].is_null(), "{reply}");
    assert!(reply["content"].as_str().unwrap().contains("several"));
}

#[tokio::test]
async fn each_task_does_not_reuse_a_previous_group_after_a_new_command() {
    let (_db, service) = fixture();
    let reply = chat(
        &service,
        "each",
        "Delete the Library fundraiser task. Delete every calendar session linked to each task.",
    )
    .await;
    assert!(reply["preview"].is_null(), "{reply}");
}

#[tokio::test]
async fn protected_linked_event_detaches_and_standalone_event_is_unchanged() {
    let (db, service) = fixture();
    let before = db.lock().unwrap().snapshot().unwrap();
    let reply = chat(&service, "protect", "Delete the Library fundraiser task and its linked calendar events, but keep the Prep work event and the standalone Library fundraiser.").await;
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
async fn deletion_model_must_confirm_each_verbatim_source_and_grounded_candidate() {
    let (_db, service) = fixture();
    let source = "the task about submitting the community garden plan application";
    let text = format!(
        "Delete {source} and the Library fundraiser task, but keep the standalone Library fundraiser."
    );
    for (id, target, supplied, accepted) in [
        ("invented", "task:paper", "invented source", false),
        ("other", "task:hall", source, false),
        ("confirmed", "task:paper", source, true),
    ] {
        let token = CancellationToken::new();
        let result = service.run_with(json!({"requestId":id,"text":text}), Some("qwen-test"), 8192, &token, |body| {
            assert!(body["format"].is_object());
            let user: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(user["clauses"][0]["source"], source);
            assert_eq!(user["clauses"][0]["candidates"][0]["key"], "task:paper");
            std::future::ready(Ok(json!({"message":{"content":json!({"matches":[{"clause":1,"source":supplied,"target":target}]}).to_string()}})))
        }).await.unwrap();
        assert_eq!(!result["preview"].is_null(), accepted, "{result}");
        assert_eq!(service.drafts().get_draft().unwrap().is_some(), accepted);
    }
}

#[tokio::test]
async fn structured_create_rejects_model_deletion_and_unstated_dates() {
    let (db, service) = fixture();
    let token = CancellationToken::new();
    let text = "Add a task called Read paper due 2026-11-15 and a task called Summarize paper";
    let valid = json!({"action":"create","entity":"task","source":"Add a task called Read paper due 2026-11-15","fields":{"title":"Read paper","dueDate":"2026-11-15"}});
    for (id, second, accepted) in [
        (
            "deleted",
            json!({"action":"delete","entity":"task","id":"paper","source":"Add a task called Read paper","fields":{}}),
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
        let response = json!({"message":{"content":json!({"changes":[valid,second]}).to_string()}});
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
            .await
            .unwrap();
        assert_eq!(!result["preview"].is_null(), accepted, "{result}");
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
    assert!(
        chat(&service, "next", "Add a task called Write agenda").await["preview"]["draft"]["busy"]
            == false
    );
}

#[tokio::test]
async fn date_answer_resolves_its_request_issue_and_keeps_earlier_work_pending() {
    let (db, service) = fixture();
    chat(&service, "create", "Add a task called Write agenda").await;
    let reply = chat(&service, "missing", "Add an event called Jazz Night").await;
    let draft = &reply["preview"]["draft"];
    let issue = &draft["unresolved"][0]["id"];
    assert!(
        service
            .drafts()
            .apply_draft(identity(draft, "apply-blocked"))
            .is_err()
    );
    let reply = service.run(json!({"requestId":"answer","text":"2026-11-14 from 19:00 to 21:00","clarificationIssueId":issue}), None, &CancellationToken::new()).await.unwrap();
    let next = &reply["preview"]["draft"];
    assert_eq!(next["id"], draft["id"]);
    assert_eq!(next["unresolved"], json!([]), "{reply}");
    let events = next["projectedSnapshot"]["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["title"] == "Jazz Night"
        && e["startDate"] == "2026-11-14"
        && e["startTime"] == "19:00"));
    assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
}

#[tokio::test]
async fn preview_retains_generated_category_ids_when_the_user_edits_them() {
    let db = Arc::new(Mutex::new(
        PlannerDatabase::open(":memory:".as_ref()).unwrap(),
    ));
    let assistant = PlannerAssistant::new(db.clone());
    let reply = chat(&assistant, "category", "Add a task called Buy milk").await;
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
async fn both_requires_exactly_two_matches_in_a_named_plural_group() {
    let (db, assistant) = fixture();
    db.lock().unwrap().mutate(json!({"requestId":"third","expectedRevision":1,"label":"Duplicate","changes":[
        {"action":"create","entity":"task","id":"hall-two","fields":{"title":"Library fundraiser"}},
        {"action":"create","entity":"task","id":"hall-three","fields":{"title":"Library fundraiser"}}
    ]})).unwrap();
    let before = db.lock().unwrap().snapshot().unwrap();
    let result = chat(
        &assistant,
        "both-three",
        "Delete both Library fundraiser tasks.",
    )
    .await;
    assert!(result["preview"].is_null(), "{result}");
    assert!(result["content"].as_str().unwrap().contains("Which two"));
    assert_eq!(db.lock().unwrap().snapshot().unwrap(), before);
}

#[tokio::test]
async fn embedded_corrections_cannot_be_treated_as_delete_descriptions() {
    let (db, assistant) = fixture();
    let before = db.lock().unwrap().snapshot().unwrap();
    let text = "Delete the task about applying for project nine lives wait actually keep it.";
    let result = assistant
        .run_with(
            json!({"text":text,"requestId":"protect"}),
            Some("qwen3.5:4b"),
            32768,
            &CancellationToken::new(),
            |_| async {
                panic!("A deletion description with an inline correction must not call the model.");
            },
        )
        .await
        .unwrap();
    assert!(result["preview"].is_null(), "{result}");
    assert_eq!(db.lock().unwrap().snapshot().unwrap(), before);
}

#[tokio::test]
async fn reads_schedule_and_completion_from_records_instead_of_title_words() {
    let (db, assistant) = fixture();
    let scheduled = chat(
        &assistant,
        "scheduled",
        "What tasks are scheduled on 2026-11-12?",
    )
    .await;
    assert!(
        scheduled["content"]
            .as_str()
            .unwrap()
            .contains("Library fundraiser")
    );
    assert!(
        !scheduled["content"]
            .as_str()
            .unwrap()
            .contains("Community Garden Plan")
    );
    db.lock()
        .unwrap()
        .mutate(
            json!({"requestId":"done","expectedRevision":1,"label":"Done","changes":[
                {"action":"update","entity":"task","id":"paper","fields":{"completed":true}}
            ]}),
        )
        .unwrap();
    let completed = chat(&assistant, "completed", "Show completed tasks").await;
    assert!(
        completed["content"]
            .as_str()
            .unwrap()
            .contains("Community Garden Plan")
    );
    assert!(
        !completed["content"]
            .as_str()
            .unwrap()
            .contains("Library fundraiser")
    );
    assert_eq!(db.lock().unwrap().revision().unwrap(), 2);
}

#[tokio::test]
async fn adding_a_step_preserves_existing_checklist_ids_and_waits_for_apply() {
    let (db, assistant) = fixture();
    db.lock().unwrap().mutate(json!({"requestId":"steps","expectedRevision":1,"label":"Seed steps","changes":[
        {"action":"update","entity":"task","id":"paper","fields":{"steps":[{"id":"original","title":"Draft application","completed":true}]}}
    ]})).unwrap();
    let result = chat(
        &assistant,
        "step",
        "Add a step to Apply for Community Garden Plan: Review conclusions.",
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
