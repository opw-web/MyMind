"""Local Faster Whisper service. Audio stays in memory; no recordings/logs."""
import base64
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

TOKEN = os.environ.pop("MYMIND_SPEECH_TOKEN")
MODEL_PATH = sys.argv[2]
STATE = {"state": "loading", "message": "Loading local dictation…"}
MODEL = None
LOCK = threading.Lock()

def load_model():
    global MODEL
    try:
        from faster_whisper import WhisperModel
        MODEL = WhisperModel(MODEL_PATH, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
        STATE.update(state="ready", message="Local dictation ready")
    except Exception as exc:
        STATE.update(state="error", message=f"Could not load local dictation: {exc}")

def recognize(pcm, final, hints):
    import numpy as np
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    block = 480
    active = [i for i in range(0, len(audio), block) if np.sqrt(np.mean(audio[i:i+block] ** 2)) > 0.006]
    if not active:
        return ""
    audio = audio[max(0, active[0]-2400):min(len(audio), active[-1]+block+2400)].copy()
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms > 0.0001:
        audio = np.clip(audio * min(0.12 / rms, 6.0), -1, 1)
    with LOCK:
        segments, _ = MODEL.transcribe(audio, beam_size=5 if final else 1, temperature=0, language=None, condition_on_previous_text=False, vad_filter=final, initial_prompt=hints or None, no_speech_threshold=0.6)
        return " ".join(segment.text.strip() for segment in segments).strip()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def authorized(self):
        return secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}")
    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
    def do_GET(self):
        if not self.authorized():
            return self.reply(403, {"error": "Unauthorized"})
        self.reply(200, STATE)
    def do_POST(self):
        if not self.authorized():
            return self.reply(403, {"error": "Unauthorized"})
        if self.path != "/transcribe" or STATE["state"] != "ready":
            return self.reply(503, {"error": STATE["message"]})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 2_100_000:
            return self.reply(400, {"error": "Dictation is limited to 45 seconds per turn."})
        try:
            data = json.loads(self.rfile.read(length))
            pcm = base64.b64decode(data["pcm"], validate=True)
            if len(pcm) < 3200 or len(pcm) > 1_440_000 or len(pcm) % 2:
                raise ValueError("Invalid audio length")
            start = time.monotonic()
            text = recognize(pcm, bool(data.get("final")), str(data.get("hints", ""))[:1500])
            self.reply(200, {"text": text, "seconds": time.monotonic()-start})
        except Exception as exc:
            self.reply(400, {"error": str(exc)})

threading.Thread(target=load_model, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
