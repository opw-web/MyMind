use super::{PlannerDatabase, SavedState};
use crate::{calendar, categories, schema::Entity};
use anyhow::{Result, anyhow, ensure};
use chrono::{Datelike, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

const INITIAL_SCHEMA: &str = "
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE sections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), section_id TEXT REFERENCES sections(id), body TEXT NOT NULL);
    CREATE INDEX tasks_project ON tasks(project_id);
    CREATE INDEX tasks_section ON tasks(section_id);
    CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, before_state TEXT NOT NULL, descriptions TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, receipt TEXT NOT NULL);
    INSERT INTO meta VALUES ('revision', '0');
";

pub(super) fn connect(path: &Path) -> Result<Connection> {
    if path != Path::new(":memory:")
        && let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(3))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    )?;
    Ok(connection)
}

impl PlannerDatabase {
    pub(super) fn transaction<T>(
        &self,
        behavior: TransactionBehavior,
        commit: bool,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let transaction = Transaction::new_unchecked(&self.connection, behavior)?;
        let value = operation()?;
        if commit {
            transaction.commit()?;
        } else {
            transaction.rollback()?;
        }
        Ok(value)
    }

    pub(super) fn migrate(&self, path: &Path) -> Result<()> {
        let starting_version: i64 =
            self.connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            starting_version <= 9,
            "This planner database needs a newer version of MYMIND."
        );
        for version in (starting_version + 1)..=9 {
            if starting_version > 0 && path != Path::new(":memory:") {
                let mut backup = path.as_os_str().to_os_string();
                backup.push(format!(".v{}-backup", version - 1));
                let backup = Path::new(&backup);
                if !backup.try_exists()? {
                    // SQLite copies committed WAL pages along with the original file.
                    let backup = backup
                        .to_str()
                        .ok_or_else(|| anyhow!("Invalid planner backup path."))?;
                    self.connection.execute("VACUUM INTO ?", [backup])?;
                }
            }
            self.transaction(TransactionBehavior::Immediate, true, || {
                self.migration_step(version)?;
                self.connection
                    .pragma_update(None, "user_version", version)?;
                Ok(())
            })?;
        }
        Ok(())
    }

    fn migration_step(&self, version: i64) -> Result<()> {
        if version == 1 {
            self.connection.execute_batch(INITIAL_SCHEMA)?;
            self.put(
                Entity::Project,
                json!({"id":"inbox","title":"Inbox","order":0}),
            )?;
            let year = Utc::now().with_timezone(&chrono_tz::Asia::Kolkata).year();
            return self.set_meta(
                "preferences",
                &json!({
                    "timezone": "Asia/Kolkata", "dayWidth": 132, "year": year, "chatOpen": false,
                })
                .to_string(),
            );
        }
        if version == 2 {
            self.connection.execute_batch(
                "CREATE TABLE categories(id TEXT PRIMARY KEY,body TEXT NOT NULL);
                 CREATE UNIQUE INDEX categories_title ON categories(lower(trim(json_extract(body,'$.title'))));"
            )?;
            for entity in [Entity::Event, Entity::Task] {
                for mut value in self.rows(entity)? {
                    value["categoryId"] = Value::Null;
                    if let Some(color) = value.get("color") {
                        value["colorOverride"] = color.clone();
                    }
                    self.put(entity, value)?;
                }
            }
            return Ok(());
        }

        let mut state = self.saved_state()?;
        if version == 9 {
            // v9 preserves the stored completion flag of existing sessions.
            state.events = self.rows(Entity::Event)?;
        }
        normalize_migration(&mut state, version, false)?;
        if matches!(version, 3 | 4 | 6 | 7 | 8) {
            for task in state.tasks {
                self.put(Entity::Task, task)?;
            }
        }
        if matches!(version, 5 | 6 | 7 | 9) {
            for event in state.events {
                self.put(Entity::Event, event)?;
            }
        }
        if version == 9 {
            for category in state.categories {
                self.put(Entity::Category, category)?;
            }
        }

        let mut statement = self
            .connection
            .prepare("SELECT id,before_state FROM history")?;
        let history = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, body) in history {
            // Older history omitted categories. Preserve that distinction until v9.
            let mut body: Value = serde_json::from_str(&body)?;
            let mut state: SavedState = serde_json::from_value(body.clone())?;
            normalize_migration(&mut state, version, true)?;
            if matches!(version, 3 | 4 | 6 | 7 | 8) {
                body["tasks"] = json!(state.tasks);
            }
            if matches!(version, 5 | 6 | 7 | 9) {
                body["events"] = json!(state.events);
            }
            if version == 9 {
                body["categories"] = json!(state.categories);
            }
            self.connection.execute(
                "UPDATE history SET before_state=? WHERE id=?",
                params![body.to_string(), id],
            )?;
        }
        Ok(())
    }

    pub(super) fn meta(&self, key: &str) -> Result<String> {
        Ok(self
            .connection
            .query_row("SELECT value FROM meta WHERE key=?", [key], |row| {
                row.get(0)
            })?)
    }

    pub(super) fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    pub(super) fn rows(&self, entity: Entity) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT body FROM {} ORDER BY rowid",
            entity.table()
        ))?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }

    pub(super) fn get(&self, entity: Entity, id: &str) -> Result<Value> {
        let result: Option<String> = self
            .connection
            .query_row(
                &format!("SELECT body FROM {} WHERE id=?", entity.table()),
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let body = result.ok_or_else(|| {
            anyhow!(
                "That {} no longer exists. Refresh and try again.",
                entity.name()
            )
        })?;
        Ok(serde_json::from_str(&body)?)
    }

    pub(super) fn exists(&self, entity: Entity, id: &str) -> Result<bool> {
        Ok(self
            .connection
            .query_row(
                &format!("SELECT 1 FROM {} WHERE id=?", entity.table()),
                [id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub(super) fn put(&self, entity: Entity, mut value: Value) -> Result<()> {
        let fields = value
            .as_object_mut()
            .ok_or_else(|| anyhow!("Invalid saved {}.", entity.name()))?;
        let defaults = match entity {
            Entity::Task => {
                json!({"createdAt":null,"completedAt":null,"steps":[],"dependsOnIds":[],"scheduledDate":null})
            }
            Entity::Event => {
                json!({"kind":"planned","linkedStepId":null,"completed":false,"linkedTaskId":null})
            }
            _ => json!({}),
        };
        for (key, default) in defaults.as_object().unwrap() {
            fields.entry(key.clone()).or_insert_with(|| default.clone());
        }
        if entity.categorized() {
            fields.entry("categoryId").or_insert(Value::Null);
            if let Some(color) = fields.get("color").cloned() {
                fields.entry("colorOverride").or_insert(color);
            }
        }
        let id = value["id"]
            .as_str()
            .ok_or_else(|| anyhow!("Invalid saved {} ID.", entity.name()))?;
        let body = value.to_string();
        match entity {
            Entity::Section => self.connection.execute(
                "INSERT INTO sections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, body=excluded.body",
                params![id, value["projectId"].as_str(), body],
            )?,
            Entity::Task => self.connection.execute(
                "INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, section_id=excluded.section_id, body=excluded.body",
                params![id, value["projectId"].as_str(), value["sectionId"].as_str(), body],
            )?,
            _ => self.connection.execute(
                &format!("INSERT INTO {} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", entity.table()),
                params![id, body],
            )?,
        };
        Ok(())
    }

    pub(super) fn delete(&self, entity: Entity, id: &str) -> Result<()> {
        self.connection
            .execute(&format!("DELETE FROM {} WHERE id=?", entity.table()), [id])?;
        Ok(())
    }

    pub(super) fn saved_state(&self) -> Result<SavedState> {
        let mut tasks = self.rows(Entity::Task)?;
        let mut projects = self.rows(Entity::Project)?;
        let mut sections = self.rows(Entity::Section)?;
        for values in [&mut tasks, &mut projects, &mut sections] {
            values.sort_by_key(|value| value["order"].as_i64().unwrap_or_default());
        }
        let mut events = self.rows(Entity::Event)?;
        for event in &mut events {
            event["completed"] = calendar::completion(event, &tasks).unwrap_or(false).into();
        }
        Ok(SavedState {
            events,
            tasks,
            projects,
            sections,
            categories: self.rows(Entity::Category)?,
        })
    }

    pub(super) fn replace_state(&self, state: &SavedState) -> Result<()> {
        self.connection.execute_batch(
            "DELETE FROM tasks; DELETE FROM sections; DELETE FROM projects; DELETE FROM events; DELETE FROM categories;"
        )?;
        for entity in [
            Entity::Category,
            Entity::Project,
            Entity::Section,
            Entity::Event,
            Entity::Task,
        ] {
            for value in state.records(entity) {
                self.put(entity, value.clone())?;
            }
        }
        Ok(())
    }
}

fn normalize_migration(state: &mut SavedState, version: i64, history: bool) -> Result<()> {
    match version {
        3 => {
            for task in &mut state.tasks {
                if task.get("scheduledDate").is_none()
                    || (!history && task["scheduledDate"].is_null())
                {
                    task["scheduledDate"] = task["dueDate"].clone();
                }
            }
        }
        4 => {
            for task in &mut state.tasks {
                for field in ["steps", "dependsOnIds"] {
                    if task[field].is_null() {
                        task[field] = json!([]);
                    }
                }
            }
        }
        5 => {
            for event in &mut state.events {
                event["linkedTaskId"] = Value::Null;
            }
        }
        6 => {
            for task in &mut state.tasks {
                for field in ["createdAt", "completedAt"] {
                    if task.get(field).is_none() {
                        task[field] = Value::Null;
                    }
                }
            }
            for event in &mut state.events {
                event["completed"] =
                    match event["linkedTaskId"].as_str().filter(|id| !id.is_empty()) {
                        Some(id) => state
                            .tasks
                            .iter()
                            .find(|task| task["id"] == id)
                            .and_then(|task| task["completed"].as_bool()),
                        None => event["completed"].as_bool(),
                    }
                    .unwrap_or(false)
                    .into();
            }
        }
        7 => {
            for value in state.tasks.iter_mut().chain(&mut state.events) {
                if value["textBox"].is_null() {
                    value["textBox"] = "".into();
                }
            }
        }
        8 => {
            for task in &mut state.tasks {
                if task.get("dueDate").is_none() {
                    task["dueDate"] = Value::Null;
                }
                if let Some(date) = state
                    .events
                    .iter()
                    .find(|event| event["linkedTaskId"] == task["id"])
                    .and_then(|event| event["startDate"].as_str())
                {
                    task["scheduledDate"] = date.into();
                } else if task.get("scheduledDate").is_none() {
                    task["scheduledDate"] = Value::Null;
                }
            }
        }
        9 => {
            for event in &mut state.events {
                if event["kind"].is_null() {
                    event["kind"] = "planned".into();
                }
                if event.get("linkedStepId").is_none() {
                    event["linkedStepId"] = Value::Null;
                }
            }
            for task in &state.tasks {
                if task["scheduledDate"].as_str().is_none_or(str::is_empty)
                    || state
                        .events
                        .iter()
                        .any(|event| event["linkedTaskId"] == task["id"])
                {
                    continue;
                }
                let id = task["id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid saved task ID."))?;
                let mut session_id = format!("legacy-session:{id}");
                while state.events.iter().any(|event| event["id"] == session_id) {
                    session_id.push_str(":legacy");
                }
                let mut event = Value::Object(calendar::session_fields(task));
                event["id"] = session_id.into();
                event["completed"] = false.into();
                state.events.push(event);
            }
            for category in &mut state.categories {
                categories::normalize(category)?;
            }
        }
        _ => unreachable!("unexpected planner migration"),
    }
    Ok(())
}
