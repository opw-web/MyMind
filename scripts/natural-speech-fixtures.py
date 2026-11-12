"""Development-only fixtures from real LibriSpeech readers; never ambient audio.
Requires pyarrow and soundfile in the developer's Python, not the shipped worker.
"""
import io
import json
import wave
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq
import soundfile as sf

root=Path(__file__).resolve().parent.parent/'test-results'/'natural-speech'
table=pq.read_table(root/'librispeech.parquet').to_pylist()
selected=[]
speakers=set()
for row in table:
    speaker=row.get('speaker_id',row['id'].split('-')[0])
    if speaker not in speakers:
        speakers.add(speaker)
        selected.append(row)
for row in table:
    if len(selected)>=8:
        break
    if row not in selected:
        selected.append(row)
manifest=[]
for index,row in enumerate(selected):
    audio,rate=sf.read(io.BytesIO(row['audio']['bytes']))
    if rate!=16000:
        audio=np.interp(np.arange(int(len(audio)*16000/rate))*rate/16000,np.arange(len(audio)),audio)
    pcm=np.round(np.clip(audio,-1,1)*32767).astype('<i2')
    path=root/f'natural-{index}.wav'
    with wave.open(str(path),'wb') as output:
        output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000);output.writeframes(pcm.tobytes())
    manifest.append({'file':path.name,'text':row['text'],'speaker':str(row.get('speaker_id','unknown')),'seconds':len(pcm)/16000,'source':'hf-internal-testing/librispeech_asr_dummy, clean validation (LibriSpeech) '})
(root/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'clips':len(manifest),'speakers':len(speakers)}))
