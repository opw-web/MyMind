use super::{
    ChatInput, reply,
    temporal::{
        TaskDates, blocked, calendar_excluded, commitment, natural_task, put_on_calendar,
        task_dates, task_subject, without_exclusion,
    },
};
use crate::{
    deletion::{Target, date_token, normalize, rx},
    pending_draft::{Turn, record, uid},
    schema::{Action, Change, Entity, length},
};
use chrono::NaiveDate;
use serde_json::{Value, json};

pub(super) enum Simple {
    Changes(Vec<Change>),
    MissingDate(String),
}

fn create(entity: Entity, fields: Value) -> Change {
    Change::new(Action::Create, entity, uid(), fields.as_object().cloned())
}

pub(super) fn simple_creation(text: &str, today: NaiveDate) -> Option<Simple> {
    if blocked(text) {
        return None;
    }
    let excluded = calendar_excluded(text);
    let clean = without_exclusion(text);
    let clean = clean.trim().trim_end_matches(['.', '!', '?']);
    let text = commitment(clean);
    if text.len() < clean.len()
        && rx!(r"(?i)\b(?:add|create|make|schedule|delete|remove|then)\b")
            .is_match(&clean[text.len()..])
    {
        return None;
    }
    if let Some(c) = rx!(r"(?i)^(?:please\s+)?schedule\s+(work\s+on\s+.+?)(?:[,.;]\s*(?:and\s+)?(?:the|this|that)\s+task\s+(?:must|has to|needs to)\s+be\s+(?:finished|completed|done|submitted)\s+((?:by|before)\s+.+))?$").captures(text) {
        let subject = task_subject(&c[1]);
        if !rx!(r"(?i)\b(?:and|then|plus|but|today|tomorrow|due|yesterday|at|until)\b|[,;.!?]").is_match(subject)
            && c.get(2).is_none_or(|deadline| task_subject(&format!("work {}", deadline.as_str())) == "work")
        {
            let dates = task_dates(text, today, excluded)?;
            if dates.day.is_some() || excluded {
                return create_task(subject, &dates);
            }
            return Some(Simple::MissingDate(capitalize(subject)?));
        }
    }
    if let Some((title, tail)) = put_on_calendar(text) {
        if excluded
            || title.is_empty()
            || length(title) > 240
            || rx!(r"(?i)\b(?:it|that|this|and|plus|task|then)\b|[.;!?]").is_match(title)
            || !task_subject(&format!("event {tail}")).eq_ignore_ascii_case("event")
        {
            return None;
        }
        return simple_creation(
            &format!("Add a calendar event called {title} {tail}"),
            today,
        );
    }
    if rx!(r"(?i)\b(and|plus|through|between|every|recurring|section|category|notes|color)\b|[?!].+\S|\.\s").is_match(text)
        || rx!(r"(?i)\b(?:in|under|for) (?:the |my )?project\b").is_match(text) { return None; }
    let prefix = rx!(r"(?i)^(?:(?:please|also)\s+)*(?:(?:can|could|would) you\s+)?(add|create|make|schedule)\s+(?:(?:a|an|the)\s+)?").captures(text);
    let natural = natural_task(text);
    if let Some(body) = natural.filter(|body| rx!(r"(?i)^(?:add|create|make|schedule)\s+(?:(?:a|an|the)\s+)?(?:planned\s+)?(?:calendar\s+)?(?:event|session)\b").is_match(body)) {
        if task_dates(body, today, excluded)?.day.is_some() && !excluded {
            return simple_creation(body, today);
        }
        return None;
    }
    let submit = rx!(r"(?i)^submit\b").is_match(text);
    if prefix.is_none() && !submit && natural.is_none() {
        return None;
    }
    let schedule = prefix
        .as_ref()
        .is_some_and(|m| m[1].eq_ignore_ascii_case("schedule"));
    let body = prefix.as_ref().map_or_else(
        || natural.unwrap_or(text),
        |m| &text[m.get(0).unwrap().end()..],
    );
    let explicit_task = rx!(r"(?i)^task\b|\btask$").is_match(body);
    let explicit_event = rx!(r"(?i)^(?:planned )?(?:calendar )?event\b|\bevent$").is_match(body);
    let dates = task_dates(text, today, excluded)?;
    let body = task_subject(body);
    let body =
        rx!(r"(?i)^(?:task|(?:planned )?(?:calendar )?event)\s+(?:(?:called|named|titled|to)\s+)?")
            .replace(body, "");
    let body = rx!(r"(?i)\s+(?:event|task)$").replace(&body, "");
    let body = body.trim().trim_matches(['"', '“', '”']);
    let work_head = rx!(r"(?i)^(?:buy|write|read|finish|prepare|prep|study|submit|build|print|3d print|pay|pick up|complete|file|mend)\b").is_match(body);
    let work_noun = rx!(r"(?i)\b(?:assignment|homework|worksheet|essay|prototype|packaging|submission|report|groceries|notebooks)\b").is_match(body);
    let event_noun = rx!(r"(?i)\b(?:exam|appointment|meeting|dentist|interview|workshop|lecture|class|seminar|lesson|flight|party|birthday|concert|trip|holiday)\b").is_match(body);
    if !explicit_task
        && !explicit_event
        && !submit
        && !work_head
        && !work_noun
        && !event_noun
        && !schedule
    {
        return None;
    }
    if body.is_empty() || length(body) > 240 || rx!(r"(?i)^(?:task|event|it|that|this)$|\b(?:today|tomorrow|yesterday|due|next|at|but|then|except|from|until)\b|[,;:]").is_match(body) { return None; }
    let title = capitalize(body)?;
    let event = !explicit_task
        && !submit
        && natural.is_none()
        && (explicit_event || !work_head && (event_noun || schedule));
    if event && excluded {
        return None;
    }
    if (event || schedule && !excluded) && dates.day.is_none() && dates.due.is_none() {
        return Some(Simple::MissingDate(title));
    }
    if event {
        let date = dates.day.as_ref().or(dates.due.as_ref())?;
        return Some(Simple::Changes(vec![create(
            Entity::Event,
            json!({"title":title,"startDate":date,"endDate":date,"startTime":dates.start,"endTime":dates.end}),
        )]));
    }
    if dates.start.is_some() && dates.day.is_none() {
        return None;
    }
    create_task(&title, &dates)
}

