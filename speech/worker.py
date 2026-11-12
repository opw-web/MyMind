"""Authenticated offline speech worker. Speech decoding stays in RAM; the app saves recoverable local drafts."""
import base64
import io
import json
import math
import os
import secrets
import sys
import threading
import time
from collections import deque
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
TOKEN = os.environ.pop('MYMIND_SPEECH_TOKEN')
MODEL_PATH, TTS_PATH = map(Path, sys.argv[2:4])
STATE = {'state': 'loading', 'message': 'Loading Whisper large-v3-turbo…'}
MODEL = PREVIEW_MODEL = TTS = None
LOCK = threading.Lock()
TTS_LOCK = threading.Lock()
PREVIEW_LOCK = threading.Lock()
JOBS_LOCK = threading.Lock()
JOBS = {}
CANCELLED = deque(maxlen=128)

class SpeechCancelled(Exception):
    pass

def check_cancelled(event):
    if event.is_set():
        raise SpeechCancelled()

def begin_job(request_id):
    if not isinstance(request_id, str) or not request_id or len(request_id) > 100:
        raise ValueError('Invalid request ID.')
    with JOBS_LOCK:
        if request_id in JOBS:
            raise ValueError('Duplicate speech request.')
        event = threading.Event()
        if request_id in CANCELLED:
            event.set()
        JOBS[request_id] = event
    return event

def acquire(lock, event):
    while not lock.acquire(timeout=0.1):
        check_cancelled(event)
    try:
        check_cancelled(event)
    except Exception:
        lock.release()
        raise

def load_model():
    global MODEL, PREVIEW_MODEL
    try:
        from faster_whisper import WhisperModel
        MODEL = WhisperModel(str(MODEL_PATH), device='cpu', compute_type='int8', cpu_threads=8, num_workers=1, local_files_only=True)
        PREVIEW_MODEL = WhisperModel(sys.argv[4], device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
        STATE.update(state='ready', message='Whisper large-v3-turbo · English · local')
    except Exception as exc:
        STATE.update(state='error', message=f'Could not load local dictation: {exc}')

def recognize(encoded, hints, event, progress=None):
    import av
    import numpy as np
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    check_cancelled(event)
    # PyAV 19 removed metadata_errors, which faster-whisper's decoder still passes.
    # Decode and resample here, also allowing cancellation between decoded frames.
    raw = io.BytesIO()
    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    with av.open(io.BytesIO(encoded), mode='r') as container:
        for frame in container.decode(audio=0):
            check_cancelled(event)
            for output in resampler.resample(frame):
                raw.write(output.to_ndarray().tobytes())
        for output in resampler.resample(None):
            raw.write(output.to_ndarray().tobytes())
    audio = np.frombuffer(raw.getbuffer(), dtype='<i2').astype(np.float32)/32768.0
    check_cancelled(event)
    if not audio.size or np.max(np.abs(audio)) < 0.003:
        return {'text': '', 'confidence': 0}
    ranges = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=180, min_silence_duration_ms=450, speech_pad_ms=160))
    check_cancelled(event)
    if not ranges:
        return {'text': '', 'confidence': 0}
    origin = max(0, ranges[0]['start']-2400)
    audio = audio[origin:min(len(audio), ranges[-1]['end']+2400)].copy()
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms > 0.0001:
        audio = np.clip(audio * min(0.12 / rms, 6), -1, 1)
    acquire(LOCK, event)
    try:
        segments, _ = MODEL.transcribe(audio, language='en', beam_size=5, temperature=0, condition_on_previous_text=False, vad_filter=True, initial_prompt=hints or None, no_speech_threshold=0.6)
        parts, log_probs = [], []
        for segment in segments:
            check_cancelled(event)
            parts.append(segment.text.strip())
            log_probs.append(segment.avg_logprob)
            if progress:
                progress({'text':' '.join(parts).strip(), 'seconds':origin/16000+segment.end})
        check_cancelled(event)
        return {'text': ' '.join(parts).strip(), 'confidence': math.exp(sum(log_probs)/len(log_probs)) if log_probs else 0}
    finally:
        LOCK.release()

def preview(raw, hints, event):
    import numpy as np
    from faster_whisper.vad import get_speech_timestamps, VadOptions
    check_cancelled(event)
    if len(raw) % 4 or len(raw) > 16000*4*30:
        raise ValueError('Invalid preview audio.')
    audio = np.frombuffer(raw, dtype='<f4').copy()
    if not np.all(np.isfinite(audio)):
        raise ValueError('Invalid samples.')
    if not audio.size or np.max(np.abs(audio)) < 0.003:
        return {'words':[]}
    ranges = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=100, min_silence_duration_ms=450, speech_pad_ms=160))
    if not ranges:
        return {'words':[]}
    acquire(PREVIEW_LOCK, event)
    try:
        segments, _ = PREVIEW_MODEL.transcribe(audio, language='en', beam_size=1, temperature=0, condition_on_previous_text=False, vad_filter=False, word_timestamps=True, initial_prompt=hints or None)
        words = []
        for segment in segments:
            check_cancelled(event)
            if segment.no_speech_prob > 0.6 or segment.avg_logprob < -1.5:
                continue
            words.extend({'text':word.word, 'start':word.start, 'end':word.end} for word in segment.words or [])
        check_cancelled(event)
        return {'words':words}
    finally:
        PREVIEW_LOCK.release()

