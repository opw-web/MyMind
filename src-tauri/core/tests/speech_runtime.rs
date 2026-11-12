#![cfg(unix)]

use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};

use mymind_core::speech::SpeechRuntime;
use uuid::Uuid;

const WORKER: &str = r#"
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

assert os.environ['HF_HUB_OFFLINE'] == '1'
assert os.environ['HF_HUB_DISABLE_TELEMETRY'] == '1'
token = os.environ.pop('MYMIND_SPEECH_TOKEN')
assert len(token) == 36
assert sys.flags.isolated and sys.dont_write_bytecode
assert Path(sys.argv[2]).name == 'model'
assert Path(sys.argv[3]).name == 'tts'
assert Path(sys.argv[4]).name == 'preview-model'
root = Path(__file__).parent

class Worker(BaseHTTPRequestHandler):
    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def check_auth(self):
        if self.headers.get('Authorization') == 'Bearer ' + token:
            return True
        self.reply({'error': 'Unauthorized'}, 403)
        return False

    def do_GET(self):
        if self.check_auth():
            if (root / 'hold-startup').exists():
                (root / 'loading').touch()
                self.reply({'state': 'loading'})
            elif (root / 'load-error').exists():
                self.reply({'state': 'error', 'message': 'Could not load local dictation: fixture'})
            else:
                self.reply({'state': 'ready'})

    def do_POST(self):
        if not self.check_auth():
            return
        raw = self.rfile.read(int(self.headers['Content-Length']))
        if self.path == '/preview':
            assert self.headers['Content-Type'] == 'application/octet-stream'
            assert unquote(self.headers['X-Speech-Hints']) == 'é A/B' + 'q' * 695
            assert raw == bytes(4)
            self.reply({'words': [{'text': ' words', 'start': 0.5, 'end': 1.25}]})
        elif self.path == '/transcribe':
            assert self.headers['Content-Type'] == 'audio/webm;codecs=opus'
            assert len(self.headers['X-Request-Id']) == 36
            if raw == b'wait':
                (root / 'transcribing').touch()
                for _ in range(200):
                    if (root / 'cancelled').exists():
                        return
                    time.sleep(0.01)
                return
            if self.headers.get('X-Stream-Progress') != '1':
                return self.reply({'text': 'hello', 'confidence': 0.75})
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.end_headers()
            self.wfile.write(b'{"type":"progress","text":"caf\xc3')
            self.wfile.flush()
            time.sleep(0.03)
            self.wfile.write(b'\xa9","seconds":1.25}\n')
            self.wfile.flush()
            if raw == b'progress':
                for _ in range(200):
                    if (root / 'progress-received').exists():
                        break
                    time.sleep(0.01)
                else:
                    return
            if raw == b'error':
                self.wfile.write(b'{"type":"error","error":"Fixture failed."}\n')
            elif raw != b'incomplete':
                self.wfile.write(b'{"type":"result","text":"hello","confidence":0.75}')
        elif self.path == '/speak':
            assert json.loads(raw)['text'] == 'hello'
            assert len(json.loads(raw)['requestId']) == 36
            self.reply({'pcm': 'AACAPw==', 'sampleRate': 24000})
        elif self.path == '/cancel':
            (root / 'cancelled').write_text(json.loads(raw)['requestId'])
            self.reply({'cancelled': True})

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), Worker).serve_forever()
"#;

fn fixture(root: &Path) {
    let output = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let executable = String::from_utf8(output.stdout).unwrap();
    fs::create_dir(root.join("python")).unwrap();
    std::os::unix::fs::symlink(executable.trim(), root.join("python/python.exe")).unwrap();
    for model in ["model", "preview-model"] {
        fs::create_dir(root.join(model)).unwrap();
        fs::write(root.join(model).join("model.bin"), []).unwrap();
    }
    fs::write(root.join("worker.py"), WORKER).unwrap();
}

