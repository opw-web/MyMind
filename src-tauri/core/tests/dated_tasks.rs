use chrono::{TimeZone, Utc};
use mymind_core::{assistant::PlannerAssistant, database::PlannerDatabase};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    future::ready,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

fn fixture() -> (Arc<Mutex<PlannerDatabase>>, PlannerAssistant) {
    let clock = || Utc.with_ymd_and_hms(2026, 11, 10, 9, 0, 0).unwrap();
    let db = Arc::new(Mutex::new(
        PlannerDatabase::open_with_clock(":memory:".as_ref(), clock).unwrap(),
    ));
    (db.clone(), PlannerAssistant::with_clock(db, clock))
}

fn task(title: &str, source: &str, id: &str) -> Value {
    json!({"action":"create","entity":"task","id":id,"source":source,"fields":{"title":title}})
}

fn event(title: &str, source: &str, date: &str, task_id: &str) -> Value {
    json!({"action":"create","entity":"event","source":source,
        "fields":{"title":title,"startDate":date,"linkedTaskId":task_id}})
}

async fn with_proposals(
    service: &PlannerAssistant,
    request: Value,
    proposals: &[&str],
) -> (Value, usize) {
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
        .await
        .unwrap();
    (result, calls.get())
}

fn proposal(changes: &[Value]) -> String {
    json!({"changes":changes}).to_string()
}

fn snapshot(response: &Value) -> &Value {
    let snapshot = &response["preview"]["draft"]["projectedSnapshot"];
    assert!(
        snapshot.is_object(),
        "Expected a reviewable preview: {response}"
    );
    snapshot
}

fn assert_session(
    snapshot: &Value,
    title: &str,
    due: Option<&str>,
    date: &str,
    time: Option<&str>,
) {
    let task = snapshot["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| {
            row["title"]
                .as_str()
                .unwrap_or("")
                .eq_ignore_ascii_case(title)
        })
        .unwrap_or_else(|| panic!("Missing task {title}: {snapshot}"));
    assert_eq!(task["dueDate"], json!(due));
    let events = snapshot["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["linkedTaskId"] == task["id"])
        .collect::<Vec<_>>();
    assert_eq!(
        events.len(),
        1,
        "One session must link to {title}: {snapshot}"
    );
    let event = events[0];
    assert_eq!(event["kind"], "planned");
    assert_eq!(event["startDate"], date);
    assert_eq!(event["endDate"], date);
    assert_eq!(event["startTime"], json!(time));
    assert!(event["endTime"].is_null());
}

#[tokio::test]
async fn spoken_task_for_today_previews_one_linked_all_day_session() {
    let (db, service) = fixture();
    let text = "Create a task for today, All day, 3D printing, The walls game.";
    let plan = proposal(&[task("3D printing The walls game", text, "t")]);
    let (result, _) = with_proposals(
        &service,
        json!({"text":text,"requestId":"spoken"}),
        &[&plan],
    )
    .await;
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(projected["events"].as_array().unwrap().len(), 1);
    assert_session(
        projected,
        "3D printing The walls game",
        None,
        "2026-11-10",
        None,
    );
    assert_eq!(db.lock().unwrap().revision().unwrap(), 0);
}

#[tokio::test]
async fn conversational_calendar_and_task_request_accepts_a_grounded_pair() {
    let (_, service) = fixture();
    let text = "Okay, I want an event for today. The task and event for today, all day is for me to 3D print the walls game. So add that to my calendar and task.";
    let plan = proposal(&[
        task("3D print the walls game", text, "t"),
        event("3D print the walls game", text, "2026-11-10", "t"),
    ]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"paired"}),
        &[&plan],
    )
    .await;
    assert_eq!(calls, 1);
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(projected["events"].as_array().unwrap().len(), 1);
    assert_session(
        projected,
        "3D print the walls game",
        None,
        "2026-11-10",
        None,
    );
}

