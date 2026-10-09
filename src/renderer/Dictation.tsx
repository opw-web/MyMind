import { useEffect, useRef, useState } from 'react';

type Capture={id:number;prefix:string;chunks:Int16Array[];size:number;stream?:MediaStream;context?:AudioContext;source?:MediaStreamAudioSourceNode;node?:AudioWorkletNode;timer?:ReturnType<typeof setInterval>;started:number;heard:boolean;lastSpeech:number;preview?:Promise<void>;previewSize:number;closed:boolean};
function joinPCM(capture:Capture):ArrayBuffer{const joined=new Int16Array(capture.size);let offset=0;for(const chunk of capture.chunks){joined.set(chunk,offset);offset+=chunk.length;}return joined.buffer;}
function closeAudio(capture:Capture){capture.closed=true;clearInterval(capture.timer);capture.node?.disconnect();capture.source?.disconnect();capture.stream?.getTracks().forEach(track=>track.stop());if(capture.context&&capture.context.state!=='closed')void capture.context.close().catch(()=>{});}
function append(prefix:string,transcript:string){return [prefix.trim(),transcript.trim()].filter(Boolean).join(' ');}

export default function Dictation({text,onText,onSend,autoSend,onAutoSend,disabled,onActive,onError}:{text:string;onText:(text:string)=>void;onSend:(text:string)=>void;autoSend:boolean;onAutoSend:(value:boolean)=>void;disabled:boolean;onActive:(active:boolean)=>void;onError:(message:string)=>void}){
  const [state,setState]=useState<'idle'|'starting'|'listening'|'finishing'>('idle'),[level,setLevel]=useState(0),[caption,setCaption]=useState('');
  const current=useRef<Capture|null>(null),counter=useRef(0),auto=useRef(autoSend);auto.current=autoSend;
  const callbacks=useRef({onText,onSend,onError,onActive});callbacks.current={onText,onSend,onError,onActive};
  useEffect(()=>()=>{counter.current++;const capture=current.current;current.current=null;if(capture){closeAudio(capture);onText(capture.prefix);}onActive(false);void window.planner.cancelSpeech();},[]);
  async function cancel(){const capture=current.current;current.current=null;counter.current++;if(capture){closeAudio(capture);callbacks.current.onText(capture.prefix);}setState('idle');setCaption('Dictation cancelled.');setLevel(0);callbacks.current.onActive(false);await window.planner.cancelSpeech();}
  async function finish(capture:Capture){
    if(current.current!==capture||capture.closed)return;
    closeAudio(capture);setState('finishing');setCaption('Finishing your transcript…');setLevel(0);
    try{
      await capture.preview;
      if(current.current!==capture)return;
      if(!capture.heard||capture.size<1600){onText(capture.prefix);setCaption('No speech captured. Try the microphone again.');return;}
      const result=await window.planner.transcribe({pcm:joinPCM(capture),final:true});
      if(current.current!==capture)return;
      const transcript=append(capture.prefix,result.text);onText(transcript.slice(0,4000));
      setCaption(result.text?'':"I didn’t catch that. Try again.");
      if(result.text&&auto.current)callbacks.current.onSend(transcript.slice(0,4000));
    }catch(error){if(current.current===capture){onText(capture.prefix);setCaption('Dictation failed. Tap the microphone to retry.');callbacks.current.onError(error instanceof Error?error.message:String(error));}}
    finally{if(current.current===capture){current.current=null;setState('idle');onActive(false);}}
  }
  async function start(){
    const capture:Capture={id:++counter.current,prefix:text,chunks:[],size:0,started:performance.now(),heard:false,lastSpeech:performance.now(),previewSize:0,closed:false};
    current.current=capture;setState('starting');setCaption('Opening your microphone…');onActive(true);
    const ready=window.planner.startSpeech();void ready.catch(()=>{});
    try{
      capture.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(current.current!==capture){closeAudio(capture);return;}
      capture.context=new AudioContext({sampleRate:16000});
      await capture.context.audioWorklet.addModule(new URL('pcm-worklet.js',document.baseURI).href);
      if(current.current!==capture){closeAudio(capture);return;}
      capture.source=capture.context.createMediaStreamSource(capture.stream);capture.node=new AudioWorkletNode(capture.context,'microphone-pcm');
      capture.node.port.onmessage=(event:MessageEvent<Float32Array>)=>{
        if(current.current!==capture||capture.closed)return;
        const values=event.data;let sum=0;const chunk=new Int16Array(Math.min(values.length,720000-capture.size));
        for(let i=0;i<chunk.length;i++){sum+=values[i]*values[i];chunk[i]=Math.round(Math.max(-1,Math.min(1,values[i]))*32767);}
        if(!chunk.length){void finish(capture);return;}
        capture.chunks.push(chunk);capture.size+=chunk.length;
        const rms=Math.sqrt(sum/chunk.length);setLevel(Math.min(1,rms*10));
        if(rms>0.008){capture.heard=true;capture.lastSpeech=performance.now();}
      };
      capture.source.connect(capture.node);capture.node.connect(capture.context.destination);await capture.context.resume();
      capture.started=performance.now();setState('listening');setCaption('Listening… speak naturally.');
      capture.timer=setInterval(()=>{
        if(current.current!==capture||capture.closed)return;
        const now=performance.now();
        if(capture.size>=720000||(capture.heard&&now-capture.lastSpeech>1600)||(!capture.heard&&now-capture.started>8000)){void finish(capture);return;}
        if(capture.size<16000||capture.preview||capture.previewSize===capture.size||!capture.heard)return;
        capture.previewSize=capture.size;
        const preview=(async()=>{try{await ready;if(current.current!==capture||capture.closed)return;const result=await window.planner.transcribe({pcm:joinPCM(capture),final:false});if(current.current===capture&&!capture.closed&&result.text){onText(append(capture.prefix,result.text).slice(0,4000));setCaption('Listening… transcript updates as you speak.');}}catch(error){if(current.current===capture&&!capture.closed){onError(error instanceof Error?error.message:String(error));void cancel();}}finally{capture.preview=undefined;}})();capture.preview=preview;
      },1000);
    }catch(error){closeAudio(capture);if(current.current===capture){current.current=null;setState('idle');onActive(false);await window.planner.cancelSpeech();const message=error instanceof DOMException&&error.name==='NotAllowedError'?'Microphone access is blocked. Allow microphone access for desktop apps in Windows settings.':error instanceof Error?error.message:String(error);onError(message);}}
  }
  return <>
    <button type="button" className={`mic-button ${state!=='idle'?'recording':''}`} aria-label={state==='idle'?'Start dictation':state==='finishing'?'Finishing dictation':'Stop dictation'} aria-pressed={state!=='idle'} title={state==='idle'?'Dictate with local Faster Whisper':'Stop and finish your transcript'} disabled={disabled||state==='finishing'} onClick={()=>{if(state==='idle')void start();else if(current.current)void finish(current.current);}}>
      {state==='idle'?<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6"/></svg>:state==='finishing'?<span className="speech-spinner"/>:<span className="mic-stop"/>}
    </button>
    <div className={`dictation-strip ${state!=='idle'?'active':''}`} aria-live="polite"><span className="dictation-caption">{state!=='idle'&&<span className="voice-meter" aria-label="Microphone audio level"><i style={{width:`${Math.max(5,level*100)}%`}}/></span>}{caption||'Local voice input'}</span>{state!=='idle'?<button type="button" className="dictation-cancel" onClick={()=>void cancel()}>Cancel dictation</button>:<label className="voice-option"><input type="checkbox" checked={autoSend} onChange={e=>onAutoSend(e.target.checked)}/>Send after a pause</label>}</div>
  </>;
}