#[tokio::test]
async fn starts_one_authenticated_worker_and_validates_speech_outputs() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let speech = SpeechRuntime::new(root.path().into()).unwrap();
    assert_eq!(speech.status().state, "idle");
    let (first, second) = tokio::join!(speech.start(), speech.start());
    let first = first.unwrap();
    assert_eq!(first.state, "ready");
    assert_eq!(first.pid, second.unwrap().pid);

    let id = Uuid::new_v4().to_string();
    let hints = format!("é A/B{}", "q".repeat(710));
    let preview = speech
        .preview(vec![0; 4], 16000, 4.0, &id, &hints)
        .await
        .unwrap();
    assert_eq!(preview.words[0].text, " words");
    assert_eq!(preview.words[0].start, 4.5);
    assert_eq!(preview.words[0].end, 5.25);
    assert!(
        speech
            .preview(f32::NAN.to_le_bytes().to_vec(), 16000, 0.0, &id, "")
            .await
            .is_err()
    );

    let mut progress = Vec::new();
    let result = speech
        .transcribe(
            b"progress".to_vec(),
            "audio/webm;codecs=opus",
            &id,
            "",
            Some(&mut |p| {
                progress.push(p);
                fs::write(root.path().join("progress-received"), []).unwrap();
            }),
        )
        .await
        .unwrap();
    assert_eq!(progress.len(), 1);
    assert_eq!(progress[0].text, "café");
    assert_eq!(progress[0].seconds, 1.25);
    assert_eq!(result.text, "hello");
    assert_eq!(result.confidence, Some(0.75));
    for (audio, error) in [
        (b"error".as_slice(), "Fixture failed."),
        (b"incomplete", "Invalid transcription response."),
    ] {
        let result = speech
            .transcribe(
                audio.to_vec(),
                "audio/webm;codecs=opus",
                &id,
                "",
                Some(&mut |_| {}),
            )
            .await;
        assert_eq!(result.unwrap_err().to_string(), error);
    }
    let result = speech
        .transcribe(vec![1], "audio/webm;codecs=opus", &id, "", None)
        .await
        .unwrap();
    assert_eq!(result.text, "hello");
    let output = speech.speak(" hello ").await.unwrap();
    assert_eq!(output.sample_rate, 24000);
    assert_eq!(output.pcm, 1f32.to_le_bytes());

    speech.stop();
    assert_eq!(speech.status().state, "stopped");
    assert!(speech.start().await.is_err());
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", first.port.unwrap()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cancelling_a_transcription_interrupts_the_request_and_keeps_the_worker_ready() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let speech = Arc::new(SpeechRuntime::new(root.path().into()).unwrap());
    let id = Uuid::new_v4().to_string();
    let job = tokio::spawn({
        let (speech, id) = (speech.clone(), id.clone());
        async move {
            speech
                .transcribe(b"wait".to_vec(), "audio/webm;codecs=opus", &id, "", None)
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.path().join("transcribing").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let duplicate = speech
        .transcribe(vec![1], "audio/webm;codecs=opus", &id, "", None)
        .await;
    assert!(
        duplicate
            .unwrap_err()
            .to_string()
            .contains("already being transcribed")
    );
    speech.cancel(Some(&id)).await.unwrap();
    assert_eq!(
        job.await.unwrap().unwrap_err().to_string(),
        "Dictation cancelled."
    );
    assert_eq!(
        fs::read_to_string(root.path().join("cancelled")).unwrap(),
        id
    );
    assert_eq!(speech.status().state, "ready");
    let next = Uuid::new_v4().to_string();
    assert!(
        speech
            .transcribe(vec![1], "audio/webm;codecs=opus", &next, "", None)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn startup_failure_reports_health_error_and_allows_retry() {
    let root = tempfile::tempdir().unwrap();
    let speech = SpeechRuntime::new(root.path().into()).unwrap();
    assert!(
        speech
            .start()
            .await
            .unwrap_err()
            .to_string()
            .contains("runtime is missing")
    );
    assert_eq!(speech.status().state, "error");
    fixture(root.path());
    fs::write(root.path().join("load-error"), []).unwrap();
    assert_eq!(
        speech.start().await.unwrap_err().to_string(),
        "Could not load local dictation: fixture"
    );
    assert!(speech.status().pid.is_none());
    fs::remove_file(root.path().join("load-error")).unwrap();
    assert_eq!(speech.start().await.unwrap().state, "ready");
}

#[tokio::test]
async fn stop_interrupts_shared_startup_and_releases_the_worker() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    fs::write(root.path().join("hold-startup"), []).unwrap();
    let speech = Arc::new(SpeechRuntime::new(root.path().into()).unwrap());
    let startup = tokio::spawn({
        let speech = speech.clone();
        async move { speech.start().await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !root.path().join("loading").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let status = speech.status();
    assert_eq!(status.state, "loading");
    let port = status.port.unwrap();
    speech.stop();
    assert_eq!(
        startup.await.unwrap().unwrap_err().to_string(),
        "MYMIND is closing."
    );
    assert_eq!(speech.status().state, "stopped");
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
    );
}