#[tokio::test]
async fn task_dates_distinguish_work_days_from_deadlines() {
    for (text, title, due, day, time) in [
        (
            "Add a task called File receipts today",
            "File receipts",
            None,
            Some("2026-11-10"),
            None,
        ),
        (
            "Today I need to 3D print the walls game",
            "3D print the walls game",
            None,
            Some("2026-11-10"),
            None,
        ),
        (
            "Tomorrow I need to 3D print the walls game at 3 pm",
            "3D print the walls game",
            None,
            Some("2026-11-11"),
            Some("15:00"),
        ),
        (
            "By today I have to finish 3D printing the walls game",
            "Finish 3D printing the walls game",
            Some("2026-11-10"),
            None,
            None,
        ),
        (
            "Add a task called File receipts",
            "File receipts",
            None,
            None,
            None,
        ),
        (
            "Add a task called File receipts today, but do not create a calendar event",
            "File receipts",
            None,
            None,
            None,
        ),
        (
            "Add a task called File receipts today, but keep this task off my calendar",
            "File receipts",
            None,
            None,
            None,
        ),
        (
            "Add a task called File receipts Monday due Friday, at 5pm",
            "File receipts",
            Some("2026-11-13"),
            Some("2026-11-16"),
            None,
        ),
        (
            "Add a task called File receipts today at 3 pm, due Friday",
            "File receipts",
            Some("2026-11-13"),
            Some("2026-11-10"),
            Some("15:00"),
        ),
    ] {
        let (_, service) = fixture();
        let result = service
            .run(
                json!({"text":text,"requestId":"temporal"}),
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let projected = snapshot(&result);
        assert_eq!(projected["tasks"].as_array().unwrap().len(), 1, "{text}");
        assert_eq!(projected["tasks"][0]["title"], title, "{text}");
        if let Some(day) = day {
            assert_session(projected, title, due, day, time);
        } else {
            assert_eq!(projected["tasks"][0]["dueDate"], json!(due), "{text}");
            assert_eq!(projected["events"], json!([]), "{text}");
        }
    }
}

#[tokio::test]
async fn structured_task_proposals_use_each_commitments_own_temporal_evidence() {
    let (_, service) = fixture();
    let first = "Add a task called File receipts today";
    let second = "and a separate task called Mend coat tomorrow at 3 pm";
    let text = format!("{first} {second}");
    let plan = proposal(&[
        task("File receipts", first, "one"),
        task("Mend coat", second, "two"),
    ]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"multiple"}),
        &[&plan],
    )
    .await;
    assert_eq!(calls, 1);
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(projected["events"].as_array().unwrap().len(), 2);
    assert_session(projected, "File receipts", None, "2026-11-10", None);
    assert_session(projected, "Mend coat", None, "2026-11-11", Some("15:00"));
}

#[tokio::test]
async fn unsafe_or_incomplete_pairs_never_stage_partial_changes() {
    let first = "Add a task called File receipts today";
    let second = "a task called Mend coat tomorrow";
    let multi = format!("{first} and {second}");
    let paired = "Create a task and calendar event for File receipts today";
    let file = task("File receipts", first, "one");
    let mend = task("Mend coat", second, "two");
    for (text, plan) in [
        (multi.as_str(), proposal(&[file.clone()])),
        (
            multi.as_str(),
            proposal(&[file.clone(), task("Mend coat", &multi, "two")]),
        ),
        (
            multi.as_str(),
            proposal(&[
                file.clone(),
                mend.clone(),
                event("Mend coat", &multi, "2026-11-10", "one"),
            ]),
        ),
        (
            paired,
            proposal(&[event("File receipts", paired, "2026-11-10", "one")]),
        ),
        (
            paired,
            proposal(&[
                task("File receipts", paired, "one"),
                event("File receipts", paired, "2026-11-10", "unknown"),
            ]),
        ),
        (
            paired,
            proposal(&[
                task("Take passport", paired, "one"),
                event("Take passport", paired, "2026-11-10", "one"),
            ]),
        ),
    ] {
        let (db, service) = fixture();
        let (result, calls) = with_proposals(
            &service,
            json!({"text":text,"requestId":"unsafe"}),
            &[&plan],
        )
        .await;
        assert_eq!(calls, 2, "{text}: only one repair may run");
        assert!(result["preview"].is_null(), "{text} {plan}: {result}");
        assert!(
            service.drafts().get_draft().unwrap().is_none(),
            "{text} {plan}"
        );
        assert_eq!(db.lock().unwrap().revision().unwrap(), 0);
        assert!(
            !result["content"]
                .as_str()
                .unwrap()
                .contains("Unknown linked record")
        );
    }
}