fn capitalize(text: &str) -> Option<String> {
    let first = text.chars().next()?;
    Some(first.to_uppercase().collect::<String>() + &text[first.len_utf8()..])
}

fn create_task(title: &str, dates: &TaskDates) -> Option<Simple> {
    let title = capitalize(title)?;
    if length(&title) > 240 {
        return None;
    }
    let task = create(Entity::Task, json!({"title":title,"dueDate":dates.due}));
    let session = linked_session(&title, task.id.as_deref()?, dates);
    Some(Simple::Changes(
        std::iter::once(task).chain(session).collect(),
    ))
}
pub(super) fn linked_session(title: &str, task_id: &str, dates: &TaskDates) -> Option<Change> {
    let day = dates.day.as_ref()?;
    Some(create(
        Entity::Event,
        json!({
            "title":title,"kind":"planned","startDate":day,"endDate":day,
            "startTime":dates.start,"endTime":dates.end,"linkedTaskId":task_id
        }),
    ))
}

pub(super) fn existing_work(
    text: &str,
    items: &[Target],
    selected: Option<&Target>,
    today: NaiveDate,
) -> Option<Result<Vec<Change>, &'static str>> {
    let excluded = calendar_excluded(text);
    let clean = without_exclusion(text);
    let request = rx!(
        r"(?i)^(?:please\s+)?work on\s+(.+?)(?:\.\s+(?:it['’]s|it is|that task is)\s+due\s+.+)?$"
    )
    .captures(&clean)?;
    let clarify = || Err("Which task should I schedule? Give me its title and the date.");
    if blocked(text) {
        return Some(clarify());
    }
    let subject = task_subject(&request[1]).trim_matches(['"', '“', '”']);
    let name = normalize(subject);
    let name = name
        .strip_prefix("the ")
        .or_else(|| name.strip_prefix("my "))
        .unwrap_or(&name);
    let target = if matches!(name, "it" | "that" | "this" | "that task" | "this task") {
        selected.filter(|item| item.entity == Entity::Task)
    } else {
        let mut matches = items
            .iter()
            .filter(|item| item.entity == Entity::Task && normalize(&item.title) == name);
        let first = matches.next();
        if matches.next().is_some() {
            selected.filter(|item| item.entity == Entity::Task && normalize(&item.title) == name)
        } else {
            first
        }
    };
    let (Some(target), Some(dates)) = (target, task_dates(&clean, today, excluded)) else {
        return Some(clarify());
    };
    let task = dates.due.as_ref().map(|date| {
        Change::new(
            Action::Update,
            Entity::Task,
            target.id.clone(),
            json!({"dueDate":date}).as_object().cloned(),
        )
    });
    let session = linked_session(&target.title, &target.id, &dates);
    let changes: Vec<_> = task.into_iter().chain(session).collect();
    Some(if changes.is_empty() {
        clarify()
    } else {
        Ok(changes)
    })
}

