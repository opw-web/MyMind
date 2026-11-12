use crate::schema::{Action, Change, Entity, Fields};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};

pub(crate) fn completion(event: &Value, tasks: &[Value]) -> Option<bool> {
    let task_id = event["linkedTaskId"].as_str()?;
    let task = tasks.iter().find(|task| task["id"] == task_id)?;
    let step_completed = if let Some(step_id) = event["linkedStepId"].as_str() {
        task["steps"]
            .as_array()?
            .iter()
            .find(|step| step["id"] == step_id)?["completed"]
            == true
    } else {
        false
    };
    Some(task["completed"] == true || step_completed)
}

pub(crate) fn session_completion_changes(
    events: &[Value],
    tasks: &[Value],
    event_id: &str,
    completed: bool,
) -> Result<Vec<Change>> {
    let event = events
        .iter()
        .find(|event| event["id"] == event_id)
        .ok_or_else(|| anyhow!("That calendar entry no longer exists. Refresh and try again."))?;
    if completion(event, tasks).is_none() {
        return Ok(vec![]);
    }
    let task_id = event["linkedTaskId"].as_str().unwrap();
    let task = tasks.iter().find(|task| task["id"] == task_id).unwrap();
    let fields = if let Some(step_id) = event["linkedStepId"].as_str() {
        let mut fields = Fields::new();
        if !completed && task["completed"] == true {
            fields.insert("completed".into(), false.into());
        }
        let mut steps = task["steps"].clone();
        for step in steps.as_array_mut().unwrap() {
            if step["id"] == step_id {
                step["completed"] = completed.into();
            }
        }
        fields.insert("steps".into(), steps);
        fields
    } else {
        json!({"completed": completed}).as_object().unwrap().clone()
    };
    Ok(vec![Change::new(
        Action::Update,
        Entity::Task,
        task_id.into(),
        Some(fields),
    )])
}

pub(crate) fn session_fields(task: &Value) -> Fields {
    let mut fields = json!({
        "kind": "planned",
        "linkedTaskId": task["id"],
        "linkedStepId": null,
        "textBox": "",
        "startDate": task["scheduledDate"],
        "endDate": task["scheduledDate"],
        "startTime": null,
        "endTime": null,
    })
    .as_object()
    .unwrap()
    .clone();
    for key in [
        "title",
        "notes",
        "textBox",
        "categoryId",
        "colorOverride",
        "color",
    ] {
        if let Some(value) = task
            .get(key)
            .filter(|value| key != "textBox" || !value.is_null())
        {
            fields.insert(key.into(), value.clone());
        }
    }
    fields
}
