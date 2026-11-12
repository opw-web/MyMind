use std::{
    collections::HashMap,
    ffi::OsString,
    fmt::Write,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, RequestBuilder, Response, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{sync::watch, task::JoinSet, time::Instant};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    ollama::{cancellable, loopback_client},
    worker_process::{self, ManagedProcess},
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_TIMEOUT: Duration = Duration::from_secs(2);
const PREVIEW_RATE: u32 = 16_000;
const SPEAK_RATE: u32 = 24_000;
const MAX_PREVIEW_PCM: usize = PREVIEW_RATE as usize * 4 * 30;
const MAX_SPEAK_PCM: usize = SPEAK_RATE as usize * 4 * 300;
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_SPEAK_JSON: usize = MAX_SPEAK_PCM.div_ceil(3) * 4 + 4096;
const CANCELLED: &str = "Dictation cancelled.";

#[derive(Debug, Clone, Serialize)]
pub struct SpeechStatus {
    pub state: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

impl SpeechStatus {
    fn new(state: &'static str, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
            pid: None,
            port: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SpeechProgress {
    pub text: String,
    pub seconds: f64,
}

#[derive(Debug, Serialize)]
pub struct Transcription {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SpeechWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SpeechPreview {
    pub words: Vec<SpeechWord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpokenAudio {
    pub pcm: Vec<u8>,
    pub sample_rate: u32,
}

#[derive(Clone)]
struct Endpoint {
    port: u16,
    token: Uuid,
}

impl Endpoint {
    fn request(&self, client: &Client, method: reqwest::Method, path: &str) -> RequestBuilder {
        client
            .request(method, format!("http://127.0.0.1:{}{path}", self.port))
            .bearer_auth(self.token)
    }

    fn audio(
        &self,
        client: &Client,
        path: &str,
        audio: Vec<u8>,
        mime: &str,
        id: Uuid,
        hints: &str,
    ) -> RequestBuilder {
        self.request(client, reqwest::Method::POST, path)
            .header(header::CONTENT_TYPE, mime)
            .header("X-Request-Id", id.to_string())
            .header("X-Speech-Hints", encode_hints(hints))
            .body(audio)
    }
}

struct Worker {
    endpoint: Endpoint,
    process: ManagedProcess,
}

type Startup = watch::Receiver<Option<Result<SpeechStatus, String>>>;

struct State {
    status: SpeechStatus,
    worker: Option<Worker>,
    starting: Option<Startup>,
    requests: HashMap<Uuid, CancellationToken>,
}

struct Inner {
    root: PathBuf,
    client: Client,
    shutdown: CancellationToken,
    state: Mutex<State>,
}

pub struct SpeechRuntime(Arc<Inner>);

struct Request<'a> {
    id: Uuid,
    token: CancellationToken,
    inner: &'a Inner,
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.inner.state.lock().unwrap().requests.remove(&self.id);
    }
}

impl Request<'_> {
    async fn run<T>(
        &self,
        timeout: Option<Duration>,
        operation: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        let result = cancellable(&self.token, timeout, operation).await;
        ensure!(!self.token.is_cancelled(), "{CANCELLED}");
        result
    }
}

impl SpeechRuntime {
    pub fn new(resource_root: PathBuf) -> Result<Self> {
        Ok(Self(Arc::new(Inner {
            root: resource_root,
            client: loopback_client()?,
            shutdown: CancellationToken::new(),
            state: Mutex::new(State {
                status: SpeechStatus::new("idle", "Local dictation"),
                worker: None,
                starting: None,
                requests: HashMap::new(),
            }),
        })))
    }

    pub fn status(&self) -> SpeechStatus {
        self.0.state.lock().unwrap().status.clone()
    }

    pub async fn start(&self) -> Result<SpeechStatus> {
        let mut starting = {
            let mut state = self.0.state.lock().unwrap();
            ensure!(!self.0.shutdown.is_cancelled(), "MYMIND is closing.");
            if state.status.state == "ready"
                && state
                    .worker
                    .as_mut()
                    .is_some_and(|worker| worker.process.alive())
            {
                return Ok(state.status.clone());
            }
            if let Some(starting) = &state.starting {
                starting.clone()
            } else {
                let (send, receive) = watch::channel(None);
                state.status = SpeechStatus::new("loading", "Loading local dictation…");
                state.starting = Some(receive.clone());
                let inner = self.0.clone();
                tokio::spawn(async move {
                    let result = inner.initialize().await;
                    let mut state = inner.state.lock().unwrap();
                    let result = if inner.shutdown.is_cancelled() {
                        Err("MYMIND is closing.".into())
                    } else if let Err(error) = result {
                        let message = error.to_string();
                        state.worker.take();
                        state.status = SpeechStatus::new("error", &message);
                        Err(message)
                    } else {
                        state.status.state = "ready";
                        state.status.message = "Local dictation ready".into();
                        Ok(state.status.clone())
                    };
                    state.starting = None;
                    send.send_replace(Some(result));
                });
                receive
            }
        };
        starting
            .wait_for(Option::is_some)
            .await?
            .clone()
            .context("Local dictation did not start.")?
            .map_err(anyhow::Error::msg)
    }

    fn register(&self, id: Uuid, duplicate: &str) -> Result<Request<'_>> {
        let mut state = self.0.state.lock().unwrap();
        ensure!(!self.0.shutdown.is_cancelled(), "MYMIND is closing.");
        ensure!(!state.requests.contains_key(&id), "{duplicate}");
        let token = self.0.shutdown.child_token();
        state.requests.insert(id, token.clone());
        Ok(Request {
            id,
            token,
            inner: &self.0,
        })
    }

    async fn endpoint(&self) -> Result<Endpoint> {
        self.start().await?;
        self.0
            .state
            .lock()
            .unwrap()
            .worker
            .as_ref()
            .map(|worker| worker.endpoint.clone())
            .context("Local dictation is unavailable.")
    }

    pub async fn transcribe(
        &self,
        audio: Vec<u8>,
        mime_type: &str,
        request_id: &str,
        hints: &str,
        mut progress: Option<&mut (dyn FnMut(SpeechProgress) + Send)>,
    ) -> Result<Transcription> {
        ensure!(!audio.is_empty(), "No audio captured.");
        ensure!(
            matches!(
                mime_type,
                "audio/webm;codecs=opus" | "audio/webm" | "audio/wav"
            ),
            "Unsupported audio format."
        );
        let job = self.register(
            request_uuid(request_id)?,
            "This recording is already being transcribed.",
        )?;
        let endpoint = job.run(None, self.endpoint()).await?;
        let request = endpoint.audio(
            &self.0.client,
            "/transcribe",
            audio,
            mime_type,
            job.id,
            hints,
        );
        let request = if progress.is_some() {
            request.header("X-Stream-Progress", "1")
        } else {
            request
        };
        job.run(None, async {
            let response = request.send().await?;
            let result = if response.status().is_success()
                && response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|header| header.to_str().ok())
                    == Some("application/x-ndjson")
            {
                stream_transcript(response, &mut progress).await?
            } else {
                response_json(response, MAX_JSON).await?
            };
            Ok(Transcription {
                text: result["text"]
                    .as_str()
                    .context("Invalid transcription response.")?
                    .into(),
                confidence: result["confidence"].as_f64(),
            })
        })
        .await
    }

    pub async fn preview(
        &self,
        pcm: Vec<u8>,
        sample_rate: u32,
        offset: f64,
        request_id: &str,
        hints: &str,
    ) -> Result<SpeechPreview> {
        ensure!(
            sample_rate == PREVIEW_RATE
                && offset.is_finite()
                && offset >= 0.0
                && !pcm.is_empty()
                && pcm.len() <= MAX_PREVIEW_PCM
                && pcm.len().is_multiple_of(4),
            "Invalid preview audio."
        );
        ensure!(
            pcm.chunks_exact(4)
                .all(|sample| f32::from_le_bytes(sample.try_into().unwrap()).is_finite()),
            "Invalid samples."
        );
        let job = self.register(request_uuid(request_id)?, "Duplicate preview request.")?;
        let endpoint = job.run(None, self.endpoint()).await?;
        let request = endpoint.audio(
            &self.0.client,
            "/preview",
            pcm,
            "application/octet-stream",
            job.id,
            hints,
        );
        job.run(None, async {
            let result = response_json(request.send().await?, MAX_JSON).await?;
            let mut preview: SpeechPreview =
                serde_json::from_value(result).context("Invalid speech preview response.")?;
            for word in &mut preview.words {
                ensure!(
                    word.start >= 0.0 && word.end >= 0.0,
                    "Invalid speech preview response."
                );
                word.start += offset;
                word.end += offset;
                ensure!(
                    word.start.is_finite() && word.end.is_finite(),
                    "Invalid speech preview response."
                );
            }
            Ok(preview)
        })
        .await
    }

    pub async fn speak(&self, text: &str) -> Result<SpokenAudio> {
        let text = text.trim();
        ensure!(
            !text.is_empty() && text.encode_utf16().count() <= 4000,
            "Invalid reply text."
        );
        let job = self.register(Uuid::new_v4(), "Duplicate speech request.")?;
        let endpoint = job.run(None, self.endpoint()).await?;
        let request = endpoint
            .request(&self.0.client, reqwest::Method::POST, "/speak")
            .json(&json!({"text":text,"requestId":job.id}));
        job.run(Some(Duration::from_secs(90)), async {
            let result = response_json(request.send().await?, MAX_SPEAK_JSON).await?;
            ensure!(
                result["sampleRate"].as_u64() == Some(SPEAK_RATE.into()),
                "Invalid speech output."
            );
            let encoded = result["pcm"].as_str().context("Invalid speech output.")?;
            let pcm = STANDARD.decode(encoded).context("Invalid speech output.")?;
            ensure!(
                pcm.len() <= MAX_SPEAK_PCM && pcm.len().is_multiple_of(4),
                "Invalid speech output."
            );
            Ok(SpokenAudio {
                pcm,
                sample_rate: SPEAK_RATE,
            })
        })
        .await
    }

    pub async fn cancel(&self, request_id: Option<&str>) -> Result<()> {
        let request_id = request_id.map(request_uuid).transpose()?;
        let (ids, endpoint) = {
            let mut state = self.0.state.lock().unwrap();
            let ids =
                request_id.map_or_else(|| state.requests.keys().copied().collect(), |id| vec![id]);
            for id in &ids {
                if let Some(token) = state.requests.get(id) {
                    token.cancel();
                }
            }
            if state.status.state != "ready" {
                return Ok(());
            }
            let Some(worker) = state.worker.as_mut() else {
                return Ok(());
            };
            if !worker.process.alive() {
                return Ok(());
            }
            (ids, worker.endpoint.clone())
        };
        let mut notifications = JoinSet::new();
        for id in ids {
            let request = endpoint
                .request(&self.0.client, reqwest::Method::POST, "/cancel")
                .json(&json!({"requestId":id}));
            let shutdown = self.0.shutdown.clone();
            notifications.spawn(async move {
                let _ = cancellable(&shutdown, Some(POLL_TIMEOUT), async {
                    response_json(request.send().await?, MAX_JSON).await
                })
                .await;
            });
        }
        while notifications.join_next().await.is_some() {}
        Ok(())
    }

    pub fn stop(&self) {
        let mut state = self.0.state.lock().unwrap();
        self.0.shutdown.cancel();
        state.requests.clear();
        state.worker.take();
        state.status = SpeechStatus::new("stopped", "Dictation stopped");
    }
}

impl Drop for SpeechRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Inner {
    async fn initialize(&self) -> Result<()> {
        let executable = self.root.join("python").join("python.exe");
        let worker = self.root.join("worker.py");
        let model = self.root.join("model");
        let preview = self.root.join("preview-model");
        ensure!(
            executable.is_file()
                && worker.is_file()
                && model.join("model.bin").is_file()
                && preview.join("model.bin").is_file(),
            "The dictation runtime is missing. Reinstall the latest MYMIND installer."
        );
        let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        let endpoint = Endpoint {
            port,
            token: Uuid::new_v4(),
        };
        let args: Vec<OsString> = vec![
            "-I".into(),
            "-B".into(),
            worker.into_os_string(),
            port.to_string().into(),
            model.into_os_string(),
            self.root.join("tts").into_os_string(),
            preview.into_os_string(),
        ];
        let env = [
            (
                "MYMIND_SPEECH_TOKEN".into(),
                endpoint.token.to_string().into(),
            ),
            ("HF_HUB_OFFLINE".into(), "1".into()),
            ("HF_HUB_DISABLE_TELEMETRY".into(), "1".into()),
        ];
        {
            let mut state = self.state.lock().unwrap();
            ensure!(!self.shutdown.is_cancelled(), "MYMIND is closing.");
            state.worker.take();
            let process = worker_process::spawn(&executable, &args, &env)?;
            state.status.port = Some(port);
            state.status.pid = Some(process.pid());
            state.worker = Some(Worker {
                endpoint: endpoint.clone(),
                process,
            });
        }
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        while Instant::now() < deadline {
            ensure!(!self.shutdown.is_cancelled(), "MYMIND is closing.");
            ensure!(
                self.state
                    .lock()
                    .unwrap()
                    .worker
                    .as_mut()
                    .is_some_and(|worker| worker.process.alive()),
                "Local dictation stopped during startup. Try again."
            );
            let timeout = POLL_TIMEOUT.min(deadline.saturating_duration_since(Instant::now()));
            if let Ok(health) = cancellable(&self.shutdown, Some(timeout), async {
                let request = endpoint.request(&self.client, reqwest::Method::GET, "/health");
                response_json(request.send().await?, MAX_JSON).await
            })
            .await
            {
                match health["state"].as_str() {
                    Some("ready") => return Ok(()),
                    Some("error") => bail!(
                        "{}",
                        health["message"]
                            .as_str()
                            .unwrap_or("Could not load local dictation.")
                    ),
                    _ => {}
                }
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => bail!("MYMIND is closing."),
                _ = tokio::time::sleep(Duration::from_millis(150)) => {}
            }
        }
        bail!("Local dictation took too long to start. Try again.")
    }
}

fn request_uuid(id: &str) -> Result<Uuid> {
    ensure!(id.len() == 36, "Invalid request ID.");
    Uuid::parse_str(id).context("Invalid request ID.")
}

fn encode_hints(hints: &str) -> String {
    let mut count = 0;
    let mut encoded = String::new();
    for character in hints.chars() {
        count += character.len_utf16();
        if count > 700 {
            break;
        }
        for &byte in character.encode_utf8(&mut [0; 4]).as_bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                encoded.push(byte as char);
            } else {
                write!(encoded, "%{byte:02X}").unwrap();
            }
        }
    }
    encoded
}

