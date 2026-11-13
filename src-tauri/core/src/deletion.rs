//! Planner record catalog shared by the assistant and its model validators.
use crate::{
    dates::date,
    schema::Entity,
};
use chrono::{Days, NaiveDate};
use serde_json::Value;

macro_rules! rx {
    ($pattern:literal) => {{
        static REGEX: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*REGEX
    }};
}
pub(crate) use rx;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub(crate) struct Target {
    pub entity: Entity,
    pub id: String,
    pub title: String,
}

pub(crate) fn targets(snapshot: &Value) -> Vec<Target> {
    Entity::ALL
        .into_iter()
        .flat_map(|entity| {
            snapshot[entity.table()]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |item| {
                    Some(Target {
                        entity,
                        id: item["id"].as_str()?.into(),
                        title: item["title"].as_str()?.into(),
                    })
                })
        })
        .collect()
}

pub(crate) fn normalize(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '‘') {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(if matches!(ch, '’' | '‘') {
                '\''
            } else {
                ch
            });
        } else {
            space = true;
        }
    }
    out
}

pub(crate) fn date_token(text: &str, today: NaiveDate) -> Option<NaiveDate> {
    match text.to_ascii_lowercase().as_str() {
        "today" => Some(today),
        "tomorrow" => today.checked_add_days(Days::new(1)),
        "yesterday" => today.checked_sub_days(Days::new(1)),
        "end of this week" | "end of the week" => (0..7)
            .filter_map(|n| today.checked_add_days(Days::new(n)))
            .find(|d| d.format("%a").to_string() == "Sun"),
        other => date(other).ok().or_else(|| {
            let weekday = other
                .strip_prefix("next ")
                .or_else(|| other.strip_prefix("this "))
                .unwrap_or(other);
            let name = match weekday {
                "monday" => "Mon",
                "tuesday" => "Tue",
                "wednesday" => "Wed",
                "thursday" => "Thu",
                "friday" => "Fri",
                "saturday" => "Sat",
                "sunday" => "Sun",
                _ => return None,
            };
            let offset = u64::from(other.starts_with("next "));
            (offset..offset + 7)
                .filter_map(|n| today.checked_add_days(Days::new(n)))
                .find(|d| d.format("%a").to_string() == name)
        }),
    }
}