pub(super) fn parse_time(raw: &str) -> Option<String> {
    let c = rx!(r"(?i)^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$").captures(raw.trim())?;
    let hour: u8 = c[1].parse().ok()?;
    let minute = c
        .get(2)
        .map_or(Some(0), |m| m.as_str().parse::<u8>().ok())?;
    let hour = match c.get(3) {
        Some(m) if (1..=12).contains(&hour) => {
            hour % 12
                + if m.as_str().eq_ignore_ascii_case("pm") {
                    12
                } else {
                    0
                }
        }
        None if c.get(2).is_some() && hour < 24 => hour,
        _ => return None,
    };
    (minute < 60).then(|| format!("{hour:02}:{minute:02}"))
}

pub(super) fn existing_session(
    mut changes: Vec<Change>,
    items: &[Target],
    selected: Option<&Target>,
) -> Result<Vec<Change>, &'static str> {
    if changes.len() == 2 && changes[0].entity == Entity::Task && changes[1].entity == Entity::Event
    {
        let title = changes[0]
            .field("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let same = items
            .iter()
            .filter(|item| {
                item.entity == Entity::Task && normalize(&item.title) == normalize(title)
            })
            .collect::<Vec<_>>();
        let task = selected
            .filter(|selection| same.contains(selection))
            .or_else(|| {
                if same.len() == 1 {
                    same.first().copied()
                } else {
                    None
                }
            });
        if let Some(task) = task {
            let due = changes[0]
                .field("dueDate")
                .and_then(Value::as_str)
                .map(str::to_owned);
            changes.remove(0);
            changes[0]
                .fields
                .as_mut()
                .unwrap()
                .insert("linkedTaskId".into(), json!(task.id));
            if let Some(due) = due {
                changes.insert(
                    0,
                    Change::new(
                        Action::Update,
                        Entity::Task,
                        task.id.clone(),
                        json!({"dueDate":due}).as_object().cloned(),
                    ),
                );
            }
        } else if same.len() > 1 {
            return Err(
                "I found several tasks with that title. Select the one you want to schedule.",
            );
        }
    }
    Ok(changes)
}

pub(super) fn creation_answer(
    input: &ChatInput,
    turn: &Turn<'_>,
    today: NaiveDate,
) -> Option<Vec<Change>> {
    let issue = if let Some(id) = &input.clarification_issue_id {
        turn.issues.iter().find(|issue| issue.id() == id)?
    } else {
        let matching = turn
            .issues
            .iter()
            .filter(|issue| {
                issue.field == "startDate"
                    && issue
                        .source
                        .as_ref()
                        .is_some_and(|title| normalize(&input.text).contains(&normalize(title)))
            })
            .collect::<Vec<_>>();
        if matching.len() == 1 && rx!(r"(?i)^(?:please\s+)?schedule\b").is_match(input.text.trim()) { matching[0] }
        else if turn.issues.len() == 1 && rx!(r"(?i)^(?:on\s+)?(?:\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:[.!]?$|\s+(?:at|from)\b)").is_match(input.text.trim()) { &turn.issues[0] }
        else { return None; }
    };
    if issue.field != "startDate" || rx!(r"(?i)^(?:when|why|how|show|list)\b|\b(?:another|separate|different|do not|don't|instead)\b").is_match(input.text.trim()) { return None; }
    let title = issue.source.as_ref()?;
    let text = input.text.trim();
    let start = rx!(r"(?i)\b(?:\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b").find(text)?;
    let Simple::Changes(mut changes) = simple_creation(
        &format!("Add an event called {title} on {}", &text[start.start()..]),
        today,
    )?
    else {
        return None;
    };
    changes[0].id = Some(issue.target_id()?.to_owned());
    Some(changes)
}

