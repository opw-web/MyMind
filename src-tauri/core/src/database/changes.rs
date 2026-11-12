use super::{PlannerDatabase, SavedState};
use crate::{
    calendar, categories, dates,
    schema::{Action, Change, Entity, Fields, validate_fields},
    tasks,
};
use anyhow::{Result, anyhow, ensure};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(super) struct Applied {
    pub(super) descriptions: Vec<String>,
    pub(super) changes: Vec<Change>,
}

impl PlannerDatabase {
    pub(super) fn apply_changes(
        &self,
        changes: Vec<Change>,
        clock: Option<DateTime<Utc>>,
    ) -> Result<Applied> {
        let before = self.saved_state()?;
        let mut completion = Vec::new();
        let mut direct = Vec::new();
        for mut change in changes {
            // Legacy event checkboxes edit the linked work. A new session cannot complete work.
            if change.entity == Entity::Event
                && change.action != Action::Delete
                && let Some(fields) = &mut change.fields
                && fields.contains_key("completed")
            {
                validate_fields(Entity::Event, &mut fields.clone(), true)?;
                let completed = fields.remove("completed").unwrap() == true;
                if let Some(id) = change.id.as_deref()
                    && before.events.iter().any(|event| event["id"] == id)
                {
                    completion.push((id.to_owned(), completed));
                }
            }
            if change.action == Action::Delete
                || change
                    .fields
                    .as_ref()
                    .is_none_or(|fields| !fields.is_empty())
            {
                direct.push(change);
            }
        }
        let mut result = self.apply_direct(&direct, clock)?;
        for (id, completed) in completion {
            let state = self.saved_state()?;
            let routed =
                calendar::session_completion_changes(&state.events, &state.tasks, &id, completed)?;
            result.extend(self.apply_direct(&routed, clock)?);
        }
        let after = self.saved_state()?;
        let mut sync = reconcile_links(&before, &after, &direct)?;
        let mut placements = HashSet::new();
        for change in &result.changes {
            if change.entity != Entity::Task
                || change.action == Action::Delete
                || change
                    .field("scheduledDate")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                continue;
            }
            let id = change.id.as_deref().unwrap();
            if !placements.insert(id) {
                continue;
            }
            let task = after.tasks.iter().find(|task| task["id"] == id);
            if let Some(task) = task
                && task["scheduledDate"]
                    .as_str()
                    .is_some_and(|date| !date.is_empty())
                && !after.events.iter().any(|event| event["linkedTaskId"] == id)
            {
                // Legacy scheduledDate materializes missing placement. Existing sessions own their dates.
                sync.push(Change::new(
                    Action::Create,
                    Entity::Event,
                    Uuid::new_v4().to_string(),
                    Some(calendar::session_fields(task)),
                ));
            }
        }
        if !sync.is_empty() {
            result.extend(self.apply_direct(&sync, clock)?);
        }
        result.changes = combine_patches(result.changes);
        Ok(result)
    }

    fn apply_direct(&self, changes: &[Change], clock: Option<DateTime<Utc>>) -> Result<Applied> {
        let mut result = Applied {
            descriptions: Vec::new(),
            changes: Vec::new(),
        };
        for change in changes {
            let entity = change.entity;
            let action = change.action;
            let id = match (&change.id, action) {
                (Some(id), _) => id.clone(),
                (None, Action::Create) => Uuid::new_v4().to_string(),
                _ => return Err(anyhow!("An existing item ID is required.")),
            };
            ensure!(
                entity != Entity::Project || id != "inbox" || action == Action::Create,
                "Inbox is the permanent home for unassigned tasks."
            );
            let old = if action != Action::Create {
                Some(self.get(entity, &id)?)
            } else {
                None
            };
            if action == Action::Delete {
                ensure!(
                    change.fields.as_ref().is_none_or(Fields::is_empty),
                    "Delete operations cannot contain fields."
                );
                self.delete_record(entity, &id, old.as_ref().unwrap(), &mut result.descriptions)?;
                result
                    .changes
                    .push(Change::new(action, entity, id, change.fields.clone()));
                continue;
            }
            if action == Action::Create {
                ensure!(!self.exists(entity, &id)?, "That item ID already exists.");
            }
            let mut patch = change
                .fields
                .clone()
                .filter(|fields| !fields.is_empty())
                .ok_or_else(|| anyhow!("Supply the fields to change."))?;
            validate_fields(entity, &mut patch.clone(), true)?;
            if entity == Entity::Event
                && !patch.contains_key("endDate")
                && let Some(old) = &old
                && let Some(start) = patch.get("startDate").and_then(Value::as_str)
            {
                let end = dates::shift_end(
                    field_text(old, "startDate"),
                    field_text(old, "endDate"),
                    start,
                )?;
                patch.insert("endDate".into(), end.into());
            }
            let mut fields = self.defaults(entity, &patch)?;
            if let Some(old) = old.as_ref().and_then(Value::as_object) {
                fields.extend(
                    old.iter()
                        .filter(|(key, _)| {
                            !["id", "createdAt", "completedAt"].contains(&key.as_str())
                        })
                        .map(|(key, value)| (key.clone(), value.clone())),
                );
            }
            fields.extend(patch.clone());
            validate_fields(entity, &mut fields, false)?;
            let mut value = Value::Object(fields);
            value["id"] = id.clone().into();
            if entity == Entity::Task {
                let timestamp = || {
                    clock
                        .unwrap_or_else(|| (self.now)())
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                };
                value["createdAt"] = old
                    .as_ref()
                    .map(|old| old["createdAt"].clone())
                    .unwrap_or_else(|| timestamp().into());
                value["completedAt"] = if value["completed"] == true {
                    old.as_ref()
                        .filter(|old| old["completed"] == true)
                        .map(|old| old["completedAt"].clone())
                        .unwrap_or_else(|| timestamp().into())
                } else {
                    Value::Null
                };
            }
            let category = self.resolve_color(entity, &mut value)?;
            self.reconcile_record(entity, &id, &mut value, old.as_ref())?;
            self.put(entity, value.clone())?;
            result
                .descriptions
                .push(describe(change, &value, category.as_ref())?);
            result
                .changes
                .push(Change::new(action, entity, id, Some(patch)));
        }
        tasks::validate_graph(&self.rows(Entity::Task)?)?;
        Ok(result)
    }

    fn delete_record(
        &self,
        entity: Entity,
        id: &str,
        old: &Value,
        descriptions: &mut Vec<String>,
    ) -> Result<()> {
        match entity {
            Entity::Project | Entity::Section => {
                let reference = if entity == Entity::Project {
                    "projectId"
                } else {
                    "sectionId"
                };
                for mut task in self
                    .rows(Entity::Task)?
                    .into_iter()
                    .filter(|task| task[reference] == id)
                {
                    task["projectId"] = "inbox".into();
                    task["sectionId"] = Value::Null;
                    self.put(Entity::Task, task)?;
                }
                if entity == Entity::Project {
                    self.connection
                        .execute("DELETE FROM sections WHERE project_id=?", [id])?;
                }
            }
            Entity::Category => {
                for kind in [Entity::Task, Entity::Event] {
                    for mut item in self
                        .rows(kind)?
                        .into_iter()
                        .filter(|item| item["categoryId"] == id)
                    {
                        item["categoryId"] = Value::Null;
                        item["colorOverride"] = item["color"].clone();
                        self.put(kind, item)?;
                    }
                }
            }
            Entity::Task => {
                for mut task in self
                    .rows(Entity::Task)?
                    .into_iter()
                    .filter(|task| task["id"] != id)
                {
                    let Some(prerequisites) = task["dependsOnIds"].as_array_mut() else {
                        continue;
                    };
                    let count = prerequisites.len();
                    prerequisites.retain(|prerequisite| prerequisite != id);
                    if prerequisites.len() != count {
                        descriptions.push(format!(
                            "Updated task: {} · removed prerequisite {}",
                            field_text(&task, "title"),
                            field_text(old, "title")
                        ));
                        self.put(Entity::Task, task)?;
                    }
                }
            }
            Entity::Event => {}
        }
        self.delete(entity, id)?;
        descriptions.push(format!(
            "Deleted {}: {}",
            entity.name(),
            field_text(old, "title")
        ));
        Ok(())
    }

    fn defaults(&self, entity: Entity, patch: &Fields) -> Result<Fields> {
        let order = || -> Result<i64> {
            Ok(self
                .rows(entity)?
                .iter()
                .filter_map(|item| item["order"].as_i64())
                .map(|order| order.saturating_add(1))
                .max()
                .unwrap_or(0)
                .max(0))
        };
        let defaults = match entity {
            Entity::Event => json!({
                "kind":"planned","linkedStepId":null,"completed":false,"linkedTaskId":null,"notes":"","textBox":"",
                "color":"coral","categoryId":null,"colorOverride":null,"startTime":null,"endTime":null,
                "endDate":patch.get("startDate"),
            }),
            Entity::Task => json!({
                "notes":"","textBox":"","color":"sage","categoryId":null,"colorOverride":null,"dueDate":null,
                "scheduledDate":null,"completed":false,"projectId":"inbox","sectionId":null,"steps":[],
                "dependsOnIds":[],"order":order()?,
            }),
            Entity::Category => json!({"color":"sky"}),
            Entity::Project | Entity::Section => json!({"order":order()?}),
        };
        Ok(defaults.as_object().unwrap().clone())
    }

    fn resolve_color(&self, entity: Entity, value: &mut Value) -> Result<Option<Value>> {
        if !entity.categorized() {
            return Ok(None);
        }
        let category = value["categoryId"]
            .as_str()
            .map(|id| self.get(Entity::Category, id))
            .transpose()?;
        if !value["colorOverride"].is_null() {
            value["color"] = value["colorOverride"].clone();
        } else if let Some(category) = &category {
            value["color"] = category["color"].clone();
        }
        Ok(category)
    }

    fn reconcile_record(
        &self,
        entity: Entity,
        id: &str,
        value: &mut Value,
        old: Option<&Value>,
    ) -> Result<()> {
        match entity {
            Entity::Event => {
                let start_date = field_text(value, "startDate");
                let end_date = field_text(value, "endDate");
                let start_time = value["startTime"].as_str();
                let end_time = value["endTime"].as_str();
                ensure!(
                    end_date >= start_date,
                    "The event end date must be on or after its start date."
                );
                ensure!(
                    end_time.is_none() || start_time.is_some(),
                    "Add a start time before an end time."
                );
                ensure!(
                    start_date != end_date
                        || !matches!((start_time,end_time), (Some(start),Some(end)) if end <= start),
                    "The end time must be after the start time."
                );
            }
            Entity::Section => {
                self.get(Entity::Project, field_text(value, "projectId"))?;
                if old.is_some_and(|old| old["projectId"] != value["projectId"]) {
                    for mut task in self
                        .rows(Entity::Task)?
                        .into_iter()
                        .filter(|task| task["sectionId"] == id)
                    {
                        task["projectId"] = value["projectId"].clone();
                        self.put(Entity::Task, task)?;
                    }
                }
            }
            Entity::Task => {
                self.get(Entity::Project, field_text(value, "projectId"))?;
                if let Some(section) = value["sectionId"].as_str() {
                    ensure!(
                        self.get(Entity::Section, section)?["projectId"] == value["projectId"],
                        "The selected section belongs to a different project."
                    );
                }
            }
            Entity::Category => {
                if old.is_some_and(|old| old["color"] != value["color"]) {
                    for kind in [Entity::Task, Entity::Event] {
                        for mut item in self.rows(kind)?.into_iter().filter(|item| {
                            item["categoryId"] == id && item["colorOverride"].is_null()
                        }) {
                            item["color"] = value["color"].clone();
                            self.put(kind, item)?;
                        }
                    }
                }
                categories::normalize(value)?;
                if let Some(old) = old {
                    if !old["semanticKey"].is_null() {
                        value["semanticKey"] = old["semanticKey"].clone();
                    }
                    let previous = old["aliases"].as_array().into_iter().flatten();
                    let current = value["aliases"].as_array().into_iter().flatten();
                    let former_title =
                        Value::String(crate::schema::trim(field_text(old, "title")).to_lowercase());
                    let mut unique = HashSet::new();
                    value["aliases"] = Value::Array(
                        previous
                            .chain(current)
                            .chain([&former_title])
                            .filter(|alias| unique.insert((*alias).clone()))
                            .cloned()
                            .collect(),
                    );
                }
            }
            Entity::Project => {}
        }
        Ok(())
    }
}

