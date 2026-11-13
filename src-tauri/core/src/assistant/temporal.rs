//! Task dates describe work unless deadline language governs the date.
use super::intent::parse_time;
use crate::deletion::{date_token, rx};
use chrono::NaiveDate;
use regex::Regex;
use std::sync::LazyLock;

const DATE: &str = r"(?:\d{4}-\d{2}-\d{2}|today|tomorrow|yesterday|end of (?:this|the) week|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4})";
const DEADLINE: &str =
    r"(?:due(?:\s+date)?(?:\s+(?:is|on|by))?|deadline(?:\s+(?:is|on|of))?|by|before)";
const TIME: &str = r"\d{1,2}(?::\d{2})?\s*(?:am|pm)?";

fn parse_date(token: &str, today: NaiveDate) -> Option<NaiveDate> {
    date_token(token, today)
        .or_else(|| NaiveDate::parse_from_str(&token.replace(',', ""), "%B %e %Y").ok())
}

pub(super) fn date_evidence(source: &str, today: NaiveDate, date: &str) -> bool {
    static DATES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!(r"(?i)\b{DATE}\b")).unwrap());
    DATES
        .find_iter(source)
        .any(|m| parse_date(m.as_str(), today).is_some_and(|day| day.to_string() == date))
}

#[derive(Default)]
pub(super) struct TaskDates {
    pub due: Option<String>,
    pub day: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}

pub(super) fn task_dates(text: &str, today: NaiveDate, excluded: bool) -> Option<TaskDates> {
    static DATES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(
            r"(?i)\b(?:(?P<deadline>{DEADLINE})\s*:?\s+)?(?P<date>{DATE})\b"
        ))
        .unwrap()
    });
    static TIMES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"(?i)\b(?:at\s+(?P<point>{TIME})|from\s+(?P<start>{TIME})\s+(?:to|until)\s+(?P<end>{TIME}))\b")).unwrap()
    });
    let mut dates = TaskDates::default();
    let mut date_roles = Vec::new();
    for mention in DATES.captures_iter(text) {
        let date = parse_date(&mention["date"], today)?.to_string();
        let is_deadline = mention.name("deadline").is_some();
        date_roles.push((mention.name("date")?.end(), is_deadline));
        let slot = if is_deadline {
            &mut dates.due
        } else if excluded {
            continue;
        } else {
            &mut dates.day
        };
        if slot.as_ref().is_some_and(|prior| prior != &date) {
            return None;
        }
        *slot = Some(date);
    }
    if !excluded {
        for mention in TIMES.captures_iter(text) {
            let time_start = mention.get(0)?.start();
            if date_roles
                .iter()
                .rev()
                .find(|(end, _)| *end <= time_start)
                .is_some_and(|(end, deadline)| {
                    *deadline
                        && text[*end..time_start]
                            .chars()
                            .all(|ch| ch == ',' || ch.is_whitespace())
                })
            {
                continue;
            }
            let (start, end) = if let Some(point) = mention.name("point") {
                (parse_time(point.as_str())?, None)
            } else {
                let start = parse_time(&mention["start"])?;
                let end = parse_time(&mention["end"])?;
                if end <= start {
                    return None;
                }
                (start, Some(end))
            };
            if dates
                .start
                .as_ref()
                .is_some_and(|prior| prior != &start || dates.end != end)
            {
                return None;
            }
            dates.start = Some(start);
            dates.end = end;
        }
        if dates.start.is_some() && rx!(r"(?i)\ball[ -]day\b").is_match(text) {
            return None;
        }
    }
    Some(dates)
}

fn calendar_exclusion() -> &'static Regex {
    rx!(r"(?ix)
        \b(?:
          (?:do\s+not|don['’]t|never)\s+(?:add|create|schedule|put|place)\s+
            (?:(?:a|any|the|an)\s+)?(?:(?:planned\s+)?(?:calendar\s+)?(?:events?|sessions?|entries?)\b|(?:it|that|them|anything)\s+(?:on|in)\s+(?:(?:my|the)\s+)?calendar\b)
          | no\s+calendar\s+(?:events?|sessions?|entries?)\b
          | not\s+(?:on|in)\s+(?:(?:my|the)\s+)?calendar\b
          | (?:keep|leave)\s+(?:it|them|(?:that|this)(?:\s+task)?)\s+off\s+(?:(?:my|the)\s+)?calendar\b
        )")
}

pub(super) fn calendar_excluded(text: &str) -> bool {
    calendar_exclusion().is_match(text)
}

fn put_on_calendar(text: &str) -> Option<(&str, &str)> {
    let c = rx!(r"(?i)^(?:please\s+)?(?:put|place)\s+(?:(?:a|an|the|my)\s+)?(.+?)\s+(?:on|in)\s+(?:(?:my|the)\s+)?calendar\b(.*)$").captures(text)?;
    Some((c.get(1)?.as_str(), c.get(2)?.as_str()))
}

pub(super) fn without_exclusion(text: &str) -> String {
    let clean = calendar_exclusion().replace_all(text, "");
    // Only remove a task exclusion from a positive event request, so that
    // general negations do not grant the assistant permission to write.
    let clean = if put_on_calendar(clean.trim()).is_some()
        || rx!(r"(?i)^(?:please\s+)?(?:add|create|schedule)\s+(?:(?:a|an|the)\s+)?(?:planned\s+)?(?:calendar\s+)?(?:event|session)\b").is_match(clean.trim())
    {
        rx!(r"(?i)(?:[,.;]\s*|\s+(?:but|and)\s+)(?:do\s+not|don['’]t|never)\s+(?:add|create)\s+(?:(?:a|any|the)\s+)?tasks?[\s.!]*$").replace(&clean, "").into_owned()
    } else {
        clean.into_owned()
    };
    rx!(r"(?i)(?:[,.;]\s*)?(?:\b(?:but|and)\s*)?[\s.,;!]+$|(?:[,.;]\s*)\b(?:but|and)\s*$")
        .replace(clean.trim(), "")
        .trim()
        .to_owned()
}
pub(super) fn commitment(text: &str) -> &str {
    rx!(r"(?i)[, ]+(?:because\s+|since\s+(?:i|we|you|they|he|she|it|my|our|your|their|his|her|the|there)\b)")
        .find(text)
        .map_or(text, |m| &text[..m.start()])
}

pub(super) fn natural_task(text: &str) -> Option<&str> {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(&format!(r"(?i)^(?:(?:{DEADLINE}\s+)?{DATE}(?:\s+at\s+{TIME})?[, ]+)?i\s+(?:need|want|have)\s+to\s+")).unwrap()
    });
    PREFIX.find(text).map(|m| &text[m.end()..])
}