async fn response_json(mut response: Response, max_bytes: usize) -> Result<Value> {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= max_bytes,
            "Invalid local speech response."
        );
        body.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&body).context("Invalid local speech response.")?;
    ensure!(
        status.is_success() && result["error"].is_null(),
        "{}",
        worker_error(&result)
    );
    Ok(result)
}

fn worker_error(result: &Value) -> &str {
    result["error"]
        .as_str()
        .filter(|error| !error.is_empty())
        .unwrap_or("Local speech failed.")
}

async fn stream_transcript(
    mut response: Response,
    progress: &mut Option<&mut (dyn FnMut(SpeechProgress) + Send)>,
) -> Result<Value> {
    let mut line = Vec::new();
    let mut result = None;
    while let Some(chunk) = response.chunk().await? {
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            ensure!(
                line.len() + part.len() <= MAX_JSON,
                "Invalid transcription response."
            );
            line.extend_from_slice(part);
            if part.ends_with(b"\n") {
                transcript_line(&line, progress, &mut result)?;
                line.clear();
            }
        }
    }
    transcript_line(&line, progress, &mut result)?;
    result.context("Invalid transcription response.")
}

fn transcript_line(
    line: &[u8],
    progress: &mut Option<&mut (dyn FnMut(SpeechProgress) + Send)>,
    result: &mut Option<Value>,
) -> Result<()> {
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let message: Value = serde_json::from_slice(line).context("Invalid transcription response.")?;
    match message["type"].as_str() {
        Some("error") => bail!("{}", worker_error(&message)),
        Some("progress") if result.is_none() => {
            let update: SpeechProgress =
                serde_json::from_value(message).context("Invalid speech progress.")?;
            ensure!(update.seconds.is_finite(), "Invalid speech progress.");
            if let Some(callback) = progress {
                callback(update);
            }
        }
        Some("result") if result.is_none() => *result = Some(message),
        _ => bail!("Invalid transcription response."),
    }
    Ok(())
}
