//! Shared helpers for validating model proposals.
use super::temporal::TaskDates;
use crate::{
    deletion::rx,
    pending_draft::uid,
    schema::{Action, Change, Entity},
};
use serde_json::json;

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

pub(super) fn linked_session(title: &str, task_id: &str, dates: &TaskDates) -> Option<Change> {
    let day = dates.day.as_ref()?;
    let fields = json!({
        "title": title,
        "kind": "planned",
        "startDate": day,
        "endDate": day,
        "startTime": dates.start,
        "endTime": dates.end,
        "linkedTaskId": task_id,
    })
    .as_object()
    .cloned();
    Some(Change::new(Action::Create, Entity::Event, uid(), fields))
}
