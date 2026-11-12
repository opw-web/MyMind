use super::*;
use serde_json::json;

#[test]
fn a_new_database_contains_only_inbox() -> Result<()> {
    let db = PlannerDatabase::open(Path::new(":memory:"))?;
    let snapshot = db.snapshot()?;
    assert_eq!(snapshot["revision"], 0);
    assert_eq!(
        snapshot["projects"],
        json!([{"id":"inbox","title":"Inbox","order":0}])
    );
    for name in ["tasks", "events", "sections", "categories"] {
        assert_eq!(snapshot[name], json!([]));
    }
    assert_eq!(snapshot["canUndo"], false);
    assert_eq!(snapshot["preferences"]["timezone"], "Asia/Kolkata");
    Ok(())
}

fn mutate(db: &mut PlannerDatabase, changes: Value, request: &str) -> Result<Value> {
    db.mutate(json!({"changes":changes,"requestId":request,"label":"Test changes","expectedRevision":db.revision()?}))
}

#[test]
fn mutation_rolls_back_categories_and_tasks_on_invalid_fields() -> Result<()> {
    let mut db = PlannerDatabase::open(Path::new(":memory:"))?;
    let before = db.snapshot()?;
    let error = mutate(
        &mut db,
        json!([
            {"action":"create","entity":"task","fields":{"title":"Clean up"}},
            {"action":"create","entity":"event","fields":{"title":"Exam","startDate":"2026-02-30"}},
        ]),
        "invalid",
    )
    .unwrap_err();
    assert!(error.to_string().contains("valid date"));
    assert_eq!(db.snapshot()?, before);
    assert!(db.receipt("invalid")?.is_none());
    Ok(())
}

#[test]
fn compiled_apply_reuses_preview_ids_and_rejects_a_changed_base_revision() -> Result<()> {
    let mut db = PlannerDatabase::open(Path::new(":memory:"))?;
    let changes = json!([{"action":"create","entity":"task","fields":{"title":"Buy groceries"}}]);
    let batch = db.preview_batch(0, changes.clone(), None, &[], None)?;
    let projected = batch.projected_snapshot();
    let projected_id = projected["tasks"][0]["id"].clone();
    assert_eq!(projected["categories"][0]["title"], "Errands");
    assert_eq!(db.snapshot()?["tasks"], json!([]));
    let input = json!({"draftId":"draft","version":1,"requestId":"apply","expectedRevision":0});
    let receipt = db.apply_batch(&batch, input.clone())?;
    assert_eq!(receipt["revision"], 1);
    assert_eq!(db.snapshot()?["tasks"][0]["id"], projected_id);
    assert_eq!(db.apply_batch(&batch, input.clone())?, receipt);
    let mut retry_with_wrong_revision = input.clone();
    retry_with_wrong_revision["expectedRevision"] = 1.into();
    assert!(db.apply_batch(&batch, retry_with_wrong_revision).is_err());
    assert!(
        db.apply_batch(
            &batch,
            json!({"draftId":"different","version":1,"requestId":"apply","expectedRevision":0})
        )
        .is_err()
    );

    let undo = db.capture_undo(1)?;
    let staged_undo = db.preview_batch(1, json!([]), Some(&undo), &[], None)?;
    assert_eq!(staged_undo.projected_snapshot()["tasks"], json!([]));
    assert_eq!(staged_undo.items()[0]["action"], "undo");
    let undone = db.apply_batch(
        &staged_undo,
        json!({"draftId":"undo","version":1,"requestId":"apply-undo","expectedRevision":1}),
    )?;
    assert_eq!(undone["revision"], 2);
    assert_eq!(db.snapshot()?["tasks"], json!([]));
    db.undo(Some(2), Some("undo-undo"))?;
    assert_eq!(db.snapshot()?["tasks"][0]["id"], projected_id);
    Ok(())
}

#[test]
fn linked_step_completion_and_deletion_preserve_sessions() -> Result<()> {
    let mut db = PlannerDatabase::open(Path::new(":memory:"))?;
    mutate(
        &mut db,
        json!([
            {"action":"create","entity":"event","id":"s","fields":{"title":"Review block","startDate":"2026-11-10","linkedTaskId":"t","linkedStepId":"one"}},
            {"action":"create","entity":"task","id":"t","fields":{"title":"Review project","dueDate":"2026-11-13","steps":[{"id":"one","title":"Review","completed":false}]}}
        ]),
        "setup",
    )?;
    mutate(
        &mut db,
        json!([{"action":"update","entity":"event","id":"s","fields":{"completed":true}}]),
        "complete",
    )?;
    let completed = db.snapshot()?;
    assert_eq!(completed["tasks"][0]["steps"][0]["completed"], true);
    assert_eq!(completed["tasks"][0]["completed"], false);
    assert_eq!(completed["events"][0]["completed"], true);
    mutate(
        &mut db,
        json!([{"action":"update","entity":"task","id":"t","fields":{"steps":[]}}]),
        "remove-step",
    )?;
    let detached = db.snapshot()?;
    assert_eq!(detached["events"][0]["linkedStepId"], Value::Null);
    assert_eq!(detached["events"][0]["linkedTaskId"], "t");
    assert_eq!(detached["events"][0]["completed"], false);
    mutate(
        &mut db,
        json!([{"action":"delete","entity":"task","id":"t"}]),
        "remove-task",
    )?;
    assert_eq!(db.snapshot()?["events"][0]["linkedTaskId"], Value::Null);
    db.undo(Some(4), None)?;
    assert_eq!(db.snapshot()?["events"][0]["linkedTaskId"], "t");
    assert_eq!(db.snapshot()?["tasks"][0]["dueDate"], "2026-11-13");
    Ok(())
}