#[tokio::test]
async fn malformed_model_output_can_be_repaired_once_without_writing() {
    let (db, service) = fixture();
    let text = "Create a task and calendar event for File receipts today";
    let plan = proposal(&[
        task("File receipts", text, "t"),
        event("File receipts", text, "2026-11-10", "t"),
    ]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"repair"}),
        &["{malformed", &plan],
    )
    .await;
    assert_eq!(calls, 2);
    assert_session(snapshot(&result), "File receipts", None, "2026-11-10", None);
    assert_eq!(db.lock().unwrap().revision().unwrap(), 0);
}

#[tokio::test]
async fn unresolved_or_negated_commitments_do_not_stage() {
    for text in [
        "Work on it today at 3 pm. It’s due Friday.",
        "What if I need to 3D print the walls game tomorrow?",
        "Create a task called File receipts today, but do not add a task.",
        "Create a task called File receipts today if possible.",
    ] {
        let (_, service) = fixture();
        let plan = proposal(&[task("File receipts", text, "t")]);
        let (result, calls) =
            with_proposals(&service, json!({"text":text,"requestId":"guard"}), &[&plan]).await;
        assert_eq!(calls, 0, "{text}");
        assert!(result["preview"].is_null(), "{text}: {result}");
        assert!(service.drafts().get_draft().unwrap().is_none(), "{text}");
    }
}

#[tokio::test]
async fn selected_task_can_receive_a_work_session_and_a_separate_deadline() {
    let (db, service) = fixture();
    db.lock().unwrap().mutate(json!({
        "changes":[{"action":"create","entity":"task","id":"coat","fields":{"title":"Mend coat"}}],
        "label":"Fixture","expectedRevision":0,"requestId":"seed"
    })).unwrap();
    let result = service
        .run(
            json!({
                "text":"Work on it today at 3 pm. It’s due Friday.","requestId":"selected",
                "selection":{"entity":"task","id":"coat","revision":1}
            }),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(projected["tasks"][0]["id"], "coat");
    assert_session(
        projected,
        "Mend coat",
        Some("2026-11-13"),
        "2026-11-10",
        Some("15:00"),
    );
}

#[tokio::test]
async fn event_only_request_does_not_create_a_task() {
    let (_, service) = fixture();
    let result = service.run(json!({"text":"I need to make a calendar event called Dentist tomorrow","requestId":"event"}), None, &CancellationToken::new()).await.unwrap();
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"], json!([]));
    assert_eq!(projected["events"].as_array().unwrap().len(), 1);
    assert!(projected["events"][0]["linkedTaskId"].is_null());
    assert_eq!(projected["events"][0]["startDate"], "2026-11-11");
}

#[tokio::test]
async fn exact_pair_can_be_constructed_from_one_grounded_task() {
    let (_, service) = fixture();
    let text = "Okay, I want an event for today. The task and event for today, all day is for me to 3D print the walls game. So add that to my calendar and task.";
    let plan = proposal(&[task(
        "3D print the walls game",
        "The task and event for today, all day is for me to 3D print the walls game.",
        "t",
    )]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"pair-host"}),
        &[&plan],
    )
    .await;
    assert_eq!(calls, 1);
    assert_session(
        snapshot(&result),
        "3D print the walls game",
        None,
        "2026-11-10",
        None,
    );
}

