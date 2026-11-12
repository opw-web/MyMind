use std::{
    ffi::OsString,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::{
    ollama::{ModelSettings, OllamaTransport, model_entry, residency},
    worker_process::{self, ManagedProcess},
};

const DEFAULT_MODEL: &str = "qwen3.5:4b";
const DEFAULT_CONTEXT: u32 = 32_768;
const TIMEOUT: Duration = Duration::from_secs(60);

pub struct ModelRuntime {
    settings_path: PathBuf,
    settings: RwLock<ModelSettings>,
    status: RwLock<Value>,
    status_changed: Arc<dyn Fn(Value) + Send + Sync>,
    operation: AsyncMutex<()>,
    process: Mutex<Option<ManagedProcess>>,
    cancellation: Mutex<CancellationToken>,
    stopped: AtomicBool,
}

fn settings_at(path: &Path) -> ModelSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ModelSettings>(&bytes).ok())
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_else(|| ModelSettings {
            model: std::env::var("MYMIND_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            context: DEFAULT_CONTEXT,
        })
}

fn elapsed(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

impl ModelRuntime {
    pub fn new(profile: &Path, status_changed: impl Fn(Value) + Send + Sync + 'static) -> Self {
        let settings_path = profile.join("assistant-settings.json");
        let settings = settings_at(&settings_path);
        let status = json!({
            "state":"starting", "message":"Starting your local assistant…",
            "model":settings.model, "context":settings.context, "gpu":"unknown"
        });
        Self {
            settings_path,
            settings: RwLock::new(settings),
            status: RwLock::new(status),
            status_changed: Arc::new(status_changed),
            operation: AsyncMutex::new(()),
            process: Mutex::new(None),
            cancellation: Mutex::new(CancellationToken::new()),
            stopped: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> Value {
        self.status.read().unwrap().clone()
    }

    fn update(&self, patch: Value) {
        let status = {
            let mut status = self.status.write().unwrap();
            status
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            status.clone()
        };
        (self.status_changed)(status);
    }

    fn transport(&self) -> Result<OllamaTransport> {
        let port = self.status()["port"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .context("Ollama has not started.")?;
        OllamaTransport::new(port)
    }

    fn token(&self) -> CancellationToken {
        self.cancellation.lock().unwrap().clone()
    }

    pub fn model_options(&self) -> Value {
        let status = self.status();
        let mut options = json!({"num_ctx":status["context"]});
        if !status["gpuLayers"].is_null() {
            options["num_gpu"] = status["gpuLayers"].clone();
        }
        options
    }

    fn alive(&self) -> bool {
        self.process
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(ManagedProcess::alive)
    }

    async fn initialize(&self, settings: &ModelSettings) -> Result<()> {
        let start = Instant::now();
        self.update(json!({
            "state":"starting","message":"Starting your local assistant…",
            "model":settings.model,"context":settings.context,"gpu":"unknown",
            "port":null,"pid":null,"startup":null,"gpuLayers":null
        }));
        let token = self.token();
        let executable = executable()?;
        let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        let mut env = vec![
            ("OLLAMA_HOST".into(), format!("127.0.0.1:{port}").into()),
            ("OLLAMA_NO_CLOUD".into(), "1".into()),
            ("OLLAMA_NUM_PARALLEL".into(), "1".into()),
            ("OLLAMA_MAX_LOADED_MODELS".into(), "1".into()),
            (
                "OLLAMA_CONTEXT_LENGTH".into(),
                settings.context.to_string().into(),
            ),
            ("OLLAMA_KEEP_ALIVE".into(), "-1".into()),
            ("OLLAMA_FLASH_ATTENTION".into(), "1".into()),
            ("OLLAMA_KV_CACHE_TYPE".into(), "q8_0".into()),
            (
                "OLLAMA_GPU_OVERHEAD".into(),
                (1536u64 * 1048576).to_string().into(),
            ),
        ];
        if let Some(models) = std::env::var_os("OLLAMA_MODELS").or_else(|| {
            std::env::var_os("USERPROFILE").map(|path| {
                PathBuf::from(path)
                    .join(".ollama")
                    .join("models")
                    .into_os_string()
            })
        }) {
            env.push(("OLLAMA_MODELS".into(), models));
        }
        let pid = {
            let mut slot = self.process.lock().unwrap();
            ensure!(
                !self.stopped.load(Ordering::Acquire) && !token.is_cancelled(),
                "MYMIND is closing."
            );
            let process = worker_process::spawn(&executable, &[OsString::from("serve")], &env)?;
            let pid = process.pid();
            *slot = Some(process);
            pid
        };
        self.update(json!({"port":port,"pid":pid}));
        let transport = self.transport()?;
        while transport
            .call("version", None, &token, Duration::from_secs(3))
            .await
            .is_err()
        {
            ensure!(!token.is_cancelled(), "Request stopped.");
            ensure!(
                self.alive(),
                "Ollama exited during startup. Click Retry to start it again."
            );
            ensure!(
                start.elapsed() < TIMEOUT,
                "Ollama did not become ready. Click Retry."
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let server_ms = elapsed(start);
        let checks = Instant::now();
        self.update(json!({"message":"Checking your local model…"}));
        let tags = transport.call("tags", None, &token, TIMEOUT).await?;
        let info = transport
            .local_model(&settings.model, &tags, &token)
            .await
            .with_context(|| {
                format!(
                    "{} is unavailable. Open Settings to select an eligible installed model.",
                    settings.model
                )
            })?;
        let bytes = model_entry(&tags, &settings.model)
            .and_then(|m| m["size"].as_u64())
            .unwrap_or(0);
        let layers = info["model_info"]
            .as_object()
            .and_then(|obj| {
                obj.iter().find_map(|(key, value)| {
                    (key.ends_with(".block_count") && !key.contains(".vision."))
                        .then(|| value.as_u64())
                        .flatten()
                })
            })
            .unwrap_or(0);
        let gpu_layers = gpu_layers(bytes, layers).await;
        let checks_ms = elapsed(checks);
        let load = Instant::now();
        self.update(json!({"state":"loading","message":format!("Loading {}…", settings.model),"gpuLayers":gpu_layers}));
        let mut options = json!({"num_ctx":settings.context});
        if let Some(layers) = gpu_layers {
            options["num_gpu"] = json!(layers);
        }
        let loaded = transport.call("generate", Some(&json!({
            "model":settings.model,"prompt":"","stream":false,"keep_alive":-1,"think":false,"options":options
        })), &token, Duration::from_secs(180)).await?;
        let ps = transport.call("ps", None, &token, TIMEOUT).await?;
        let model = model_entry(&ps, &settings.model)
            .context("Ollama did not report an active local model.")?;
        let context = model["context_length"]
            .as_u64()
            .context("Ollama did not report its active context window.")?;
        let gpu = residency(model);
        let message = match gpu {
            "full" => "fully on GPU",
            "partial" => "GPU + CPU",
            "cpu" => "CPU",
            _ => "ready",
        };
        self.update(json!({
            "state":"ready", "gpu":gpu, "context":context, "message":format!("{} · {message}",settings.model),
            "startup":{"serverMs":server_ms,"checksMs":checks_ms,"modelMs":elapsed(load),
                "ollamaLoadMs":loaded["load_duration"].as_u64().map(|ns| ns/1_000_000),"totalMs":elapsed(start)}
        }));
        Ok(())
    }

    pub async fn start(&self) {
        let _operation = self.operation.lock().await;
        if self.stopped.load(Ordering::Acquire)
            || (self.status()["state"] == "ready" && self.alive())
        {
            return;
        }
        let settings = self.settings.read().unwrap().clone();
        if let Err(error) = self.initialize(&settings).await {
            if !self.stopped.load(Ordering::Acquire) {
                self.update(json!({"state":"error","message":format!("{error:#}")}));
            }
        }
    }

    pub async fn monitor(&self) {
        while !self.stopped.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let _operation = self.operation.lock().await;
            if self.stopped.load(Ordering::Acquire) {
                return;
            }
            if self.status()["state"] == "ready" && !self.alive() {
                self.process.lock().unwrap().take();
                self.update(json!({
                    "state":"error",
                    "message":"Ollama stopped. Your planner is saved. Click Retry to reconnect."
                }));
            }
        }
    }

    pub async fn resume(&self) {
        if self.status()["state"] == "error" {
            self.retry().await;
        }
    }

    pub async fn retry(&self) {
        {
            let mut token = self.cancellation.lock().unwrap();
            token.cancel();
            *token = CancellationToken::new();
        }
        self.process.lock().unwrap().take();
        self.start().await;
    }

    pub async fn list_settings(&self) -> Result<Value> {
        let transport = self.transport()?;
        let token = self.token();
        let tags = transport.call("tags", None, &token, TIMEOUT).await?;
        let mut models = Vec::new();
        if let Some(entries) = tags["models"].as_array() {
            for entry in entries {
                if let Some(name) = entry["name"].as_str().or_else(|| entry["model"].as_str()) {
                    if transport.local_model(name, &tags, &token).await.is_ok() {
                        models.push(name);
                    }
                }
            }
        }
        let settings = self.settings.read().unwrap().clone();
        let status = self.status();
        let active = if status["state"] == "ready" {
            status["context"].clone()
        } else {
            Value::Null
        };
        Ok(
            json!({"model":settings.model,"context":settings.context,"activeContext":active,"models":models}),
        )
    }

    pub async fn configure(&self, settings: ModelSettings) -> Result<()> {
        settings.validate()?;
        let transport = self.transport()?;
        let token = self.token();
        let tags = transport.call("tags", None, &token, TIMEOUT).await?;
        transport
            .local_model(&settings.model, &tags, &token)
            .await?;
        *self.settings.write().unwrap() = settings.clone();
        self.retry().await;
        let status = self.status();
        if status["state"] != "ready" {
            bail!(
                "{}",
                status["message"]
                    .as_str()
                    .unwrap_or("Local assistant unavailable.")
            );
        }
        std::fs::write(&self.settings_path, serde_json::to_vec(&settings)?)?;
        Ok(())
    }

    pub async fn chat(
        &self,
        body: Value,
        request: &CancellationToken,
        timeout: Duration,
        on_text: impl FnMut(&str),
    ) -> Result<Value> {
        let runtime_token = self.token();
        let transport = self.transport()?;
        tokio::select! {
            biased;
            _ = runtime_token.cancelled() => bail!("Local assistant stopped."),
            result = transport.chat(body, request, timeout, on_text) => result,
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.token().cancel();
        self.process.lock().unwrap().take();
        self.update(json!({"state":"stopped","message":"Assistant stopped."}));
    }
}

fn executable() -> Result<PathBuf> {
    let name = if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    };
    let override_path = std::env::var_os("MYMIND_OLLAMA_PATH").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(|dir| {
        PathBuf::from(dir)
            .join("Programs")
            .join("Ollama")
            .join(name)
    });
    let system =
        std::env::var_os("ProgramFiles").map(|dir| PathBuf::from(dir).join("Ollama").join(name));
    let search = std::env::var_os("PATH").unwrap_or_default();
    [override_path, local, system]
        .into_iter()
        .flatten()
        .chain(std::env::split_paths(&search).map(|folder| folder.join(name)))
        .find(|path| path.is_file())
        .context("Install Ollama and download your local model, then click Retry.")
}

async fn gpu_layers(bytes: u64, layers: u64) -> Option<u64> {
    if bytes == 0 || layers == 0 {
        return None;
    }
    let mut command = tokio::process::Command::new("nvidia-smi");
    command
        .kill_on_drop(true)
        .args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(3), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let free = std::str::from_utf8(&output.stdout)
        .ok()?
        .lines()
        .next()?
        .trim()
        .parse::<u64>()
        .ok()?;
    let fit = (free.saturating_sub(1536) as u128 * 1048576 * layers as u128 / bytes as u128) as u64;
    (fit < layers).then_some(fit)
}