#[test]
fn v8_upgrade_backs_up_wal_and_restores_stable_legacy_session_ids() -> Result<()> {
    use rusqlite::{Connection, params};
    let temporary = tempfile::tempdir()?;
    let path = temporary.path().join("planner.sqlite");
    let old = PlannerDatabase::open(&path)?;
    old.connection
        .execute_batch("PRAGMA wal_autocheckpoint=0; PRAGMA user_version=8;")?;
    let task = json!({
        "id":"work", "title":"Work", "notes":"latest in WAL","textBox":"","dueDate":"2026-09-13",
        "scheduledDate":"2026-09-15","createdAt":null,"completedAt":null,"completed":false,"steps":[],
        "dependsOnIds":[],"categoryId":null,"colorOverride":null,"color":"sage",
        "projectId":"inbox","sectionId":null,"order":0,
    });
    let existing = json!({
        "id":"legacy-session:work","title":"Independent","notes":"","textBox":"",
        "startDate":"2026-09-17","endDate":"2026-09-17","startTime":null,"endTime":null,
        "linkedTaskId":null,"completed":false,"categoryId":null,"colorOverride":null,"color":"coral",
    });
    old.connection.execute(
        "INSERT INTO tasks VALUES (?,?,?,?)",
        params!["work", "inbox", None::<&str>, task.to_string()],
    )?;
    old.connection.execute(
        "INSERT INTO events VALUES (?,?)",
        params!["legacy-session:work", existing.to_string()],
    )?;
    let state = json!({
        "tasks":[{ "notes": "previous note" }],
        "events":[existing],"sections":[],"categories":[],
        "projects":[{"id":"inbox","title":"Inbox","order":0}],
    });
    let mut state = state;
    state["tasks"][0] = task;
    state["tasks"][0]["notes"] = "previous note".into();
    old.connection.execute(
        "INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)",
        params!["Updated task", state.to_string(), "[]"],
    )?;
    old.set_meta("revision", "7")?;

    let mut db = PlannerDatabase::open(&path)?;
    let backup = Connection::open(temporary.path().join("planner.sqlite.v8-backup"))?;
    assert_eq!(
        backup.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
        8
    );
    assert_eq!(
        backup.query_row(
            "SELECT json_extract(body, '$.notes') FROM tasks",
            [],
            |row| row.get::<_, String>(0)
        )?,
        "latest in WAL"
    );
    assert_eq!(
        backup.query_row("SELECT count(*) FROM events", [], |row| row
            .get::<_, i64>(0))?,
        1
    );
    let snapshot = db.snapshot()?;
    assert_eq!(snapshot["tasks"][0]["dueDate"], "2026-09-13");
    assert_eq!(snapshot["events"][0]["id"], "legacy-session:work");
    assert_eq!(snapshot["events"][1]["id"], "legacy-session:work:legacy");
    assert_eq!(snapshot["events"][1]["startDate"], "2026-09-15");
    db.undo(Some(7), None)?;
    assert_eq!(
        db.snapshot()?["events"][1]["id"],
        "legacy-session:work:legacy"
    );
    assert_eq!(db.snapshot()?["tasks"][0]["notes"], "previous note");
    Ok(())
}

#[test]
fn event_receipts_use_the_electron_date_format() -> Result<()> {
    let mut db = PlannerDatabase::open(Path::new(":memory:"))?;
    let receipt = mutate(
        &mut db,
        json!([{
            "action":"create", "entity":"event", "id":"exam",
            "fields":{"title":"Final exam","startDate":"2026-09-08","startTime":"08:00","endTime":"09:00","categoryId":null}
        }]),
        "september",
    )?;
    assert_eq!(
        receipt["descriptions"],
        json!(["Added event: Final exam · Date 8 Sept 2026, 08:00–09:00"])
    );
    Ok(())
}

#[test]
fn preferences_accept_legacy_icu_time_zone_names_and_offsets() -> Result<()> {
    let db = PlannerDatabase::open(Path::new(":memory:"))?;
    for zone in ["US/Pacific-New", "SystemV/PST8PDT", "−05:00"] {
        db.preferences(json!({"timezone":zone}))?;
        assert_eq!(db.snapshot()?["preferences"]["timezone"], zone);
    }
    assert!(db.preferences(json!({"timezone":"−25:00"})).is_err());
    assert_eq!(db.revision()?, 0);
    Ok(())
}