#[tokio::test]
async fn date_prefixed_task_neither_lends_its_date_nor_disappears() {
    let first = "Create a task to repair the bike";
    let second = "Add a task for tomorrow to call the clinic";
    let text = format!("{first}. {second}.");
    let repair = task("Repair the bike", first, "bike");
    for (plan, complete) in [
        (proposal(&[repair.clone()]), false),
        (
            proposal(&[repair, task("Call the clinic", second, "clinic")]),
            true,
        ),
    ] {
        let (_, service) = fixture();
        let (result, _) =
            with_proposals(&service, json!({"text":text,"requestId":"scope"}), &[&plan]).await;
        if complete {
            let projected = snapshot(&result);
            assert_eq!(projected["tasks"].as_array().unwrap().len(), 2);
            assert_eq!(projected["events"].as_array().unwrap().len(), 1);
            assert_session(projected, "Call the clinic", None, "2026-11-11", None);
        } else {
            assert!(result["preview"].is_null(), "{result}");
            assert!(service.drafts().get_draft().unwrap().is_none());
        }
    }
}

#[tokio::test]
async fn unrelated_date_does_not_schedule_an_undated_task() {
    let (_, service) = fixture();
    let text = "Create a task to repair the bike. The dentist appointment is tomorrow.";
    let plan = proposal(&[task(
        "Repair the bike",
        "Create a task to repair the bike",
        "t",
    )]);
    let (result, _) = with_proposals(
        &service,
        json!({"text":text,"requestId":"unrelated"}),
        &[&plan],
    )
    .await;
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(projected["events"], json!([]));
}

#[tokio::test]
async fn affirmative_calendar_only_request_can_exclude_tasks() {
    let (_, service) = fixture();
    let result = service.run(json!({
        "text":"Put a dentist appointment on my calendar today, all day. Do not create a task.",
        "requestId":"calendar-only"
    }), None, &CancellationToken::new()).await.unwrap();
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"], json!([]));
    assert_eq!(projected["events"].as_array().unwrap().len(), 1);
    assert!(projected["events"][0]["linkedTaskId"].is_null());
    assert_eq!(projected["events"][0]["startDate"], "2026-11-10");
}

#[tokio::test]
async fn conversational_planner_verbs_authorize_the_same_dated_task_policy() {
    for (text, day) in [
        (
            "Please make a task and calendar entry for tomorrow: sand the wooden shelf.",
            "2026-11-11",
        ),
        (
            "Put sand the wooden shelf on my task list and my calendar tomorrow.",
            "2026-11-11",
        ),
        (
            "My task for today is to sand the wooden shelf.",
            "2026-11-10",
        ),
    ] {
        let (_, service) = fixture();
        let plan = proposal(&[task("Sand the wooden shelf", text, "t")]);
        let (result, calls) = with_proposals(
            &service,
            json!({"text":text,"requestId":"paraphrase"}),
            &[&plan],
        )
        .await;
        assert_eq!(calls, 1, "{text}: {result}");
        assert_session(snapshot(&result), "Sand the wooden shelf", None, day, None);
    }
}

#[tokio::test]
async fn scheduling_work_with_explicit_deadline_does_not_need_the_model() {
    let (_, service) = fixture();
    let text =
        "Schedule work on the model airplane today, and the task must be finished by 2026-11-13.";
    let result = service
        .run(
            json!({"text":text,"requestId":"schedule-work"}),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_session(
        snapshot(&result),
        "Work on the model airplane",
        Some("2026-11-13"),
        "2026-11-10",
        None,
    );
}

#[tokio::test]
async fn explicit_task_count_prevents_staging_one_of_two_requested_tasks() {
    let (_, service) = fixture();
    let text = "Add two tasks: write the report Monday and buy milk Monday.";
    let partial = proposal(&[task("Write the report", text, "t")]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"count"}),
        &[&partial],
    )
    .await;
    assert_eq!(calls, 2);
    assert!(result["preview"].is_null(), "{result}");
    assert!(service.drafts().get_draft().unwrap().is_none());
}

#[tokio::test]
async fn a_date_in_the_reason_for_a_task_is_not_its_work_date() {
    let (_, service) = fixture();
    let text = "I need to buy milk since my flight is tomorrow";
    let plan = proposal(&[task("Buy milk", text, "t")]);
    let (result, _) = with_proposals(
        &service,
        json!({"text":text,"requestId":"reason"}),
        &[&plan],
    )
    .await;
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"][0]["title"], "Buy milk");
    assert!(projected["tasks"][0]["dueDate"].is_null());
    assert_eq!(projected["events"], json!([]));
}