impl Applied {
    fn extend(&mut self, other: Self) {
        self.descriptions.extend(other.descriptions);
        self.changes.extend(other.changes);
    }
}

fn field_text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or_default()
}

fn describe(change: &Change, value: &Value, category: Option<&Value>) -> Result<String> {
    let verb = if change.entity.categorized()
        && change.action == Action::Update
        && change.field("completed").is_some()
    {
        if value["completed"] == true {
            "Completed"
        } else {
            "Reopened"
        }
    } else if change.action == Action::Create {
        "Added"
    } else {
        "Updated"
    };
    let mut description = format!(
        "{verb} {}: {}",
        change.entity.name(),
        field_text(value, "title")
    );
    if change.entity == Entity::Event {
        let start = field_text(value, "startDate");
        let end = field_text(value, "endDate");
        description.push_str(&format!(" · Date {}", dates::readable_date(start)?));
        if end != start {
            description.push_str(&format!(" → {}", dates::readable_date(end)?));
        }
        if let Some(time) = value["startTime"].as_str() {
            description.push_str(&format!(", {time}"));
            if let Some(end) = value["endTime"].as_str() {
                description.push_str(&format!("–{end}"));
            }
        }
    } else if change.entity == Entity::Task {
        if let Some(due) = value["dueDate"].as_str() {
            description.push_str(&format!(" · Date {}", dates::readable_date(due)?));
        }
        if !value["scheduledDate"].is_null() {
            description.push_str(" · on Calendar");
        }
    }
    if let Some(category) = category
        && (change.action == Action::Create || change.field("categoryId").is_some())
    {
        description.push_str(&format!(" · {}", field_text(category, "title")));
    }
    Ok(description)
}

