use mymind_core::dictation::{Checkpoint, DictationDrafts};
use rusqlite::{Connection, params};
use uuid::Uuid;

#[test]
fn opens_electron_draft_and_preserves_audio_and_user_edits() {
    let id = Uuid::new_v4();
    let old = Uuid::new_v4();
    let new = Uuid::new_v4();
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("dictation.sqlite");
    let conn = Connection::open(&file).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE drafts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
         CREATE TABLE chunks(draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
             sequence INTEGER NOT NULL, audio BLOB NOT NULL, PRIMARY KEY(draft_id, sequence));",
    )
    .unwrap();
    let legacy = serde_json::json!({
        "id": id, "generation": old, "prefix": "Typed", "liveText": "Live",
        "finalText": "", "reviewText": "Typed Live", "revision": 3,
        "seconds": 1.0, "bytes": 2, "nextSequence": 1,
        "createdAt": "2026-11-10T00:00:00.000Z", "updatedAt": "2026-11-10T00:00:00.000Z"
    });
    conn.execute(
        "INSERT INTO drafts VALUES (?,?)",
        params![id.to_string(), legacy.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO chunks VALUES (?,?,?)",
        params![id.to_string(), 0, &[1u8, 2]],
    )
    .unwrap();
    {
        let mut drafts = DictationDrafts::open(&file).unwrap();
        assert_eq!(drafts.get(id).unwrap().partial_text, "");
        assert_eq!(drafts.audio(id, old).unwrap(), [1, 2]);
        assert_eq!(drafts.bind(id, new).unwrap().revision, 3);
        assert!(drafts.append(id, old, 1, &[3], 2.0).is_err());
        assert!(drafts.append(id, new, 2, &[3], 2.0).is_err());
        drafts.append(id, new, 1, &[3], 2.0).unwrap();
        drafts.append(id, new, 1, &[3], 2.0).unwrap();
        assert!(drafts.append(id, new, 1, &[4], 2.0).is_err());
        drafts
            .checkpoint(Checkpoint {
                draft_id: id,
                generation: new,
                review_text: Some("Edited".into()),
                revision: Some(3),
                live_text: None,
                seconds: None,
            })
            .unwrap();
        drafts.final_text(id, new, "Recognized", Some(3)).unwrap();
        assert_eq!(drafts.get(id).unwrap().review_text, "Edited");
    }
    {
        let drafts = DictationDrafts::open(&file).unwrap();
        assert_eq!(drafts.audio(id, new).unwrap(), [1, 2, 3]);
        assert_eq!(drafts.list().unwrap()[0].final_text, "Recognized");
        drafts.discard(id).unwrap();
        assert!(drafts.list().unwrap().is_empty());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    drop(conn);
}