#[tokio::test]
async fn deletion_companion_can_create_a_dated_task_and_its_linked_session() {
    let (db, service) = fixture();
    db.lock().unwrap().mutate(json!({
        "changes":[{"action":"create","entity":"task","id":"old","fields":{"title":"Old draft"}}],
        "label":"Fixture","expectedRevision":0,"requestId":"seed"
    })).unwrap();
    let text = "Delete the task Old draft. Add a task called File report on Friday.";
    let result = service
        .run(
            json!({"text":text,"requestId":"companion"}),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 1);
    assert_session(projected, "File report", None, "2026-11-13", None);
    assert_eq!(db.lock().unwrap().revision().unwrap(), 1);
}

#[tokio::test]
async fn omitting_a_distinct_explicit_event_does_not_stage_its_companion_task() {
    let (_, service) = fixture();
    let first = "Add a task called Write report Monday";
    let text = format!("{first}. Add an event called Dentist Tuesday.");
    let partial = proposal(&[task("Write report", first, "t")]);
    let (result, calls) = with_proposals(
        &service,
        json!({"text":text,"requestId":"distinct-event"}),
        &[&partial],
    )
    .await;
    assert_eq!(calls, 2);
    assert!(result["preview"].is_null(), "{result}");
    assert!(service.drafts().get_draft().unwrap().is_none());
}

#[tokio::test]
async fn explicitly_creating_a_dated_task_preserves_its_deadline_when_the_title_exists() {
    let (db, service) = fixture();
    db.lock().unwrap().mutate(json!({
        "changes":[{"action":"create","entity":"task","id":"old","fields":{"title":"File report"}}],
        "label":"Fixture","expectedRevision":0,"requestId":"seed"
    })).unwrap();
    let result = service
        .run(
            json!({
                "text":"Add a task called File report Monday due Friday", "requestId":"fresh-task"
            }),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let projected = snapshot(&result);
    assert_eq!(projected["tasks"].as_array().unwrap().len(), 2);
    let new = projected["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] != "old")
        .unwrap();
    assert_eq!(new["dueDate"], "2026-11-13");
    assert_eq!(projected["events"][0]["linkedTaskId"], new["id"]);
}

#[tokio::test]
async fn each_explicit_event_must_quote_a_different_requested_event() {
    let task_clause = "Add a task called Write report Monday";
    let dentist_clause = "Add an event called Dentist Tuesday";
    let flight_clause = "Add an event called Flight Wednesday";
    let text = format!("{task_clause}. {dentist_clause}. {flight_clause}.");
    let task = task("Write report", task_clause, "t");
    let dentist = json!({"action":"create","entity":"event","source":dentist_clause,
        "fields":{"title":"Dentist","startDate":"2026-11-10"}});
    let duplicate = json!({"action":"create","entity":"event","id":"second-dentist","source":format!("{dentist_clause}."),
        "fields":{"title":"Dentist","startDate":"2026-11-10"}});
    let flight = json!({"action":"create","entity":"event","source":flight_clause,
        "fields":{"title":"Flight","startDate":"2026-11-11"}});
    for (plan, accepted) in [
        (proposal(&[task.clone(), dentist.clone(), duplicate]), false),
        (proposal(&[task, dentist, flight]), true),
    ] {
        let (_, service) = fixture();
        let (result, calls) = with_proposals(
            &service,
            json!({"text":text,"requestId":"standalone-events"}),
            &[&plan],
        )
        .await;
        if accepted {
            let events = snapshot(&result)["events"].as_array().unwrap();
            assert_eq!(events.len(), 3);
            for title in ["Dentist", "Flight"] {
                assert!(
                    events
                        .iter()
                        .any(|event| event["title"] == title && event["linkedTaskId"].is_null())
                );
            }
        } else {
            assert_eq!(calls, 2);
            assert!(result["preview"].is_null(), "{result}");
            assert!(service.drafts().get_draft().unwrap().is_none());
        }
    }
}