pub(super) fn read(
    text: &str,
    snapshot: &Value,
    items: &[Target],
    today: NaiveDate,
    pending: bool,
) -> Option<(Value, Vec<Target>)> {
    if !rx!(r"(?i)^(?:please\s+)?(?:show|list|find|search|what (?:is|are|do|have|tasks?|events?|sessions?|deadlines?|projects?)|what['’]s|which|when (?:is|are|do)|do i have|how many)\b").is_match(text)
        || rx!(r"(?i)\b(?:add|create|delete|remove|rename|update|undo)\b").is_match(text) { return None; }
    let entity = if rx!(r"(?i)\b(?:tasks?|deadlines?|due)\b").is_match(text) {
        Some(Entity::Task)
    } else if rx!(r"(?i)\b(?:events?|sessions?|calendar)\b").is_match(text) {
        Some(Entity::Event)
    } else if rx!(r"(?i)\bprojects?\b").is_match(text) {
        Some(Entity::Project)
    } else {
        None
    };
    let date_words = rx!(
        r"(?i)\b(?:today|tomorrow|yesterday|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})\b"
    );
    let day = date_words
        .find(text)
        .and_then(|m| date_token(m.as_str(), today))
        .map(|d| d.to_string());
    let scheduled = rx!(r"(?i)\b(?:scheduled|on (?:my|the) calendar)\b").is_match(text);
    let deadline = rx!(r"(?i)\b(?:deadlines?|due)\b").is_match(text);
    let completion = if rx!(r"(?i)\b(?:incomplete|open|unfinished|not completed)\b").is_match(text)
    {
        Some(false)
    } else if rx!(r"(?i)\b(?:completed|done|finished)\b").is_match(text) {
        Some(true)
    } else {
        None
    };
    let stop = "please show list find search what what's which when is are do i have my the a an tasks task deadlines deadline due events event sessions session calendar projects project planner on for me scheduled all any how many in completed done finished incomplete open unfinished not";
    let query = normalize(&date_words.replace_all(text, ""));
    let terms = query
        .split_whitespace()
        .filter(|word| {
            !stop.split_whitespace().any(|w| w == *word)
                && !word.chars().all(|ch| ch.is_ascii_digit())
        })
        .collect::<Vec<_>>();
    let event_spans = |event: &Value, date: Option<&str>| {
        date.is_none_or(|day| {
            event["startDate"].as_str().is_some_and(|d| d <= day)
                && event["endDate"].as_str().is_some_and(|d| d >= day)
        })
    };
    let found = items
        .iter()
        .filter(|item| {
            if !entity.map_or_else(
                || matches!(item.entity, Entity::Task | Entity::Event),
                |entity| item.entity == entity,
            ) {
                return false;
            }
            let Some(row) = record(snapshot, item.entity, &item.id) else {
                return false;
            };
            if completion.is_some_and(|completed| row["completed"].as_bool() != Some(completed)) {
                return false;
            }
            let day = day.as_deref();
            let fits_date = match item.entity {
                Entity::Task => {
                    let due = day.is_none_or(|day| row["dueDate"] == day);
                    let on_calendar = || {
                        snapshot["events"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|event| {
                                event["kind"] == "planned"
                                    && event["linkedTaskId"] == item.id
                                    && event_spans(event, day)
                            })
                    };
                    if scheduled {
                        on_calendar()
                    } else if deadline {
                        due && row["dueDate"].is_string()
                    } else {
                        due || on_calendar()
                    }
                }
                Entity::Event => event_spans(row, day),
                _ => day.is_none(),
            };
            fits_date
                && terms.iter().all(|word| {
                    normalize(&item.title).contains(word)
                        || row["notes"]
                            .as_str()
                            .is_some_and(|notes| normalize(notes).contains(word))
                })
        })
        .collect::<Vec<_>>();
    let qualifier = if pending {
        " in your planner, including unsaved proposals"
    } else {
        " in your planner"
    };
    let mut content = format!(
        "I found {} matching item{}{qualifier}.",
        found.len(),
        if found.len() == 1 { "" } else { "s" }
    );
    for target in found.iter().take(20) {
        let item = record(snapshot, target.entity, &target.id)?;
        let date = item["startDate"]
            .as_str()
            .or_else(|| item["dueDate"].as_str())
            .unwrap_or_default();
        content += &format!(
            "\n- {} ({}){}",
            target.title,
            target.entity.name(),
            if date.is_empty() {
                String::new()
            } else {
                format!(" — {date}")
            }
        );
    }
    Some((
        reply(content),
        found.into_iter().take(20).cloned().collect(),
    ))
}

