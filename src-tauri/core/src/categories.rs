use crate::schema::{Action, COLORS, Change, Entity, Fields, length, trim};
use anyhow::{Result, anyhow, bail, ensure};
use regex::RegexSet;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};
use uuid::Uuid;

fn key(title: &str) -> String {
    trim(title)
        .to_lowercase()
        .split(|character: char| {
            (character.is_whitespace() && character != '\u{0085}') || character == '\u{feff}'
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn canonical_title(title: &str) -> &str {
    match key(title).as_str() {
        "sleep" | "sleeping" | "slept" | "bedtime" => "Sleep",
        "exam" | "exams" => "Exams",
        "assignment" | "assignments" | "homework" => "Assignments",
        "submission" | "submissions" | "deadline" => "Submissions",
        "meeting" | "meetings" => "Meetings",
        "appointment" | "appointments" => "Appointments",
        "errand" | "errands" => "Errands",
        "task" | "tasks" => "Tasks",
        "event" | "events" => "Events",
        _ => trim(title),
    }
}

pub(crate) fn infer(title: &str, entity: Entity) -> &'static str {
    static RULES: LazyLock<RegexSet> = LazyLock::new(|| {
        RegexSet::new([
            r"(?i-u:\b(sleep|slept|sleeping|bedtime)\b|\b(went|go|going) to bed\b)",
            r"(?i-u:\b(exam|test|quiz|midterm|finals)\b)",
            r"(?i-u:\b(submit|submission|deadline|hand in|turn in)\b)",
            r"(?i-u:\b(assignment|homework|coursework|essay|worksheet)\b)",
            r"(?i-u:\b(meeting|review|standup|interview)\b)",
            r"(?i-u:\b(doctor|dentist|appointment|checkup)\b)",
            r"(?i-u:\b(buy|shop|groceries|pick up|collect|pay)\b)",
            r"(?i-u:\b(prototype|cornhole|3d print|packaging|build|design)\b)",
        ])
        .expect("valid planner category rules")
    });
    const TITLES: [&str; 8] = [
        "Sleep",
        "Exams",
        "Submissions",
        "Assignments",
        "Meetings",
        "Appointments",
        "Errands",
        "Projects",
    ];
    RULES
        .matches(title)
        .iter()
        .next()
        .map(|index| TITLES[index])
        .unwrap_or(if entity == Entity::Task {
            "Tasks"
        } else {
            "Events"
        })
}

fn semantic_color(title: &str) -> Option<&'static str> {
    match title {
        "Sleep" | "Meetings" | "Projects" | "Study" => Some("lavender"),
        "Exams" => Some("rose"),
        "Assignments" | "Events" | "Work" => Some("sky"),
        "Submissions" | "Travel" => Some("amber"),
        "Appointments" | "Exercise" | "Run" => Some("coral"),
        "Errands" | "Tasks" | "Get ready" | "Get ready and travel" | "Walk" => Some("sage"),
        _ => None,
    }
}

#[derive(Clone)]
struct Category {
    id: String,
    title: String,
    color: String,
    semantic_key: String,
    aliases: Vec<String>,
}

impl Category {
    fn new(
        id: &str,
        title: &str,
        color: &str,
        semantic_key: Option<&str>,
        aliases: Option<&Value>,
    ) -> Result<Self> {
        let mut normalized = Vec::new();
        if let Some(aliases) = aliases.filter(|value| !value.is_null()) {
            for alias in aliases
                .as_array()
                .ok_or_else(|| anyhow!("Invalid category aliases."))?
            {
                let alias = key(alias
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid category alias."))?);
                if !normalized.contains(&alias) {
                    normalized.push(alias);
                }
            }
        }
        let canonical_key = key(canonical_title(title));
        for alias in [key(title), canonical_key.clone()] {
            if !normalized.contains(&alias) {
                normalized.push(alias);
            }
        }
        Ok(Self {
            id: id.into(),
            title: title.into(),
            color: color.into(),
            semantic_key: semantic_key.map(str::to_owned).unwrap_or(canonical_key),
            aliases: normalized,
        })
    }

    fn read(value: &Value) -> Result<Self> {
        Self::new(
            value["id"]
                .as_str()
                .ok_or_else(|| anyhow!("Invalid saved category ID."))?,
            value["title"]
                .as_str()
                .ok_or_else(|| anyhow!("Invalid saved category title."))?,
            value["color"].as_str().unwrap_or("sky"),
            value["semanticKey"].as_str(),
            value.get("aliases"),
        )
    }

    fn fields(&self) -> Fields {
        json!({
            "title": self.title, "color": self.color, "semanticKey": self.semantic_key, "aliases": self.aliases,
        }).as_object().unwrap().clone()
    }

    fn name_matches(&self, title: &str, semantic_key: Option<&str>) -> bool {
        let canonical = key(canonical_title(title));
        self.semantic_key == semantic_key.unwrap_or(&canonical)
            || self.aliases.contains(&key(title))
            || key(canonical_title(&self.title)) == canonical
    }
}

pub(crate) fn normalize(value: &mut Value) -> Result<()> {
    let category = Category::read(value)?;
    value["semanticKey"] = category.semantic_key.into();
    value["aliases"] = json!(category.aliases);
    Ok(())
}

fn add_alias(
    category: &mut Category,
    title: &str,
    additions: &mut [Change],
    metadata: &mut Vec<Change>,
) {
    let alias = key(title);
    if category.aliases.contains(&alias) {
        return;
    }
    category.aliases.push(alias);
    if let Some(change) = additions
        .iter_mut()
        .chain(metadata.iter_mut())
        .find(|change| change.id.as_deref() == Some(&category.id))
    {
        change
            .fields
            .as_mut()
            .unwrap()
            .insert("aliases".into(), json!(category.aliases));
    } else {
        let fields = json!({"semanticKey": category.semantic_key, "aliases": category.aliases});
        metadata.push(Change::new(
            Action::Update,
            Entity::Category,
            category.id.clone(),
            fields.as_object().cloned(),
        ));
    }
}

fn canonical_id<'a>(mut id: &'a str, replacements: &'a HashMap<String, String>) -> Result<&'a str> {
    let mut visited = HashSet::new();
    while let Some(next) = replacements.get(id) {
        ensure!(
            visited.insert(id),
            "Category references cannot contain a cycle."
        );
        id = next;
    }
    Ok(id)
}

pub(crate) fn categorize(saved: &[Value], mut changes: Vec<Change>) -> Result<Vec<Change>> {
    let deleted = changes
        .iter()
        .filter(|change| change.entity == Entity::Category && change.action == Action::Delete)
        .filter_map(|change| change.id.as_deref())
        .collect::<HashSet<_>>();
    let mut categories = saved
        .iter()
        .filter(|value| !deleted.contains(value["id"].as_str().unwrap_or_default()))
        .map(Category::read)
        .collect::<Result<Vec<_>>>()?;
    let mut additions = Vec::new();
    let mut metadata = Vec::new();
    let mut replacements = HashMap::new();

    // Reuse category identities before resolving any references in the batch.
    for change in changes
        .iter_mut()
        .filter(|change| change.entity == Entity::Category && change.action == Action::Create)
    {
        let id = change
            .id
            .get_or_insert_with(|| Uuid::new_v4().to_string())
            .clone();
        let fields = change.fields.get_or_insert_with(Fields::new);
        let title = canonical_title(
            fields
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let semantic_key = fields.get("semanticKey").and_then(Value::as_str);
        if let Some(category) = categories
            .iter_mut()
            .find(|category| category.name_matches(title, semantic_key))
        {
            if category.id != id {
                replacements.insert(id, category.id.clone());
            }
            add_alias(category, title, &mut additions, &mut metadata);
        } else {
            let category = Category::new(
                &id,
                title,
                fields.get("color").and_then(Value::as_str).unwrap_or("sky"),
                semantic_key,
                fields.get("aliases"),
            )?;
            fields.insert("title".into(), category.title.clone().into());
            fields.insert("semanticKey".into(), category.semantic_key.clone().into());
            fields.insert("aliases".into(), json!(category.aliases));
            categories.push(category);
            additions.push(change.clone());
        }
    }

    for change in changes
        .iter_mut()
        .chain(&mut additions)
        .filter(|change| change.entity == Entity::Category)
    {
        if let Some(id) = &mut change.id {
            *id = canonical_id(id, &replacements)?.into();
        }
    }
    let deleted = changes
        .iter()
        .filter(|change| change.entity == Entity::Category && change.action == Action::Delete)
        .filter_map(|change| change.id.clone())
        .collect::<HashSet<_>>();
    categories.retain(|category| !deleted.contains(&category.id));

    for change in &mut changes {
        if change.entity == Entity::Category
            && change.action == Action::Update
            && let Some(title) = change
                .field("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty())
            && let Some(category) = categories
                .iter_mut()
                .find(|category| change.id.as_deref() == Some(&category.id))
        {
            add_alias(category, title, &mut additions, &mut metadata);
            category.title = title.into();
        }
        if !change.entity.categorized() || change.action == Action::Delete {
            continue;
        }
        let Some(fields) = &mut change.fields else {
            continue;
        };
        if let Some(id) = fields
            .get_mut("categoryId")
            .filter(|value| value.is_string())
        {
            let canonical = canonical_id(id.as_str().unwrap(), &replacements)?;
            if categories.iter().any(|category| category.id == canonical) {
                *id = canonical.into();
            } else {
                let reference = key(canonical);
                let mut matches = categories.iter().filter(|category| {
                    key(&category.title) == reference
                        || category.semantic_key == reference
                        || category.aliases.contains(&reference)
                });
                let found = matches.next();
                ensure!(
                    matches.next().is_none(),
                    "Several categories match this reference. Choose a verified category ID."
                );
                *id = found
                    .map(|category| category.id.as_str())
                    .unwrap_or(canonical)
                    .into();
            }
        }
        if let Some(color) = fields.get("color").cloned() {
            fields.entry("colorOverride").or_insert(color);
        }
        let infer = change.action == Action::Create && !fields.contains_key("categoryId");
        let requested = fields.remove("categoryTitle");
        if requested.is_none() && !infer {
            continue;
        }
        let item_title = fields
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let requested = match requested.as_ref() {
            Some(Value::String(title)) => title.as_str(),
            None | Some(Value::Null) => crate::categories::infer(item_title, change.entity),
            _ => bail!("Use a concise category name."),
        };
        let title = canonical_title(requested);
        ensure!(
            !title.is_empty() && length(title) <= 80,
            "Use a concise category name."
        );
        let index = if let Some(index) = categories
            .iter()
            .position(|category| category.name_matches(title, None))
        {
            index
        } else {
            ensure!(
                semantic_color(title).is_some() || key(title) != key(item_title),
                "Use a reusable category, not the item title."
            );
            let color = semantic_color(title)
                .or_else(|| {
                    COLORS
                        .into_iter()
                        .find(|color| !categories.iter().any(|category| category.color == *color))
                })
                .unwrap_or("sky");
            let category = Category::new(&Uuid::new_v4().to_string(), title, color, None, None)?;
            additions.push(Change::new(
                Action::Create,
                Entity::Category,
                category.id.clone(),
                Some(category.fields()),
            ));
            categories.push(category);
            categories.len() - 1
        };
        let category = &mut categories[index];
        add_alias(category, requested, &mut additions, &mut metadata);
        fields.insert("categoryId".into(), category.id.clone().into());
    }

    let operations = changes
        .into_iter()
        .filter(|change| change.entity != Entity::Category || change.action != Action::Create);
    order(saved, metadata, additions, operations)
}

fn order(
    saved: &[Value],
    metadata: Vec<Change>,
    additions: Vec<Change>,
    operations: impl Iterator<Item = Change>,
) -> Result<Vec<Change>> {
    let first_addition = metadata.len();
    let first_operation = first_addition + additions.len();
    let pending = metadata
        .into_iter()
        .chain(additions)
        .chain(operations)
        .collect::<Vec<_>>();
    let mut dependencies = vec![HashSet::new(); pending.len()];
    let creations = pending
        .iter()
        .enumerate()
        .filter(|(_, change)| change.action == Action::Create)
        .filter_map(|(index, change)| Some(((change.entity, change.id.as_deref()?), index)))
        .collect::<HashMap<_, _>>();
    let mut previous = HashMap::new();
    for (index, change) in pending.iter().enumerate() {
        if let Some(id) = change.id.as_deref()
            && let Some(prior) = previous.insert((change.entity, id), index)
        {
            dependencies[index].insert(prior);
        }
        for (field, entity) in [
            ("categoryId", Entity::Category),
            ("linkedTaskId", Entity::Task),
        ] {
            if let Some(id) = change.field(field).and_then(Value::as_str)
                && let Some(creation) = creations.get(&(entity, id))
            {
                dependencies[index].insert(*creation);
            }
        }
    }
    for (deletion_index, deletion) in pending
        .iter()
        .enumerate()
        .skip(first_operation)
        .filter(|(_, change)| change.entity == Entity::Category && change.action == Action::Delete)
    {
        let Some(id) = deletion.id.as_deref() else {
            continue;
        };
        let former_title = saved
            .iter()
            .find(|category| category["id"] == id)
            .and_then(|category| category["title"].as_str());
        let titles = pending[first_operation..]
            .iter()
            .filter(|change| {
                change.entity == Entity::Category
                    && change.action == Action::Update
                    && change.id.as_deref() == Some(id)
            })
            .filter_map(|change| change.field("title").and_then(Value::as_str))
            .chain(former_title)
            .map(key)
            .collect::<HashSet<_>>();
        for addition_index in first_addition..first_operation {
            let addition = &pending[addition_index];
            let title = key(addition
                .field("title")
                .and_then(Value::as_str)
                .unwrap_or_default());
            if addition.id.as_deref() != Some(id) && titles.contains(&title) {
                dependencies[addition_index].insert(deletion_index);
            }
        }
        for (index, consumer) in pending.iter().enumerate().skip(first_operation) {
            if consumer.field("categoryId").and_then(Value::as_str) != Some(id) {
                continue;
            }
            if index < deletion_index {
                dependencies[deletion_index].insert(index);
            } else {
                dependencies[index].insert(deletion_index);
            }
        }
    }

    // Prefer the earliest original operation whose prerequisites have been emitted.
    let mut pending = pending.into_iter().map(Some).collect::<Vec<_>>();
    let mut ordered = Vec::with_capacity(pending.len());
    for _ in 0..pending.len() {
        let index = dependencies
            .iter()
            .enumerate()
            .position(|(index, required)| {
                pending[index].is_some() && required.iter().all(|index| pending[*index].is_none())
            })
            .ok_or_else(|| {
                anyhow!("Category changes have conflicting creation and deletion dependencies.")
            })?;
        ordered.push(pending[index].take().unwrap());
    }
    Ok(ordered)
}
