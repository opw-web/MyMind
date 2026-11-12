"""Synthetic planner vocabulary complements the real-reader speech corpus."""
from pathlib import Path
import json
import wave
import numpy as np
import onnxruntime as rt
from kokoro_onnx import Kokoro

root=Path(__file__).resolve().parent.parent
output=root/'test-results'/'voice-vocabulary'
output.mkdir(parents=True,exist_ok=True)
options=rt.SessionOptions();options.intra_op_num_threads=4
session=rt.InferenceSession(str(root/'speech-runtime'/'tts'/'kokoro-v1.0.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
model=Kokoro.from_session(session,str(root/'speech-runtime'/'tts'/'voices-v1.0.bin'))
sentences=[('Explain how the to-do list works.', 'to[- ]?do list'),('Delete the cornhole prototype event for today.', 'cornhole.*prototype'),('Add a college assignment due tomorrow.', 'assignment.*tomorrow'),('Add a chemistry exam next Friday.', 'exam.*Friday'),('Show my submissions for tomorrow.', 'submissions.*tomorrow'),('Do not delete this event.', '(?:do not|don.t).*delete')]
manifest=[]
for voice,lang in [('bm_george','en-gb'),('af_sarah','en-us')]:
    for index,(text,pattern) in enumerate(sentences):
        samples,rate=model.create(text,voice=voice,speed=1.0,lang=lang)
        audio=np.interp(np.arange(int(len(samples)*16000/rate))*rate/16000,np.arange(len(samples)),samples)
        with wave.open(str(output/f'{voice}-{index}.wav'),'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(np.round(np.clip(audio,-1,1)*32767).astype('<i2').tobytes())
        manifest.append({'file':f'{voice}-{index}.wav','text':text,'pattern':pattern,'voice':voice})
(output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'clips':len(manifest)}))