pub(super) fn simple_edit(
    text: &str,
    snapshot: &Value,
    items: &[Target],
    selected: Option<&Target>,
    today: NaiveDate,
) -> Option<Vec<Change>> {
    let text = text.trim().trim_end_matches(['.', '!', '?']);
    // These explicit safeguards protect other records; the primary update
    // still has to resolve on its own.
    let text = rx!(r"(?i)\.\s+(?:keep its linked task unchanged|do not delete it(?: or change its calendar session)?)$").replace(text, "");
    let text = text.as_ref();
    if let Some(c) = rx!(r"(?i)^(?:please\s+)?(?:move|reschedule)\s+(?:(?:my|the)\s+)?(.+?)\s+to\s+(\d{4}-\d{2}-\d{2})\s+from\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$").captures(text) {
        let name = normalize(&c[1]);
        let date = date_token(&c[2], today)?.to_string();
        let start = parse_time(&c[3])?;
        let end = parse_time(&c[4])?;
        if end <= start { return None; }
        let targets = items.iter().filter(|item| {
            item.entity == Entity::Event && normalize(&item.title) == name
                && record(snapshot, Entity::Event, &item.id).is_some_and(|event| event["kind"] == "planned")
        }).collect::<Vec<_>>();
        let [item] = targets.as_slice() else { return None; };
        return Some(vec![Change::new(Action::Update, Entity::Event, item.id.clone(), json!({
            "startDate":date, "endDate":date, "startTime":start, "endTime":end
        }).as_object().cloned())]);
    }
    if let Some(c) = rx!(r"(?i)^(?:please\s+)?add (?:a|one) (?:checklist )?step to (?:(?:my|the)\s+)?([^:]+):\s+(.+)$").captures(text) {
        let subject = rx!(r"(?i)\s+task$").replace(c[1].trim(), "");
        let subject = normalize(subject.trim_matches(['"', '“', '”']));
        let title = c[2].trim().trim_matches(['"', '“', '”']);
        if title.is_empty() || length(title) > 240 || rx!(r"(?i)[;]|[.!?]\s+(?:and|then|add|create|remove|delete|move)\b").is_match(title) {
            return None;
        }
        let candidates = items.iter().filter(|item| item.entity == Entity::Task && normalize(&item.title) == subject).collect::<Vec<_>>();
        let target = selected.filter(|item| item.entity == Entity::Task && (candidates.contains(item) || matches!(subject.as_str(), "it" | "this" | "that")))
            .or_else(|| match candidates.as_slice() { [item] => Some(*item), _ => None })?;
        let mut steps = record(snapshot, Entity::Task, &target.id)?["steps"].as_array()?.clone();
        steps.push(json!({"id":uid(),"title":title,"completed":false}));
        return Some(vec![Change::new(Action::Update, Entity::Task, target.id.clone(), json!({"steps":steps}).as_object().cloned())]);
    }
    let complete = rx!(r"(?i)^(?:please\s+)?(complete|reopen|check off|mark)\s+(?:the\s+)?(.+?)(?:\s+(?:as\s+)?(completed|complete|done|open|incomplete))?$").captures(text);
    let rename = rx!(r"(?i)^(?:please\s+)?rename\s+(?:the\s+)?(.+?)\s+to\s+(.+)$").captures(text);
    let deadline = rx!(r"(?i)^(?:please\s+)?(?:set|change|move)\s+(?:the\s+)?(.+?)(?:['’]s\s+deadline|\s+deadline|\s+due date)\s+to\s+(.+)$").captures(text);
    let (name, fields, only_task) = if let Some(c) = complete {
        let word = c[1].to_ascii_lowercase();
        if word == "mark" && c.get(3).is_none() {
            return None;
        }
        (
            c[2].to_owned(),
            json!({"completed":word != "reopen" && c.get(3).is_none_or(|m| !matches!(m.as_str().to_ascii_lowercase().as_str(),"open"|"incomplete"))}),
            false,
        )
    } else if let Some(c) = rename {
        (
            c[1].to_owned(),
            json!({"title":c[2].trim_matches(['"', '“', '”'])}),
            false,
        )
    } else if let Some(c) = deadline {
        let date = date_token(&c[2], today)?;
        (c[1].to_owned(), json!({"dueDate":date.to_string()}), true)
    } else {
        return None;
    };
    if rx!(r"(?i)\b(?:and|then|except|but|all|every|both)\b").is_match(&name) {
        return None;
    }
    let scope = rx!(r"(?i)\s+(task|event|project|section)$").captures(&name);
    let subject = scope
        .as_ref()
        .map_or(name.as_str(), |m| &name[..m.get(0).unwrap().start()]);
    let scope = scope.map(|m| m[1].to_ascii_lowercase());
    let candidates = items
        .iter()
        .filter(|item| {
            (!only_task || item.entity == Entity::Task)
                && scope
                    .as_ref()
                    .is_none_or(|scope| item.entity.name() == scope)
                && normalize(&item.title) == normalize(subject.trim_matches(['"', '“', '”']))
        })
        .collect::<Vec<_>>();
    let target = selected
        .filter(|item| {
            (!only_task || item.entity == Entity::Task)
                && scope
                    .as_ref()
                    .is_none_or(|scope| item.entity.name() == scope)
                && (candidates.contains(item)
                    || matches!(normalize(subject).as_str(), "it" | "this" | "that"))
        })
        .or_else(|| {
            if candidates.len() == 1 {
                candidates.first().copied()
            } else {
                None
            }
        })?;
    if fields["completed"].is_boolean()
        && target.entity == Entity::Event
        && record(snapshot, Entity::Event, &target.id)
            .is_some_and(|event| event["linkedTaskId"].is_null())
    {
        return None;
    }
    Some(vec![Change::new(
        Action::Update,
        target.entity,
        target.id.clone(),
        fields.as_object().cloned(),
    )])
}

