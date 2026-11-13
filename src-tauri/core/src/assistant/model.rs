//! Schema-constrained model proposals and their server-side grounding. The
//! response is a suggestion, not authority; every change is validated here.
use super::{
    intent::{linked_session, parse_time},
    temporal::{calendar_excluded, commitment, date_evidence, natural_task, task_dates, without_exclusion},
};
use crate::{
    deletion::{Target, normalize, rx},
    pending_draft::{record, uid},
    schema::{Action, Change, Entity},
};
use anyhow::{Result, anyhow, ensure};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
};
use tokio_util::sync::CancellationToken;
pub(super) async fn inference<F, Fut>(
    infer: &F,
    body: Value,
    token: &CancellationToken,
) -> Result<Option<String>>
where
    F: Fn(Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let response = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(anyhow!("Request stopped. No changes saved.")),
        result = infer(body) => result,
    };
    ensure!(!token.is_cancelled(), "Request stopped. No changes saved.");
    Ok(response
        .ok()
        .and_then(|response| response["message"]["content"].as_str().map(str::to_owned)))
}

pub(super) fn chat_body(
    model: &str,
    system: &str,
    user: Value,
    format: Value,
    context: u64,
    predict: u64,
) -> Value {
    json!({"model":model,"messages":[{"role":"system","content":system},{"role":"user","content":user.to_string()}],
        "format":format,"think":false,"keep_alive":-1,"options":{"num_ctx":context,"temperature":0,"num_predict":predict}})
}

