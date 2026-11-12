#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_resume;

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use mymind_core::{
    assistant::PlannerAssistant,
    database::PlannerDatabase,
    dictation::{Checkpoint, DictationDrafts},
    model_runtime::ModelRuntime,
    ollama::ModelSettings,
    speech::{SpeechProgress, SpeechRuntime},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{
    Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    ipc::{InvokeBody, Request, Response},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct DesktopState {
    _profile_lock: File,
    database: Arc<Mutex<PlannerDatabase>>,
    assistant: PlannerAssistant,
    model: Arc<ModelRuntime>,
    speech: SpeechRuntime,
    dictation: Mutex<DictationDrafts>,
    transcriptions: Mutex<HashMap<Uuid, Uuid>>,
    chat: Mutex<Option<CancellationToken>>,
    chat_lifecycle: tokio::sync::Mutex<()>,
    closing: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftIdentity {
    draft_id: Uuid,
    generation: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftRequest {
    draft_id: Uuid,
    generation: Uuid,
    request_id: Uuid,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppendMetadata {
    draft_id: Uuid,
    generation: Uuid,
    sequence: u64,
    seconds: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewMetadata {
    draft_id: Uuid,
    generation: Uuid,
    request_id: Uuid,
    #[serde(rename = "sequence")]
    _sequence: u64,
    sample_rate: u32,
    offset: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscribeMetadata {
    request_id: Uuid,
    mime_type: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateDictation {
    generation: Uuid,
    prefix: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpeakInput {
    text: String,
}

fn emit(window: &WebviewWindow, event: &str, payload: Value) {
    let _ = window.emit_to("main", event, payload);
}

fn changed(window: &WebviewWindow) {
    emit(window, "planner-changed", Value::Null);
}

fn draft_changed(window: &WebviewWindow, state: &DesktopState, request: &str) -> Result<()> {
    let draft = state.assistant.drafts().get_draft()?;
    emit(
        window,
        "assistant-event",
        json!({"type":"draftchange","requestId":request,"draft":draft}),
    );
    Ok(())
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

fn hints(state: &DesktopState) -> Result<String> {
    let snap = state.database.lock().unwrap().snapshot()?;
    let titles = ["projects", "tasks", "events"]
        .iter()
        .flat_map(|key| snap[*key].as_array().into_iter().flatten())
        .filter_map(|item| item["title"].as_str())
        .take(20)
        .map(|title| title.chars().take(80).collect::<String>())
        .collect::<Vec<_>>();
    Ok(format!(
        "MYMIND. Calendar. To-do list. Assignments, exams, submissions, tasks, cornhole prototype. {}",
        titles.join(", ")
    ))
}

fn close(window: &WebviewWindow, state: &DesktopState) {
    if let Some(chat) = state.chat.lock().unwrap().take() {
        chat.cancel();
    }
    state.model.stop();
    state.speech.stop();
    window.app_handle().exit(0);
}

async fn cancel_transcription(state: &DesktopState, id: Uuid) {
    let request = state.transcriptions.lock().unwrap().remove(&id);
    if let Some(request) = request {
        let _ = state.speech.cancel(Some(&request.to_string())).await;
    }
}

async fn transcribe_dictation(
    state: &DesktopState,
    window: &WebviewWindow,
    request: DraftRequest,
) -> Result<Value> {
    let (audio, reviewed_revision) = {
        let drafts = state.dictation.lock().unwrap();
        let draft = drafts.owned(request.draft_id, request.generation)?;
        let auto_review = [draft.prefix.trim(), draft.live_text.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        (
            drafts.audio(request.draft_id, request.generation)?,
            (draft.review_text.trim() == auto_review).then_some(draft.revision),
        )
    };
    let vocabulary = hints(state)?;
    {
        use std::collections::hash_map::Entry;
        let mut jobs = state.transcriptions.lock().unwrap();
        match jobs.entry(request.draft_id) {
            Entry::Vacant(entry) => {
                entry.insert(request.request_id);
            }
            Entry::Occupied(_) => bail!("This recording is already being transcribed."),
        }
    }
    let mut on_progress = |progress: SpeechProgress| {
        let jobs = state.transcriptions.lock().unwrap();
        if jobs.get(&request.draft_id) != Some(&request.request_id) {
            return;
        }
        let saved = state.dictation.lock().unwrap().progress(
            request.draft_id,
            request.generation,
            progress.text.clone(),
        );
        if saved.is_ok() {
            emit(
                window,
                "speech-progress",
                json!({
                    "draftId":request.draft_id,"generation":request.generation,"requestId":request.request_id,
                    "sequence":request.sequence,"text":progress.text,"seconds":progress.seconds
                }),
            );
        }
    };
    let result = state
        .speech
        .transcribe(
            audio,
            "audio/webm;codecs=opus",
            &request.request_id.to_string(),
            &vocabulary,
            Some(&mut on_progress),
        )
        .await;
    let mut jobs = state.transcriptions.lock().unwrap();
    ensure!(
        jobs.get(&request.draft_id) == Some(&request.request_id),
        "This dictation session has changed."
    );
    jobs.remove(&request.draft_id);
    let result = result?;
    state.dictation.lock().unwrap().final_text(
        request.draft_id,
        request.generation,
        &result.text,
        reviewed_revision,
    )?;
    encode(result)
}

async fn chat(state: &DesktopState, window: &WebviewWindow, input: Value) -> Result<Value> {
    let _lifecycle = state
        .chat_lifecycle
        .try_lock()
        .map_err(|_| anyhow::anyhow!("Wait for the current reply or stop it first."))?;
    let id = input["requestId"]
        .as_str()
        .context("Chat needs a request ID.")?
        .to_owned();
    let token = {
        let mut active = state.chat.lock().unwrap();
        ensure!(
            active.is_none(),
            "Wait for the current reply or stop it first."
        );
        let token = CancellationToken::new();
        *active = Some(token.clone());
        token
    };
    emit(
        window,
        "assistant-event",
        json!({
            "type":"progress","requestId":id,"stage":"understanding","message":"Reading your request"
        }),
    );
    let result = state.assistant.run(input, Some(&state.model), &token).await;
    state.chat.lock().unwrap().take();
    match result {
        Ok(result) => {
            draft_changed(window, state, &id)?;
            if let Some(preview) = result.get("preview") {
                emit(
                    window,
                    "assistant-event",
                    json!({"type":"preview","requestId":id,"preview":preview}),
                );
            }
            emit(
                window,
                "assistant-event",
                json!({
                    "type":"done","requestId":id,"contextTrimmed":result["contextTrimmed"].as_bool().unwrap_or(false)
                }),
            );
            Ok(result)
        }
        Err(error) => {
            emit(
                window,
                "assistant-event",
                json!({"type":"error","requestId":id,"message":error.to_string()}),
            );
            Err(error)
        }
    }
}

async fn dispatch(
    window: &WebviewWindow,
    state: &DesktopState,
    operation: &str,
    input: Value,
) -> Result<Value> {
    ensure!(
        window.label() == "main",
        "This planner request is unavailable."
    );
    match operation {
        "snapshot" => state.database.lock().unwrap().snapshot(),
        "mutate" => {
            let receipt = state.database.lock().unwrap().mutate(input)?;
            changed(window);
            draft_changed(window, state, "")?;
            Ok(receipt)
        }
        "undo" => {
            let expected: Option<i64> = serde_json::from_value(input)?;
            let receipt = state.database.lock().unwrap().undo(expected, None)?;
            changed(window);
            draft_changed(window, state, "")?;
            Ok(receipt)
        }
        "organizePreview" => state.database.lock().unwrap().organize_preview(),
        "preferences" => {
            let appearance = input["appearance"].as_str().map(str::to_owned);
            state.database.lock().unwrap().preferences(input)?;
            if let Some(appearance) = appearance {
                let theme = match appearance.as_str() {
                    "light" => Some(tauri::Theme::Light),
                    "dark" => Some(tauri::Theme::Dark),
                    _ => None,
                };
                window.set_theme(theme)?;
            }
            changed(window);
            draft_changed(window, state, "")?;
            Ok(Value::Null)
        }
        "getDraft" => encode(state.assistant.drafts().get_draft()?),
        "applyDraft" => {
            let request = input["requestId"].as_str().unwrap_or("").to_owned();
            let receipt = state.assistant.drafts().apply_draft(input)?;
            changed(window);
            draft_changed(window, state, &request)?;
            Ok(receipt)
        }
        "editDraft" => {
            let draft = state.assistant.drafts().edit_draft(input)?;
            draft_changed(window, state, "")?;
            Ok(draft)
        }
        "dismissDraft" => {
            state.assistant.drafts().dismiss_draft(input)?;
            draft_changed(window, state, "")?;
            Ok(Value::Null)
        }
        "chat" => chat(state, window, input).await,
        "checkChatInput" => {
            let context = state.model.status()["context"].as_u64().unwrap_or(32_768);
            let fits = input["text"].as_str().is_some_and(|text| {
                !text.trim().is_empty() && text.len().div_ceil(3) + 3072 < context as usize
            });
            Ok(if fits {
                json!({"fits":true})
            } else {
                json!({"fits":false,"message":"This message is too long for the local model. Please split it into smaller parts."})
            })
        }
        "cancelChat" => {
            if let Some(active) = state.chat.lock().unwrap().as_ref() {
                active.cancel();
            }
            Ok(Value::Null)
        }
        "newChat" => {
            if let Some(active) = state.chat.lock().unwrap().as_ref() {
                active.cancel();
            }
            let _lifecycle = state.chat_lifecycle.lock().await;
            state.assistant.reset()?;
            draft_changed(window, state, "")?;
            Ok(Value::Null)
        }
        "status" => Ok(state.model.status()),
        "runtimeSettings" => state.model.list_settings().await,
        "configureRuntime" => {
            let settings: ModelSettings = serde_json::from_value(input)?;
            if let Some(active) = state.chat.lock().unwrap().as_ref() {
                active.cancel();
            }
            state.model.configure(settings).await?;
            Ok(Value::Null)
        }
        "retryRuntime" => {
            state.model.retry().await;
            Ok(Value::Null)
        }
        "startSpeech" => encode(state.speech.start().await?),
        "speechStatus" => encode(state.speech.status()),
        "cancelSpeech" => {
            let id: Option<Uuid> = serde_json::from_value(input)?;
            state
                .speech
                .cancel(id.map(|id| id.to_string()).as_deref())
                .await?;
            Ok(Value::Null)
        }
        "createDictation" => {
            let CreateDictation { generation, prefix } = serde_json::from_value(input)?;
            encode(state.dictation.lock().unwrap().create(generation, prefix)?)
        }
        "checkpointDictation" => {
            let checkpoint: Checkpoint = serde_json::from_value(input)?;
            encode(state.dictation.lock().unwrap().checkpoint(checkpoint)?)
        }
        "listDictations" => encode(state.dictation.lock().unwrap().list()?),
        "getDictation" => encode(
            state
                .dictation
                .lock()
                .unwrap()
                .get(serde_json::from_value(input)?)?,
        ),
        "restoreDictation" => {
            let DraftIdentity {
                draft_id,
                generation,
            } = serde_json::from_value(input)?;
            cancel_transcription(state, draft_id).await;
            encode(state.dictation.lock().unwrap().bind(draft_id, generation)?)
        }
        "discardDictation" => {
            let id: Uuid = serde_json::from_value(input)?;
            cancel_transcription(state, id).await;
            state.dictation.lock().unwrap().discard(id)?;
            Ok(Value::Null)
        }
        "transcribeDictation" => {
            transcribe_dictation(state, window, serde_json::from_value(input)?).await
        }
        "showWindow" => {
            if std::env::var("MYMIND_TEST_MODE").as_deref() != Ok("1") {
                window.show()?;
            }
            Ok(Value::Null)
        }
        "closeReady" => {
            if state.closing.load(Ordering::Acquire) {
                close(window, state);
            }
            Ok(Value::Null)
        }
        _ => bail!("Unknown planner operation."),
    }
}

#[tauri::command]
async fn planner_request(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    operation: String,
    input: Option<Value>,
) -> Result<Value, String> {
    dispatch(&window, &state, &operation, input.unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str> {
    Ok(request
        .headers()
        .get(name)
        .context("Missing audio request metadata.")?
        .to_str()?)
}

async fn audio_request(
    window: &WebviewWindow,
    state: &DesktopState,
    request: Request<'_>,
) -> Result<Value> {
    ensure!(
        window.label() == "main",
        "This planner request is unavailable."
    );
    let operation = header(&request, "x-mymind-operation")?;
    let metadata = header(&request, "x-mymind-metadata")?;
    let InvokeBody::Raw(audio) = request.body() else {
        bail!("Expected binary audio.");
    };
    match operation {
        "appendDictation" => {
            let meta: AppendMetadata = serde_json::from_str(metadata)?;
            state.dictation.lock().unwrap().append(
                meta.draft_id,
                meta.generation,
                meta.sequence,
                audio,
                meta.seconds,
            )?;
            Ok(Value::Null)
        }
        "previewSpeech" => {
            let meta: PreviewMetadata = serde_json::from_str(metadata)?;
            ensure!(
                !state
                    .transcriptions
                    .lock()
                    .unwrap()
                    .contains_key(&meta.draft_id),
                "Final transcription is already running."
            );
            state
                .dictation
                .lock()
                .unwrap()
                .owned(meta.draft_id, meta.generation)?;
            let words = state
                .speech
                .preview(
                    audio.clone(),
                    meta.sample_rate,
                    meta.offset,
                    &meta.request_id.to_string(),
                    &hints(state)?,
                )
                .await?;
            state
                .dictation
                .lock()
                .unwrap()
                .owned(meta.draft_id, meta.generation)?;
            encode(words)
        }
        "transcribe" => {
            let meta: TranscribeMetadata = serde_json::from_str(metadata)?;
            let result = state
                .speech
                .transcribe(
                    audio.clone(),
                    &meta.mime_type,
                    &meta.request_id.to_string(),
                    &hints(state)?,
                    None,
                )
                .await?;
            encode(result)
        }
        _ => bail!("Unknown binary audio operation."),
    }
}

#[tauri::command]
async fn planner_audio(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    request: Request<'_>,
) -> Result<Value, String> {
    audio_request(&window, &state, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn planner_speak(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    input: SpeakInput,
) -> Result<Response, String> {
    if window.label() != "main" {
        return Err("This planner request is unavailable.".into());
    }
    let spoken = state
        .speech
        .speak(&input.text)
        .await
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(4 + spoken.pcm.len());
    bytes.extend(spoken.sample_rate.to_le_bytes());
    bytes.extend(spoken.pcm);
    Ok(Response::new(bytes))
}

fn profile(app: &tauri::App) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("MYMIND_DATA_DIR") {
        return Ok(dir.into());
    }
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(dir).join("MYMIND"));
    }
    Ok(app.path().app_local_data_dir()?.join("planner"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            planner_request,
            planner_audio,
            planner_speak
        ])
        .setup(|app| {
            let profile = profile(app)?;
            std::fs::create_dir_all(&profile)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(profile.join(".mymind-profile.lock"))?;
            FileExt::try_lock_exclusive(&lock).context("This MYMIND profile is already open.")?;
            let database = Arc::new(Mutex::new(PlannerDatabase::open(
                &profile.join("planner.sqlite"),
            )?));
            let appearance = database.lock().unwrap().snapshot()?["preferences"]["appearance"]
                .as_str()
                .map(str::to_owned);
            let dictation = DictationDrafts::open(&profile.join("dictation.sqlite"))?;
            let resources = app.path().resource_dir()?.join("speech");
            let speech = SpeechRuntime::new(resources)?;
            let handle = app.handle().clone();
            let model = Arc::new(ModelRuntime::new(&profile, move |status| {
                let _ = handle.emit_to("main", "assistant-status", status);
            }));
            app.manage(DesktopState {
                _profile_lock: lock,
                assistant: PlannerAssistant::new(database.clone()),
                database,
                model: model.clone(),
                speech,
                dictation: Mutex::new(dictation),
                transcriptions: Mutex::new(HashMap::new()),
                chat: Mutex::new(None),
                chat_lifecycle: tokio::sync::Mutex::new(()),
                closing: AtomicBool::new(false),
            });
            let config = app
                .config()
                .app
                .windows
                .first()
                .context("Missing MYMIND window configuration.")?;
            let mut builder = WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "https" && url.host_str() == Some("tauri.localhost"))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if let Some(theme) = match appearance.as_deref() {
                Some("dark") => Some(tauri::Theme::Dark),
                Some("light") => Some(tauri::Theme::Light),
                _ => None,
            } {
                builder = builder.theme(Some(theme));
            }
            let window = builder.build()?;
            #[cfg(windows)]
            windows_resume::install(&window, model.clone())?;
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let state = close_window.state::<DesktopState>();
                    if !state.closing.swap(true, Ordering::AcqRel) {
                        emit(&close_window, "app-prepare-close", Value::Null);
                        let fallback = close_window.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            close(&fallback, &fallback.state::<DesktopState>());
                        });
                    }
                }
            });
            if std::env::var("MYMIND_SKIP_OLLAMA").as_deref() != Ok("1") {
                let monitor = model.clone();
                tauri::async_runtime::spawn(async move {
                    monitor.monitor().await;
                });
                tauri::async_runtime::spawn(async move {
                    model.start().await;
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("MYMIND desktop failed to start");
}
