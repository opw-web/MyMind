use crate::dates::{date, time};
use anyhow::{Result, anyhow, bail, ensure};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::{collections::HashSet, str::FromStr};

pub(crate) const COLORS: [&str; 6] = ["coral", "amber", "sage", "sky", "lavender", "rose"];
pub(crate) type Fields = Map<String, Value>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Entity {
    Event,
    Task,
    Project,
    Section,
    Category,
}

impl Entity {
    pub(crate) const ALL: [Self; 5] = [
        Self::Event,
        Self::Task,
        Self::Project,
        Self::Section,
        Self::Category,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Task => "task",
            Self::Project => "project",
            Self::Section => "section",
            Self::Category => "category",
        }
    }

    pub(crate) fn table(self) -> &'static str {
        match self {
            Self::Event => "events",
            Self::Task => "tasks",
            Self::Project => "projects",
            Self::Section => "sections",
            Self::Category => "categories",
        }
    }

    pub(crate) fn categorized(self) -> bool {
        matches!(self, Self::Task | Self::Event)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Action {
    Create,
    Update,
    Delete,
}

fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Change {
    pub(crate) action: Action,
    pub(crate) entity: Entity,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) id: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) fields: Option<Fields>,
}

impl Change {
    pub(crate) fn new(action: Action, entity: Entity, id: String, fields: Option<Fields>) -> Self {
        Self {
            action,
            entity,
            id: Some(id),
            fields,
        }
    }