pub(super) fn actual_activity(text: &str, snapshot: &Value) -> Option<Vec<Change>> {
    let text = text.trim().trim_end_matches(['.', '!']);
    let sections = rx!(r"(?i)\.\s+").split(text).collect::<Vec<_>>();
    let separators = rx!(r"(?i)(?:,?\s+and\s+|;\s*)on\s+\d").find_iter(sections[0]);
    let mut start = 0;
    let mut parts = Vec::new();
    for separator in separators {
        parts.push(&sections[0][start..separator.start()]);
        start = separator.as_str().to_ascii_lowercase().rfind("on").unwrap() + separator.start();
    }
    parts.push(&sections[0][start..]);
    if parts.len() > 20 {
        return None;
    }
    let range = rx!(
        r"(?i)^on (\d{4}-\d{2}-\d{2}),?\s+i\s+(slept|worked|studied|exercised|walked|ran|got ready|traveled|travelled)\s+from\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:to|until)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$"
    );
    let mut fields = Vec::new();
    for part in &parts {
        let c = range.captures(part.trim())?;
        let title = match c[2].to_ascii_lowercase().as_str() {
            "slept" => "Sleep",
            "worked" => "Work",
            "studied" => "Study",
            "exercised" => "Exercise",
            "walked" => "Walk",
            "ran" => "Run",
            "got ready" => "Get ready",
            _ => "Travel",
        };
        let date = NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").ok()?;
        let start = parse_time(&c[3])?;
        let end = parse_time(&c[4])?;
        if start == end {
            return None;
        }
        let end_date = if end < start { date.succ_opt()? } else { date };
        fields.push(json!({
            "title":title,"kind":"actual","startDate":date.to_string(),"endDate":end_date.to_string(),
            "startTime":start,"endTime":end,"categoryTitle":title,"linkedTaskId":null,"linkedStepId":null
        }));
    }
    for section in &sections[1..] {
        if rx!(r"(?i)^(?:do not|don't) (?:add|create) (?:any )?tasks(?: or planned (?:sessions|events))?$").is_match(section) {
            continue;
        }
        let c = rx!(r"(?i)^(?:please )?(?:record|log) (both|all)(?: as separate)? actual(?: ([\w -]+?))? (?:activities|sessions)(?: in the same ([\w -]+?) category)?(, each ending the following morning)?$").captures(section)?;
        if c[1].eq_ignore_ascii_case("both") && fields.len() != 2 {
            return None;
        }
        if !fields.iter().all(|field| {
            let title = field["title"].as_str().unwrap_or_default();
            c.get(2)
                .is_none_or(|m| title.eq_ignore_ascii_case(m.as_str()))
                && c.get(3)
                    .is_none_or(|m| title.eq_ignore_ascii_case(m.as_str()))
                && c.get(4).is_none_or(|_| {
                    field["startDate"] != field["endDate"]
                        && field["endTime"].as_str().is_some_and(|s| s < "12:00")
                })
        }) {
            return None;
        }
    }
    let events = snapshot["events"].as_array()?;
    let matching = |a: &Value, b: &Value| {
        [
            "title",
            "kind",
            "startDate",
            "endDate",
            "startTime",
            "endTime",
            "linkedTaskId",
        ]
        .iter()
        .all(|key| a[key] == b[key])
    };
    let mut unique = Vec::new();
    for field in fields {
        if !events
            .iter()
            .chain(unique.iter())
            .any(|event| matching(event, &field))
        {
            unique.push(field);
        }
    }
    Some(
        unique
            .into_iter()
            .map(|field| create(Entity::Event, field))
            .collect(),
    )
}