pub(super) fn fits(body: &Value, context: u64, predict: u64) -> bool {
    ((body.to_string().len() as u64) / 3) + predict + 256 <= context
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Structured {
    pub(super) changes: Vec<GroundedChange>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GroundedChange {
    pub(super) action: Action,
    pub(super) entity: Entity,
    pub(super) id: Option<String>,
    pub(super) source: String,
    #[serde(default)]
    pub(super) fields: serde_json::Map<String, Value>,
}

pub(super) fn named(text: &str, title: &str) -> bool {
    let title = normalize(title);
    !title.is_empty() && format!(" {text} ").contains(&format!(" {title} "))
}

pub(super) fn title_evidence(source: &str, title: &str) -> bool {
    fn without_determiners(text: &str) -> String {
        normalize(text)
            .split_whitespace()
            .filter(|word| !matches!(*word, "a" | "an" | "the" | "my"))
            .collect::<Vec<_>>()
            .join(" ")
    }
    named(source, title) || named(&without_determiners(source), &without_determiners(title))
}

fn explicit_pair(text: &str) -> bool {
    rx!(r"(?ix)\b(?:
        (?:tasks?|task\s+list)\s+and\s+(?:(?:an?|the|its)\s+)?(?:(?:planned\s+)?(?:calendar\s+)?(?:events?|sessions?|entries|entry)|(?:my|the)\s+calendar)
        | (?:calendar|events?|sessions?|entries|entry)\s+and\s+(?:(?:an?|my|the|its)\s+)?(?:tasks?|task\s+list)
    )\b").is_match(text)
}

fn explicit_task(text: &str) -> bool {
    explicit_pair(text)
        || rx!(r"(?i)^(?:my|the)\s+task\s+(?:for|on)\b").is_match(text)
        || rx!(r"(?i)\b(?:add|create|make|schedule|i (?:need|want|would like))\s+(?:(?:a|one|two|three|four|five|another|the|\d+)\s+)?(?:(?:new|separate)\s+)?tasks?\b").is_match(text)
        || natural_task(text).is_some() && !rx!(r"(?i)\b(?:add|create|make|schedule|record)\s+(?:(?:an?|the)\s+)?(?:calendar\s+)?(?:event|session|entry)\b").is_match(text)
}

fn task_scopes(text: &str) -> Vec<&str> {
    // A fresh commitment starts a new scope. A follow-up like “it's due
    // Friday” stays with the current commitment.
    let starts = rx!(r"(?ix)
        (?:^|[.;]\s+|,\s+(?:and\s+)?|\band\s+)
        (?P<clause>(?:(?:first|next|then|also|finally),?\s+)?
          (?:
            (?:(?:add|create|make|schedule)\s+)?(?:(?:a|one|another|the)\s+)?(?:(?:new|separate)\s+)?task\s+(?:called|named|titled|to|for|on|due)\s+
            | (?:(?:today|tomorrow|yesterday|(?:next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)),?\s+)?i\s+(?:need|want|have)\s+to\s+
          )
        )");
    let mut scopes = Vec::new();
    let mut begin = 0;
    for m in starts.captures_iter(text) {
        let boundary = m.get(0).unwrap();
        if boundary.start() > 0 && (begin > 0 || explicit_task(text[..boundary.start()].trim())) {
            scopes.push(text[begin..boundary.start()].trim());
            begin = m.name("clause").unwrap().start();
        }
    }
    scopes.push(text[begin..].trim());
    scopes
}

pub(super) fn quoted_in(scope: &str, quote: &str) -> bool {
    !quote.trim().is_empty() && scope.to_lowercase().contains(&quote.trim().to_lowercase())
}

fn quoted_in_task(scope: &str, quote: &str) -> bool {
    let quote = rx!(r"(?i)^(?:and|then|also)\s+").replace(quote.trim(), "");
    quoted_in(scope, &quote)
}

fn temporal_clause(scope: &str, title: &str, paired: bool) -> String {
    rx!(r"[.;!?]\s+").split(scope).enumerate().filter_map(|(i, sentence)| {
        (i == 0 || title_evidence(&normalize(sentence), title)
            || rx!(r"(?i)^(?:(?:it['’]s|it is|that task is)\s+due|(?:the\s+)?deadline\s+(?:is|on)|due\s|(?:work on|schedule|put)\s+(?:it|that|this)\b)").is_match(sentence)
            || paired && explicit_pair(sentence))
            .then_some(sentence)
    }).collect::<Vec<_>>().join(". ")
}

fn explicit_task_count(text: &str) -> Option<usize> {
    let count = rx!(r"(?i)\b(?:add|create|make)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:separate|new)\s+)?tasks?\b").captures(text)?;
    count[1].parse().ok().or_else(|| {
        [
            "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        ]
        .iter()
        .position(|word| word.eq_ignore_ascii_case(&count[1]))
        .map(|i| i + 1)
    })
}

fn ground_standalone_events(raw: &Structured, text: &str, command: &regex::Regex) -> Result<()> {
    let mut scopes = Vec::new();
    let mut begin = 0;
    let boundaries = rx!(
        r"(?i)[.;!?]\s+|,?\s+(?:and|then)\s+(?P<next>(?:please\s+)?(?:add|create|make|schedule)\s+)"
    );
    for boundary in boundaries.captures_iter(text) {
        let separator = boundary.get(0).unwrap();
        let clause = &text[begin..separator.start()];
        if command.is_match(clause) {
            scopes.push(clause);
        }
        begin = boundary
            .name("next")
            .map_or(separator.end(), |next| next.start());
    }
    if command.is_match(&text[begin..]) {
        scopes.push(&text[begin..]);
    }
    ensure!(
        scopes.len() == command.find_iter(text).count(),
        "Separate the requested events into distinct clauses."
    );

    let mut claimed = HashSet::new();
    for event in raw.changes.iter().filter(|c| {
        c.action == Action::Create
            && c.entity == Entity::Event
            && c.fields.get("linkedTaskId").is_none_or(Value::is_null)
            && command.is_match(&c.source)
    }) {
        let quote = event.source.trim().trim_end_matches(['.', '!', '?', ';']);
        let mut matching = scopes
            .iter()
            .enumerate()
            .filter(|(_, scope)| quoted_in_task(scope, quote));
        let (index, _) = matching
            .next()
            .ok_or_else(|| anyhow!("An event must quote its own request clause."))?;
        ensure!(
            matching.next().is_none() && claimed.insert(index),
            "Each standalone event must quote a distinct request clause."
        );
    }
    ensure!(
        claimed.len() == scopes.len(),
        "The proposal did not include every distinct requested event."
    );
    Ok(())
}
fn ground_task_dates(raw: &mut Structured, text: &str, today: NaiveDate) -> Result<()> {
    let clean = without_exclusion(text);
    let excluded = calendar_excluded(text);
    let pair = explicit_pair(&clean) && !excluded;
    let scopes = task_scopes(text);
    let requested = explicit_task(&clean);
    let explicit_event = rx!(
        r"(?i)\b(?:add|create|make|schedule|i (?:need|want|would like))\s+(?:(?:an?|the)\s+)?(?:planned\s+)?(?:calendar\s+)?(?:event|session|entry)\b"
    );
    let task_count = raw
        .changes
        .iter()
        .filter(|c| c.entity == Entity::Task && c.action == Action::Create)
        .count();
    if let Some(expected) = explicit_task_count(&clean) {
        ensure!(
            task_count == expected,
            "The proposal did not include the requested number of tasks."
        );
    }
    if requested {
        ensure!(
            task_count == scopes.len(),
            "Every requested task needs its own record."
        );
    } else if explicit_event.is_match(&clean) {
        ensure!(task_count == 0, "An event request cannot create a task.");
    }
    ensure!(
        !excluded
            || raw
                .changes
                .iter()
                .all(|c| c.entity != Entity::Event || c.action != Action::Create),
        "Calendar events were excluded."
    );

    if requested && !pair && !excluded {
        ground_standalone_events(raw, &clean, explicit_event)?;
    }
    let mut tasks = HashMap::new();
    let mut used_scopes = HashSet::new();
    for c in raw
        .changes
        .iter_mut()
        .filter(|c| c.entity == Entity::Task && c.action == Action::Create)
    {
        let title = c
            .fields
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let source = normalize(commitment(&c.source));
        ensure!(title_evidence(&source, &title) && !rx!(r"(?i)^(?:it|that|this|tasks?|events?|calendar|all day|today|tomorrow|yesterday)$").is_match(&title), "A specific task title is required.");
        let mut matching = scopes
            .iter()
            .enumerate()
            .filter(|(_, scope)| quoted_in_task(scope, &c.source));
        let (index, scope) = matching
            .next()
            .ok_or_else(|| anyhow!("The task must quote its own clause."))?;
        ensure!(
            matching.next().is_none() && used_scopes.insert(index),
            "Each task must quote a distinct clause."
        );
        let paired = pair && (scopes.len() == 1 || explicit_pair(scope));
        let temporal = temporal_clause(commitment(scope), &title, paired);
        let dates = task_dates(&without_exclusion(&temporal), today, excluded)
            .ok_or_else(|| anyhow!("The task has ambiguous temporal evidence."))?;
        ensure!(
            dates.start.is_none() || dates.day.is_some(),
            "A timed task needs a work date."
        );
        ensure!(
            !paired || dates.day.is_some(),
            "The requested pair needs a work date."
        );
        if let Some(due) = c.fields.get("dueDate").filter(|due| !due.is_null()) {
            ensure!(
                *due == json!(dates.due),
                "A task deadline needs its own deadline wording."
            );
        }
        c.fields.insert("dueDate".into(), json!(dates.due));
        let id = c.id.get_or_insert_with(uid).clone();
        ensure!(
            tasks.insert(id, (title, *scope, dates, paired)).is_none(),
            "Duplicate task identifier."
        );
    }

    let mut used_links = HashSet::new();
    for c in raw
        .changes
        .iter_mut()
        .filter(|c| c.entity == Entity::Event && c.action == Action::Create)
    {
        let link = c.fields.get("linkedTaskId").and_then(Value::as_str);
        let event_title = c.fields.get("title").and_then(Value::as_str).map(normalize);
        let candidate = if let Some(id) = link {
            tasks.get_key_value(id)
        } else {
            let mut matching = tasks.iter().filter(|(_, (title, scope, _, paired))| {
                *paired
                    && event_title.as_ref() == Some(&normalize(title))
                    && quoted_in_task(scope, &c.source)
            });
            let first = matching.next();
            ensure!(matching.next().is_none(), "The event's task is ambiguous.");
            first
        };
        let Some((id, (title, scope, dates, paired))) = candidate else {
            ensure!(
                tasks.is_empty() && !pair
                    || link.is_none()
                        && explicit_event.is_match(&c.source)
                        && !tasks.values().any(|(title, _, _, paired)| *paired
                            || event_title.as_ref() == Some(&normalize(title))),
                "The requested calendar event must link to its own task."
            );
            continue;
        };
        ensure!(
            dates.day.is_some()
                && quoted_in_task(scope, &c.source)
                && used_links.insert(id.clone()),
            "An event must use its task's own work clause."
        );
        ensure!(
            event_title.as_ref() == Some(&normalize(title)),
            "A paired event must describe its task."
        );
        let title_in_quote = title_evidence(&normalize(&c.source), title);
        ensure!(
            title_in_quote || *paired && explicit_event.is_match(&c.source),
            "The event source is not grounded."
        );
        if !title_in_quote {
            c.source = (*scope).to_owned();
        }
        c.fields.insert("linkedTaskId".into(), json!(id));
        for (field, value) in [
            ("startDate", json!(dates.day)),
            ("endDate", json!(dates.day)),
            ("startTime", json!(dates.start)),
            ("endTime", json!(dates.end)),
            ("kind", json!("planned")),
        ] {
            if let Some(supplied) = c.fields.get(field).filter(|value| !value.is_null()) {
                ensure!(
                    *supplied == value,
                    "The event must use the work date and time in its task's clause."
                );
            }
            c.fields.insert(field.into(), value);
        }
    }

    for (id, (title, scope, dates, _)) in tasks {
        if dates.day.is_none() || used_links.contains(&id) {
            continue;
        }
        let session = linked_session(&title, &id, &dates).unwrap();
        raw.changes.push(GroundedChange {
            action: Action::Create,
            entity: Entity::Event,
            id: None,
            fields: session.fields.unwrap(),
            source: scope.to_owned(),
        });
    }
    ensure!(raw.changes.len() <= 32, "Too many proposed records.");
    Ok(())
}

pub(super) fn ground_changes(
    content: &str,
    text: &str,
    items: &[Target],
    selected: Option<&Target>,
    today: NaiveDate,
    snapshot: &Value,
) -> Result<Vec<Change>> {
    let mut raw: Structured = serde_json::from_str(content)?;
    ensure!(
        (1..=32).contains(&raw.changes.len()),
        "No usable planner changes."
    );
    ensure!(
        raw.changes.iter().all(|change| change.action != Action::Delete),
        "Delete changes are validated separately."
    );
    ground_task_dates(&mut raw, text, today)?;
    let mut temporary = HashMap::<(Entity, String), (String, String)>::new();
    for c in raw.changes.iter().filter(|c| c.action == Action::Create) {
        if let Some(key) = &c.id {
            ensure!(
                !key.is_empty() && key.len() <= 100 && !items.iter().any(|item| item.id == *key),
                "Invalid temporary record ID."
            );
            let title = c
                .fields
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            ensure!(
                temporary
                    .insert((c.entity, key.clone()), (uid(), title))
                    .is_none(),
                "Duplicate temporary record ID."
            );
        }
    }
    let mut seen_updates = HashSet::new();
    raw.changes.into_iter().map(|mut change| {
        let source = normalize(&change.source);
        let new_link = change.action == Action::Create && change.entity == Entity::Event &&
            change.fields.get("linkedTaskId").and_then(Value::as_str)
                .is_some_and(|id| temporary.contains_key(&(Entity::Task, id.to_owned())));
        let grounded_dates = new_link || change.action == Action::Create && change.entity == Entity::Task;
        ensure!(change.source.len() <= 2500 && !source.is_empty() && quoted_in(text, &change.source), "A change did not quote the request.");
        ensure!(matches!(change.action, Action::Create | Action::Update), "Unsupported action.");
        ensure!(matches!(change.entity, Entity::Task | Entity::Event | Entity::Project | Entity::Section), "Unsupported entity.");
        let linked_task_title: Option<String> = if change.action == Action::Create
            && change.entity == Entity::Event
        {
            change
                .fields
                .get("linkedTaskId")
                .and_then(Value::as_str)
                .and_then(|task_id| {
                    items
                        .iter()
                        .find(|item| item.entity == Entity::Task && item.id == task_id)
                })
                .map(|task| task.title.clone())
        } else {
            None
        };
        let id = if change.action == Action::Create {
            let title = change.fields.get("title").and_then(Value::as_str).ok_or_else(|| anyhow!("A title is required."))?;
            ensure!(title_evidence(&source, title) || linked_task_title.is_some(), "The proposed title did not occur in its source.");
            if let Some(task_title) = &linked_task_title {
                ensure!(normalize(title) == normalize(task_title), "A linked session must describe its task.");
            }
            change.id.as_ref().and_then(|key| temporary.get(&(change.entity, key.clone()))).map_or_else(uid, |(id, _)| id.clone())
        } else {
            let id = change.id.as_ref().ok_or_else(|| anyhow!("A verified target is required."))?;
            let item = items.iter().find(|item| item.id == *id && item.entity == change.entity).ok_or_else(|| anyhow!("Unknown record."))?;
            let same = items.iter().filter(|other| other.entity == item.entity && normalize(&other.title) == normalize(&item.title)).count();
            ensure!(Some(item) == selected || named(&source, &item.title) && same == 1, "A unique named or selected target is required.");
            ensure!(seen_updates.insert((change.entity, id.clone())), "Duplicate updates.");
            id.clone()
        };
        if matches!(change.entity, Entity::Project | Entity::Section) {
            ensure!(rx!(r"(?i)\b(?:project|section)\b").is_match(&source), "Organization must be requested.");
        }
        if change.action == Action::Create && change.entity == Entity::Event {
            let linked_existing = change.fields.get("linkedTaskId").and_then(Value::as_str)
                .is_some_and(|id| items.iter().any(|item| item.entity == Entity::Task && item.id == id));
            ensure!(new_link || linked_existing || rx!(r"(?i)\b(?:event|calendar|schedule|session|meeting|appointment|record|exam)\b").is_match(&source), "Calendar placement must be requested.");
            ensure!(change.fields.get("startDate").is_some_and(Value::is_string), "The event date is missing.");
        }
        for (field, value) in &mut change.fields {
            let string = value.as_str().unwrap_or_default();
            match field.as_str() {
                "title" => ensure!(title_evidence(&source, string) || linked_task_title.as_ref().is_some_and(|task_title| normalize(string) == normalize(task_title)), "Title evidence is missing."),
                "dueDate" | "startDate" | "endDate" if grounded_dates => {
                    ensure!(change.entity == Entity::Task && field == "dueDate" || new_link && field != "dueDate", "The date field belongs to a different record.");
                }
                "dueDate" | "startDate" | "endDate" => {
                    if value.is_null() {
                        ensure!(field == "dueDate" && (change.action == Action::Create || rx!(r"(?i)\b(?:clear|remove|no)\b.*\b(?:date|deadline)\b").is_match(&source)), "A date cannot be cleared implicitly.");
                    } else {
                        ensure!(date_evidence(&change.source, today, string), "The date did not occur in its source.");
                        if field == "dueDate" && change.action == Action::Create {
                            ensure!(rx!(r"(?i)\b(?:due|deadline|by|before|submit)\b").is_match(&source), "Deadline wording is missing.");
                        }
                    }
                }
                "startTime" | "endTime" if new_link => {}
                "startTime" | "endTime" => {
                    ensure!(value.is_null() && change.action == Action::Create || rx!(r"(?i)\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b").find_iter(&change.source).any(|m| parse_time(m.as_str()).as_deref() == Some(string)), "The time did not occur in its source.");
                }
                "completed" => {
                    let completion = value.as_bool().ok_or_else(|| anyhow!("Completion must be a boolean."))?;
                    ensure!(change.entity == Entity::Task && change.action == Action::Update &&
                        (completion && rx!(r"(?i)\b(?:complete|completed|done|check off)\b").is_match(&source)
                            || !completion && rx!(r"(?i)\b(?:reopen|incomplete|not done)\b").is_match(&source)), "Completion must be explicitly requested.");
                }
                "notes" => ensure!(named(&source, string) && rx!(r"(?i)\b(?:notes?|description)\b").is_match(&source), "The proposed notes were not requested."),
                "kind" => ensure!(string == "planned" || string == "actual" && rx!(r"(?i)\b(?:record|log|actual)\b").is_match(&source), "Actual activity must be requested."),
                "projectId" | "linkedTaskId" => {
                    if !value.is_null() {
                        let entity = if field == "projectId" { Entity::Project } else { Entity::Task };
                        let evidence = if field == "projectId" { rx!(r"(?i)\b(?:project|under|into|in)\b") } else { rx!(r"(?i)\b(?:calendar|schedule|linked|session)\b") };
                        let resolves_existing = field == "linkedTaskId"
                            && items.iter().any(|item| item.entity == entity && item.id == string);
                        ensure!(new_link && field == "linkedTaskId" || resolves_existing || evidence.is_match(&source), "An explicit relationship is required.");
                        if let Some((id, title)) = temporary.get(&(entity, string.to_owned())) {
                            ensure!(new_link && field == "linkedTaskId" || named(&source, title), "The temporary reference is absent from the source.");
                            *value = id.clone().into();
                        } else {
                            let target = items.iter().find(|item| item.entity == entity && item.id == string).ok_or_else(|| anyhow!("Unknown linked record."))?;
                            ensure!(Some(target) == selected || named(&source, &target.title) && items.iter().filter(|item| item.entity == entity && normalize(&item.title) == normalize(&target.title)).count() == 1, "Ambiguous linked record.");
                        }
                    }
                }
                "steps" => {
                    ensure!(change.entity == Entity::Task && rx!(r"(?i)\b(?:steps?|checklist|subtasks?)\b").is_match(&source), "Checklist steps must be requested for the task.");
                    let previous: Vec<Value> = if change.action == Action::Update {
                        record(snapshot, Entity::Task, &id)
                            .and_then(|row| row["steps"].as_array().cloned())
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    let steps = value.as_array().ok_or_else(|| anyhow!("Invalid steps."))?.iter().map(|step| {
                        let title = step.as_str().ok_or_else(|| anyhow!("Invalid step title."))?;
                        let reused = previous.iter().find(|old| old["title"].as_str().is_some_and(|old_title| normalize(old_title) == normalize(title)));
                        ensure!(reused.is_some() || named(&source, title), "Each step must come from the request.");
                        let title = title.chars().next().map(|first| first.to_uppercase().collect::<String>() + &title[first.len_utf8()..]).unwrap_or_default();
                        let (step_id, completed) = reused
                            .map(|old| (old["id"].clone(), old["completed"].clone()))
                            .unwrap_or((uid().into(), false.into()));
                    Ok(json!({"id":step_id,"title":title,"completed":completed}))
                    }).collect::<Result<Vec<_>>>()?;
                    *value = json!(steps);
                }
                _ => anyhow::bail!("The proposal contains an unsupported field."),
            }
        }
        Ok(Change::new(change.action, change.entity, id, Some(change.fields)))
    }).collect()
}