    pub(crate) fn field(&self, field: &str) -> Option<&Value> {
        self.fields.as_ref()?.get(field)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Mutation {
    pub(crate) changes: Vec<Change>,
    pub(crate) label: String,
    pub(crate) expected_revision: i64,
    pub(crate) request_id: String,
}

impl Mutation {
    pub(crate) fn parse(value: Value) -> Result<Self> {
        let input: Self = serde_json::from_value(value)?;
        validate_changes(&input.changes, false)?;
        ensure!(
            (1..=240).contains(&length(&input.label)),
            "Use a label between 1 and 240 characters."
        );
        ensure!(input.expected_revision >= 0, "Invalid planner revision.");
        validate_request_id(&input.request_id)?;
        Ok(input)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftApply {
    pub(crate) draft_id: String,
    pub(crate) version: i64,
    pub(crate) expected_revision: i64,
    pub(crate) request_id: String,
}

impl DraftApply {
    pub(crate) fn parse(value: Value) -> Result<Self> {
        let input: Self = serde_json::from_value(value)?;
        ensure!(
            !input.draft_id.is_empty() && input.version > 0 && input.expected_revision >= 0,
            "Invalid draft identity or revision."
        );
        validate_request_id(&input.request_id)?;
        Ok(input)
    }
}

pub(crate) fn validate_request_id(value: &str) -> Result<()> {
    ensure!(
        (1..=100).contains(&length(value)),
        "Use a request ID between 1 and 100 characters."
    );
    Ok(())
}

pub(crate) fn validate_changes(changes: &[Change], allow_empty: bool) -> Result<()> {
    ensure!(
        (allow_empty || !changes.is_empty()) && changes.len() <= 5000,
        "Supply between 1 and 5000 changes."
    );
    for change in changes {
        ensure!(
            change.id.as_deref() != Some(""),
            "An existing item ID is required."
        );
    }
    Ok(())
}

pub(crate) fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn trim(value: &str) -> &str {
    value.trim_matches(|character: char| {
        (character.is_whitespace() && character != '\u{0085}') || character == '\u{feff}'
    })
}

pub(crate) fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .as_str()
        .ok_or_else(|| anyhow!("Invalid {name}. Expected text."))
}

fn bounded_text(
    value: &mut Value,
    name: &str,
    min: usize,
    max: usize,
    trim_text: bool,
) -> Result<()> {
    let original = text(value, name)?;
    let checked = if trim_text { trim(original) } else { original };
    ensure!(
        (min..=max).contains(&length(checked)),
        "Invalid {name}. Use between {min} and {max} characters."
    );
    if trim_text && checked != original {
        *value = checked.to_owned().into();
    }
    Ok(())
}

fn boolean(value: &Value, name: &str) -> Result<()> {
    ensure!(value.is_boolean(), "Invalid {name}. Expected a boolean.");
    Ok(())
}

fn integer(value: &Value, name: &str, min: i64, max: i64) -> Result<()> {
    ensure!(
        value
            .as_i64()
            .is_some_and(|number| (min..=max).contains(&number)),
        "Invalid {name}."
    );
    Ok(())
}

fn choice(value: &Value, name: &str, variants: &[&str]) -> Result<()> {
    ensure!(variants.contains(&text(value, name)?), "Invalid {name}.");
    Ok(())
}

fn id(value: &Value, name: &str, nullable: bool) -> Result<()> {
    ensure!(
        (nullable && value.is_null()) || value.as_str().is_some_and(|id| !id.is_empty()),
        "Invalid {name}. Expected an ID."
    );
    Ok(())
}

fn validate_steps(value: &mut Value) -> Result<()> {
    let steps = value
        .as_array_mut()
        .ok_or_else(|| anyhow!("Invalid steps. Expected an array."))?;
    ensure!(steps.len() <= 100, "Use no more than 100 steps.");
    let mut ids = HashSet::new();
    for step in steps {
        let fields = step
            .as_object_mut()
            .ok_or_else(|| anyhow!("Invalid step."))?;
        ensure!(
            fields.len() == 3
                && ["id", "title", "completed"]
                    .iter()
                    .all(|name| fields.contains_key(*name)),
            "A step needs only an ID, title and completion state."
        );
        id(&fields["id"], "step ID", false)?;
        bounded_text(fields.get_mut("title").unwrap(), "step title", 1, 240, true)?;
        boolean(&fields["completed"], "step completion")?;
        ensure!(
            ids.insert(fields["id"].as_str().unwrap().to_owned()),
            "Step IDs must be unique."
        );
    }
    Ok(())
}

fn validate_dependencies(value: &Value) -> Result<()> {
    let dependencies = value
        .as_array()
        .ok_or_else(|| anyhow!("Invalid prerequisites. Expected an array."))?;
    ensure!(
        dependencies.len() <= 100,
        "Use no more than 100 prerequisites."
    );
    let mut ids = HashSet::new();
    for dependency in dependencies {
        id(dependency, "prerequisite", false)?;
        ensure!(
            ids.insert(dependency.as_str().unwrap()),
            "Prerequisites must be unique."
        );
    }
    Ok(())
}

pub(crate) fn validate_fields(entity: Entity, fields: &mut Fields, partial: bool) -> Result<()> {
    use Entity::*;
    const COMMON: &[&str] = &[
        "title",
        "notes",
        "textBox",
        "color",
        "categoryId",
        "colorOverride",
        "completed",
    ];
    let required: &[&str] = match entity {
        Event => &[
            "kind",
            "linkedStepId",
            "linkedTaskId",
            "startDate",
            "endDate",
            "startTime",
            "endTime",
        ],
        Task => &[
            "dueDate",
            "scheduledDate",
            "projectId",
            "sectionId",
            "order",
            "steps",
            "dependsOnIds",
        ],
        Project => &["title", "order"],
        Section => &["title", "projectId", "order"],
        Category => &["title", "color"],
    };
    let common = if entity.categorized() { COMMON } else { &[] };
    if !partial {
        for name in required.iter().chain(common) {
            ensure!(fields.contains_key(*name), "Supply {name}.");
        }
    }
    for (name, value) in fields {
        ensure!(
            required.contains(&name.as_str())
                || common.contains(&name.as_str())
                || entity == Category && ["semanticKey", "aliases"].contains(&name.as_str()),
            "Unexpected {entity} field: {name}.",
            entity = entity.name()
        );
        match name.as_str() {
            "title" => bounded_text(
                value,
                name,
                1,
                if entity == Category { 80 } else { 240 },
                true,
            )?,
            "notes" => bounded_text(value, name, 0, 10000, false)?,
            "textBox" => {
                bounded_text(value, name, 0, 10000, false)?;
                if trim(text(value, name)?).is_empty() {
                    *value = "".into();
                }
            }
            "color" => choice(value, name, &COLORS)?,
            "colorOverride" if !value.is_null() => choice(value, name, &COLORS)?,
            "colorOverride" => {}
            "categoryId" | "linkedTaskId" | "linkedStepId" | "sectionId" => id(value, name, true)?,
            "projectId" => id(value, name, false)?,
            "completed" => boolean(value, name)?,
            "order" => integer(value, name, 0, 9_007_199_254_740_991)?,
            "kind" => choice(value, name, &["planned", "actual"])?,
            "dueDate" | "scheduledDate" if value.is_null() => {}
            "startDate" | "endDate" | "dueDate" | "scheduledDate" => {
                date(text(value, name)?)?;
            }
            "startTime" | "endTime" if value.is_null() => {}
            "startTime" | "endTime" => ensure!(
                time(text(value, name)?),
                "Use a valid time in HH:mm format."
            ),
            "steps" => validate_steps(value)?,
            "dependsOnIds" => validate_dependencies(value)?,
            "semanticKey" => bounded_text(value, name, 1, 80, true)?,
            "aliases" => {
                let aliases = value
                    .as_array_mut()
                    .ok_or_else(|| anyhow!("Invalid category aliases."))?;
                ensure!(
                    aliases.len() <= 100,
                    "Use no more than 100 category aliases."
                );
                for alias in aliases {
                    bounded_text(alias, "alias", 1, 80, true)?;
                }
            }
            _ => unreachable!("allowed planner field has no validator"),
        }
    }
    Ok(())
}

pub(crate) fn validate_preferences(input: Value) -> Result<Fields> {
    let Value::Object(fields) = input else {
        bail!("Invalid preferences.");
    };
    for (name, value) in &fields {
        match name.as_str() {
            "appearance" => choice(value, name, &["light", "dark", "system"])?,
            "taskLayout" => choice(value, name, &["checklist", "flow"])?,
            "timezone" => {
                let zone = text(value, name)?;
                // Electron's ICU also accepts these historic aliases outside IANA tzdb.
                let legacy = [
                    "US/Pacific-New",
                    "SystemV/AST4",
                    "SystemV/AST4ADT",
                    "SystemV/CST6",
                    "SystemV/CST6CDT",
                    "SystemV/EST5",
                    "SystemV/EST5EDT",
                    "SystemV/HST10",
                    "SystemV/MST7",
                    "SystemV/MST7MDT",
                    "SystemV/PST8",
                    "SystemV/PST8PDT",
                    "SystemV/YST9",
                    "SystemV/YST9YDT",
                ];
                let named = chrono_tz::Tz::from_str(zone).is_ok()
                    || chrono_tz::TZ_VARIANTS
                        .iter()
                        .any(|candidate| candidate.name().eq_ignore_ascii_case(zone))
                    || legacy
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(zone));
                ensure!(named || timezone_offset(zone), "Use a valid time zone.");
            }
            "dayWidth" => integer(value, name, 20, 240)?,
            "year" => integer(value, name, 1900, 2200)?,
            "chatWidth" => integer(value, name, 360, 560)?,
            "chatOpen" | "voiceAutoSend" | "spokenReplies" => boolean(value, name)?,
            _ => bail!("Unexpected preference: {name}."),
        }
    }
    Ok(fields)
}

fn timezone_offset(value: &str) -> bool {
    let Some(offset) = value.strip_prefix(['+', '-', '−']) else {
        return false;
    };
    match offset.as_bytes() {
        [a, b] => a.is_ascii_digit() && b.is_ascii_digit() && [*a, *b] <= *b"23",
        [_, _, b':', _, _] => time(offset),
        [a, b, c, d] => {
            [a, b, c, d].into_iter().all(u8::is_ascii_digit)
                && [*a, *b] <= *b"23"
                && [*c, *d] <= *b"59"
        }
        _ => false,
    }
}
