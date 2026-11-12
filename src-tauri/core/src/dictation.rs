use std::path::Path;

use anyhow::{Context, Result, ensure};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationDraft {
    pub id: Uuid,
    pub generation: Uuid,
    pub prefix: String,
    pub live_text: String,
    pub final_text: String,
    #[serde(default)]
    pub partial_text: String,
    pub review_text: String,
    pub revision: u64,
    pub seconds: f64,
    pub bytes: u64,
    pub next_sequence: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub draft_id: Uuid,
    pub generation: Uuid,
    pub live_text: Option<String>,
    pub review_text: Option<String>,
    pub revision: Option<u64>,
    pub seconds: Option<f64>,
}

pub struct DictationDrafts(Connection);

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn get(conn: &Connection, id: Uuid) -> Result<DictationDraft> {
    let body: String = conn
        .query_row(
            "SELECT body FROM drafts WHERE id=?",
            [id.to_string()],
            |row| row.get(0),
        )
        .optional()?
        .context("This dictation draft is no longer available.")?;
    Ok(serde_json::from_str(&body)?)
}

fn owned(conn: &Connection, id: Uuid, generation: Uuid) -> Result<DictationDraft> {
    let draft = get(conn, id)?;
    ensure!(
        draft.generation == generation,
        "This dictation belongs to an earlier session."
    );
    Ok(draft)
}

fn write(conn: &Connection, mut draft: DictationDraft) -> Result<DictationDraft> {
    draft.updated_at = now();
    conn.execute(
        "INSERT INTO drafts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        params![draft.id.to_string(), serde_json::to_string(&draft)?],
    )?;
    Ok(draft)
}

fn validate_seconds(seconds: f64) -> Result<()> {
    ensure!(
        seconds.is_finite() && seconds >= 0.0,
        "Invalid recording duration."
    );
    Ok(())
}

impl DictationDrafts {
    pub fn open(path: &Path) -> Result<Self> {
        if path != Path::new(":memory:") {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
             PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
             CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS chunks(
                draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL, audio BLOB NOT NULL, PRIMARY KEY(draft_id, sequence));",
        )?;
        Ok(Self(conn))
    }

    pub fn get(&self, id: Uuid) -> Result<DictationDraft> {
        get(&self.0, id)
    }

    pub fn owned(&self, id: Uuid, generation: Uuid) -> Result<DictationDraft> {
        owned(&self.0, id, generation)
    }

    pub fn create(&self, generation: Uuid, prefix: String) -> Result<DictationDraft> {
        let created_at = now();
        write(
            &self.0,
            DictationDraft {
                id: Uuid::new_v4(),
                generation,
                review_text: prefix.clone(),
                prefix,
                live_text: String::new(),
                final_text: String::new(),
                partial_text: String::new(),
                revision: 0,
                seconds: 0.0,
                bytes: 0,
                next_sequence: 0,
                updated_at: created_at.clone(),
                created_at,
            },
        )
    }

    pub fn bind(&self, id: Uuid, generation: Uuid) -> Result<DictationDraft> {
        let mut draft = self.get(id)?;
        draft.generation = generation;
        write(&self.0, draft)
    }

    pub fn append(
        &mut self,
        id: Uuid,
        generation: Uuid,
        sequence: u64,
        audio: &[u8],
        seconds: f64,
    ) -> Result<()> {
        validate_seconds(seconds)?;
        ensure!(!audio.is_empty(), "An audio chunk cannot be empty.");
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut draft = owned(&tx, id, generation)?;
        if sequence < draft.next_sequence {
            let existing = tx
                .query_row(
                    "SELECT audio FROM chunks WHERE draft_id=? AND sequence=?",
                    params![id.to_string(), sequence],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()?;
            ensure!(
                existing.as_deref() == Some(audio),
                "An audio chunk was repeated with different content."
            );
        } else {
            ensure!(
                sequence == draft.next_sequence,
                "An audio chunk is missing. Your recording is retained; retry saving it."
            );
            tx.execute(
                "INSERT INTO chunks VALUES (?,?,?)",
                params![id.to_string(), sequence, audio],
            )?;
            draft.next_sequence += 1;
            draft.bytes += audio.len() as u64;
            draft.seconds = draft.seconds.max(seconds);
            write(&tx, draft)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn checkpoint(&self, input: Checkpoint) -> Result<DictationDraft> {
        let mut draft = self.owned(input.draft_id, input.generation)?;
        ensure!(
            input
                .revision
                .is_none_or(|revision| revision == draft.revision),
            "The dictation draft changed. Review the retained versions."
        );
        if let Some(live) = input.live_text {
            draft.live_text = live;
        }
        if let Some(review) = input
            .review_text
            .filter(|review| *review != draft.review_text)
        {
            draft.review_text = review;
            draft.revision += 1;
        }
        if let Some(seconds) = input.seconds {
            validate_seconds(seconds)?;
            draft.seconds = draft.seconds.max(seconds);
        }
        write(&self.0, draft)
    }

    pub fn progress(&self, id: Uuid, generation: Uuid, text: String) -> Result<DictationDraft> {
        let mut draft = self.owned(id, generation)?;
        draft.partial_text = text;
        write(&self.0, draft)
    }

    pub fn final_text(
        &self,
        id: Uuid,
        generation: Uuid,
        text: &str,
        review_revision: Option<u64>,
    ) -> Result<DictationDraft> {
        let mut draft = self.owned(id, generation)?;
        if !text.trim().is_empty() {
            draft.final_text = text.to_owned();
            draft.partial_text.clear();
            if review_revision == Some(draft.revision) {
                draft.review_text = [draft.prefix.trim(), text.trim()]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                draft.revision += 1;
            }
        }
        write(&self.0, draft)
    }

    pub fn audio(&self, id: Uuid, generation: Uuid) -> Result<Vec<u8>> {
        let draft = self.owned(id, generation)?;
        let mut stmt = self
            .0
            .prepare("SELECT audio FROM chunks WHERE draft_id=? ORDER BY sequence")?;
        let chunks = stmt.query_map([id.to_string()], |row| row.get::<_, Vec<u8>>(0))?;
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend(chunk?);
        }
        ensure!(
            !bytes.is_empty() && bytes.len() as u64 == draft.bytes,
            "No complete audio is available. Your text draft is retained."
        );
        Ok(bytes)
    }

    pub fn list(&self) -> Result<Vec<DictationDraft>> {
        let mut stmt = self
            .0
            .prepare("SELECT body FROM drafts ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn discard(&self, id: Uuid) -> Result<()> {
        self.0
            .execute("DELETE FROM drafts WHERE id=?", [id.to_string()])?;
        self.0.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    }
}