def synthesize(text, event):
    global TTS
    import numpy as np
    acquire(TTS_LOCK, event)
    try:
        if TTS is None:
            from kokoro_onnx import Kokoro
            import onnxruntime as rt
            options = rt.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            session = rt.InferenceSession(str(TTS_PATH/'kokoro-v1.0.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
            TTS = Kokoro.from_session(session, str(TTS_PATH/'voices-v1.0.bin'))
        check_cancelled(event)
        samples, rate = TTS.create(text, voice='bm_george', speed=1.05, lang='en-gb')
        check_cancelled(event)
        if len(samples) > rate*300:
            raise ValueError('Reply is too long to speak.')
        return {'pcm': base64.b64encode(np.asarray(samples, dtype='<f4').tobytes()).decode('ascii'), 'sampleRate': rate}
    finally:
        TTS_LOCK.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def authorized(self):
        return secrets.compare_digest(self.headers.get('Authorization',''), f'Bearer {TOKEN}')
    def stream(self, value):
        try:
            self.wfile.write((json.dumps(value, ensure_ascii=False)+'\n').encode('utf-8'))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
    def reply(self, code, value):
        if getattr(self, 'streaming', False):
            return self.stream({'type':'result' if code==200 else 'error', **value})
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
    def do_GET(self):
        if not self.authorized():
            return self.reply(403, {'error':'Unauthorized'})
        self.reply(200, STATE) if self.path == '/health' else self.reply(404, {'error':'Not found'})
    def do_POST(self):
        if not self.authorized():
            return self.reply(403, {'error':'Unauthorized'})
        if self.path not in ['/transcribe','/preview','/speak','/cancel']:
            return self.reply(404, {'error':'Not found'})
        if self.path != '/cancel' and STATE['state'] != 'ready':
            return self.reply(503, {'error':STATE['message']})
        request_id, event = None, None
        try:
            length = int(self.headers.get('Content-Length','0'))
            if length <= 0 or (self.path not in ['/transcribe','/preview'] and length > 100_000) or (self.path == '/preview' and length > 16000*4*30):
                raise ValueError('Invalid speech request length.')
            started = time.monotonic()
            if self.path in ['/transcribe','/preview']:
                request_id = self.headers.get('X-Request-Id')
                event = begin_job(request_id)
                check_cancelled(event)
                mime_type = self.headers.get('Content-Type','')
                if mime_type not in (['application/octet-stream'] if self.path=='/preview' else ['audio/webm;codecs=opus','audio/webm','audio/wav']):
                    raise ValueError('Unsupported audio format.')
                encoded = self.rfile.read(length)
                if len(encoded) != length:
                    raise ValueError('Incomplete audio upload.')
                check_cancelled(event)
                hints = unquote(self.headers.get('X-Speech-Hints',''))[:700]
                if self.path == '/preview':
                    result = preview(encoded, hints, event)
                else:
                    self.streaming = self.headers.get('X-Stream-Progress') == '1'
                    if self.streaming:
                        self.send_response(200)
                        self.send_header('Content-Type','application/x-ndjson')
                        self.send_header('Connection','close')
                        self.end_headers()
                    result = recognize(encoded, hints, event, (lambda value:self.stream({'type':'progress', **value})) if self.streaming else None)
            else:
                data = json.loads(self.rfile.read(length))
                request_id = data.get('requestId')
                if self.path == '/cancel':
                    if not isinstance(request_id, str) or not request_id or len(request_id)>100:
                        raise ValueError('Invalid cancellation.')
                    with JOBS_LOCK:
                        if request_id in JOBS:
                            JOBS[request_id].set()
                        else:
                            CANCELLED.append(request_id)
                    return self.reply(200, {'cancelled':True})
                text = data.get('text')
                if not isinstance(text,str) or not text.strip() or len(text)>4000:
                    raise ValueError('Invalid reply text.')
                event = begin_job(request_id)
                result = synthesize(text, event)
            check_cancelled(event)
            self.reply(200, {**result, 'seconds':time.monotonic()-started})
        except SpeechCancelled:
            self.reply(409, {'error':'Dictation cancelled.'})
        except Exception:
            # Never echo recordings, transcripts, or synthesis input.
            self.reply(400, {'error':'Local speech failed. Retry or use typed chat.'})
        finally:
            if event is not None:
                with JOBS_LOCK:
                    JOBS.pop(request_id, None)

threading.Thread(target=load_model, daemon=True).start()
ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1])), Handler).serve_forever()