pub(super) fn linked_creation(text: &str) -> Option<Vec<Change>> {
    let text = text.trim().trim_end_matches(['.', '!']);
    let clauses = rx!(r"\.\s+").split(text).collect::<Vec<_>>();
    let [task, sessions, instructions @ ..] = clauses.as_slice() else {
        return None;
    };
    let task = rx!(r"(?i)^(?:please )?(?:create|add) (?:(?:exactly )?one|a|the) task (?:called|named) (.+?) due (\d{4}-\d{2}-\d{2})(?:,? with (?:one|a) checklist step (?:named|called) (.+))?$").captures(task)?;
    let sessions = rx!(r"(?i)^(?:also )?(?:create|add) (?:(one|two|three|four|five|\d+) )?(?:planned )?(?:calendar )?sessions?:\s*(.+)$").captures(sessions)?;
    if !instructions.iter().all(|clause| rx!(r"(?i)^(?:keep session notes independent of task notes|prepare all(?: (?:one|two|three|four|five|six|\d+))? records together for review)$").is_match(clause)) { return None; }
    let title = task[1].trim_matches(['"', '“', '”']).trim();
    if title.is_empty() || title.encode_utf16().count() > 240 {
        return None;
    }
    let deadline = NaiveDate::parse_from_str(&task[2], "%Y-%m-%d")
        .ok()?
        .to_string();
    let step = task
        .get(3)
        .map(|value| (uid(), value.as_str().trim_matches(['"', '“', '”']).trim()));
    if step
        .as_ref()
        .is_some_and(|(_, title)| title.is_empty() || title.encode_utf16().count() > 240)
    {
        return None;
    }
    let parts = sessions[2].split(';').map(str::trim).collect::<Vec<_>>();
    if !(1..=20).contains(&parts.len()) {
        return None;
    }
    if let Some(count) = sessions.get(1) {
        let word = count.as_str().to_ascii_lowercase();
        let expected = word.parse::<usize>().ok().or_else(|| {
            ["one", "two", "three", "four", "five"]
                .iter()
                .position(|value| *value == word)
                .map(|index| index + 1)
        });
        if expected != Some(parts.len()) {
            return None;
        }
    }
    let steps = step
        .iter()
        .map(|(id, title)| json!({"id":id,"title":title,"completed":false}))
        .collect::<Vec<_>>();
    let task = create(
        Entity::Task,
        json!({"title":title,"dueDate":deadline,"steps":steps}),
    );
    let mut events = Vec::new();
    for part in parts {
        let c = rx!(r"(?i)^(.+?) on (\d{4}-\d{2}-\d{2}) from (\d{1,2}(?::\d{2})?\s*(?:am|pm)?) to (\d{1,2}(?::\d{2})?\s*(?:am|pm)?) linked to (?:the|this) task(?: and its (.+?) step)?$").captures(part)?;
        let title = c[1].trim_matches(['"', '“', '”']).trim();
        if title.is_empty() || title.encode_utf16().count() > 240 {
            return None;
        }
        let date = NaiveDate::parse_from_str(&c[2], "%Y-%m-%d")
            .ok()?
            .to_string();
        let start = parse_time(&c[3])?;
        let end = parse_time(&c[4])?;
        if end <= start {
            return None;
        }
        let linked_step = if let Some(mentioned) = c.get(5) {
            let (id, title) = step.as_ref()?;
            if normalize(mentioned.as_str()) != normalize(title) {
                return None;
            }
            Some(id)
        } else {
            None
        };
        events.push(create(Entity::Event, json!({
            "title":title,"startDate":date,"endDate":date,"startTime":start,"endTime":end,"kind":"planned",
            "linkedTaskId":task.id,"linkedStepId":linked_step
        })));
    }
    Some(std::iter::once(task).chain(events).collect())
}
