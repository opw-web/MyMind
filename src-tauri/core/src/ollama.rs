use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSettings {
    pub model: String,
    pub context: u32,
}

impl ModelSettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.model == self.model.trim()
                && !self.model.is_empty()
                && self.model.encode_utf16().count() <= 200,
            "Choose a valid Ollama model."
        );
        ensure!(
            (4096..=1_048_576).contains(&self.context),
            "Invalid context window."
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct OllamaTransport {
    client: Client,
    port: u16,
}

pub(crate) fn loopback_client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .build()?)
}

async fn response_json(response: Response) -> Result<Value> {
    let status = response.status();
    let result: Value = response
        .json()
        .await
        .context("Invalid local model response.")?;
    ensure!(
        status.is_success() && result["error"].is_null(),
        "{}",
        result["error"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Ollama returned {status}."))
    );
    Ok(result)
}

pub(crate) async fn cancellable<T>(
    token: &CancellationToken,
    timeout: Option<Duration>,
    request: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => bail!("Request stopped."),
        result = async {
            match timeout {
                Some(limit) => tokio::time::timeout(limit, request).await.context("The local request timed out.")?,
                None => request.await,
            }
        } => result,
    }
}

impl OllamaTransport {
    pub fn new(port: u16) -> Result<Self> {
        ensure!(port != 0, "Ollama has not started.");
        Ok(Self {
            client: loopback_client()?,
            port,
        })
    }

    pub async fn call(
        &self,
        endpoint: &str,
        body: Option<&Value>,
        token: &CancellationToken,
        timeout: Duration,
    ) -> Result<Value> {
        ensure!(
            matches!(endpoint, "tags" | "show" | "ps" | "version" | "generate"),
            "Unsupported Ollama endpoint."
        );
        let url = format!("http://127.0.0.1:{}/api/{endpoint}", self.port);
        let request = match body {
            Some(body) => self.client.post(url).json(body),
            None => self.client.get(url),
        };
        cancellable(token, Some(timeout), async {
            response_json(request.send().await?).await
        })
        .await
    }

    pub async fn chat(
        &self,
        mut body: Value,
        token: &CancellationToken,
        timeout: Duration,
        mut on_text: impl FnMut(&str),
    ) -> Result<Value> {
        body.as_object_mut()
            .context("Chat request must be an object.")?
            .insert("stream".into(), Value::Bool(true));
        cancellable(token, Some(timeout), async {
            let url = format!("http://127.0.0.1:{}/api/chat", self.port);
            let mut response = self.client.post(url).json(&body).send().await?;
            if !response.status().is_success() {
                return response_json(response).await;
            }
            let mut pending = Vec::new();
            let mut collected = ChatStream::default();
            let mut bytes = 0;
            while let Some(chunk) = response.chunk().await? {
                bytes += chunk.len();
                ensure!(
                    bytes <= MAX_STREAM_BYTES,
                    "Local model response is too large."
                );
                pending.extend_from_slice(&chunk);
                if let Some(last_newline) = pending.iter().rposition(|byte| *byte == b'\n') {
                    for line in pending[..last_newline].split(|byte| *byte == b'\n') {
                        collected.consume(line, &mut on_text)?;
                    }
                    pending.drain(..=last_newline);
                }
            }
            collected.consume(&pending, &mut on_text)?;
            collected.finish()
        })
        .await
    }

    pub async fn local_model(
        &self,
        name: &str,
        tags: &Value,
        token: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            !name.contains('/')
                && !name
                    .to_lowercase()
                    .split_once(':')
                    .is_some_and(|(_, tag)| tag.contains("cloud")),
            "Choose an installed Ollama library model."
        );
        let installed = model_entry(tags, name)
            .filter(|entry| entry["size"].as_u64().unwrap_or(0) > 0)
            .context("Choose an installed local model with weights.")?;
        let info = self
            .call(
                "show",
                Some(&json!({"model": name})),
                token,
                Duration::from_secs(30),
            )
            .await?;
        ensure!(
            [installed, &info].into_iter().all(|entry| {
                ["remote_model", "remote_host"]
                    .into_iter()
                    .all(|key| entry[key].as_str().unwrap_or("").is_empty())
                    && entry["remote"] != true
                    && entry["cloud"] != true
            }),
            "Choose a local model; remote and cloud models are unavailable."
        );
        ensure!(
            info["details"]["format"] == "gguf"
                && info["capabilities"]
                    .as_array()
                    .is_some_and(|caps| caps.contains(&json!("completion"))
                        && caps.contains(&json!("tools"))),
            "Choose local weights supporting both completion and tools."
        );
        Ok(info)
    }
}

pub fn model_entry<'a>(response: &'a Value, name: &str) -> Option<&'a Value> {
    response["models"]
        .as_array()?
        .iter()
        .find(|entry| entry["name"].as_str() == Some(name) || entry["model"].as_str() == Some(name))
}

pub fn residency(entry: &Value) -> &'static str {
    match (entry["size"].as_f64(), entry["size_vram"].as_f64()) {
        (Some(size), Some(vram)) if size > 0.0 && vram >= size * 0.99 => "full",
        (_, Some(vram)) if vram > 0.0 => "partial",
        (Some(size), Some(0.0)) if size > 0.0 => "cpu",
        _ => "unknown",
    }
}

#[derive(Default)]
struct ChatStream {
    content: String,
    thinking: String,
    calls: Vec<Value>,
    final_frame: Option<Value>,
}

impl ChatStream {
    fn consume(&mut self, line: &[u8], on_text: &mut impl FnMut(&str)) -> Result<()> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let value: Value = serde_json::from_slice(line).context("Invalid Ollama stream frame.")?;
        if let Some(error) = value["error"].as_str() {
            bail!("{error}");
        }
        if let Some(text) = value["message"]["content"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            self.content.push_str(text);
            on_text(text);
        }
        if let Some(thought) = value["message"]["thinking"].as_str() {
            self.thinking.push_str(thought);
        }
        if let Some(calls) = value["message"]["tool_calls"].as_array() {
            self.calls.extend(calls.iter().cloned());
        }
        if value["done"] == true {
            self.final_frame = Some(value);
        }
        Ok(())
    }

    fn finish(self) -> Result<Value> {
        let mut response = self
            .final_frame
            .context("Ollama returned an incomplete response.")?;
        let mut message = json!({"role":"assistant","content":self.content});
        if !self.thinking.is_empty() {
            message["thinking"] = Value::String(self.thinking);
        }
        if !self.calls.is_empty() {
            message["tool_calls"] = Value::Array(self.calls);
        }
        response["message"] = message;
        Ok(response)
    }
}