fn reconcile_links(
    before: &SavedState,
    after: &SavedState,
    changes: &[Change],
) -> Result<Vec<Change>> {
    let mut updates = Vec::new();
    let has_step = |task: &Value, step_id: &str| {
        task["steps"]
            .as_array()
            .is_some_and(|steps| steps.iter().any(|step| step["id"] == step_id))
    };
    for event in &after.events {
        let task_id = event["linkedTaskId"].as_str();
        let step_id = event["linkedStepId"].as_str();
        ensure!(
            step_id.is_none() || task_id.is_some(),
            "A linked step requires a linked task."
        );
        let Some(task_id) = task_id else {
            continue;
        };
        let id = field_text(event, "id");
        let fields = if let Some(task) = after.tasks.iter().find(|task| task["id"] == task_id) {
            let Some(step_id) = step_id.filter(|step_id| !has_step(task, step_id)) else {
                continue;
            };
            let previous = before.tasks.iter().find(|task| task["id"] == task_id);
            let old_event = before.events.iter().find(|event| event["id"] == id);
            ensure!(
                previous.is_some_and(|task| has_step(task, step_id))
                    && old_event.is_some_and(|event| event["linkedStepId"] == step_id),
                "The linked step does not exist on that task."
            );
            json!({"linkedStepId":null})
        } else {
            ensure!(
                changes.iter().any(|change| change.entity == Entity::Task
                    && change.action == Action::Delete
                    && change.id.as_deref() == Some(task_id)),
                "The linked task does not exist."
            );
            json!({"linkedTaskId":null,"linkedStepId":null})
        };
        updates.push(Change::new(
            Action::Update,
            Entity::Event,
            id.into(),
            fields.as_object().cloned(),
        ));
    }
    Ok(updates)
}

fn combine_patches(changes: Vec<Change>) -> Vec<Change> {
    let mut combined: Vec<Change> = Vec::new();
    let mut positions = HashMap::new();
    for change in changes {
        let key = (change.entity, change.id.clone());
        if let Some(&index) = positions.get(&key) {
            let previous: &mut Change = &mut combined[index];
            if change.action == Action::Update {
                previous
                    .fields
                    .get_or_insert_with(Fields::new)
                    .extend(change.fields.unwrap_or_default());
            } else {
                *previous = change;
            }
        } else {
            positions.insert(key, combined.len());
            combined.push(change);
        }
    }
    combined
}
