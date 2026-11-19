import {useEffect,useRef,useSyncExternalStore} from 'react';
import {dictationSession,dictationActive} from './dictation-session';
import CommandOrb from './CommandOrb';
import {Icon} from './App';
const elapsed=(seconds:number)=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
export function useDictation(){return useSyncExternalStore(dictationSession.subscribe,dictationSession.getSnapshot);}
export default function Dictation({text,onText,disabled,autoStart=false}:{text:string;onText:(text:string)=>void;disabled:boolean;autoStart?:boolean}){
  const state=useDictation(),active=dictationActive(state.phase);
  useEffect(()=>{if(autoStart&&!disabled&&!active&&!state.draft&&document.hasFocus()&&!document.hidden){const timer=setTimeout(()=>void dictationSession.start(text),250);return()=>clearTimeout(timer);}},[autoStart,disabled,active,!!state.draft]);
  return <button type="button" className={'mic-button '+(active?'recording':'')} aria-label={!active?'Start dictation':state.phase==='finishing'?'Finishing dictation':'Stop dictation'} aria-pressed={active} disabled={state.phase==='finishing'||(disabled&&!active)} onClick={()=>{if(!active)void dictationSession.start(text);else void dictationSession.stop();}}>
      {!active?<Icon name="mic" size={20}/>:state.phase==='finishing'?<span className="speech-spinner"/>:<span className="mic-stop"/>}<span>{!active?'Record':state.phase==='finishing'?'Transcribing…':'Stop'}</span>
    </button>;
}
export function DictationActions({onText,disabled}:{onText:(text:string)=>void;disabled:boolean}){
  const state=useDictation(),active=dictationActive(state.phase);
  if(!active&&!state.draft)return null;
  return <div className={'dictation-strip '+(active?'active':'')}><span className="dictation-caption"><span role="status">{state.caption||'Review your transcript before Send'}{state.phase==='listening'&&state.lag>4?' · live text catching up':''}</span></span>
      {!active&&!!state.draft&&(!!state.draft.bytes||state.unsaved)&&<button type="button" className="dictation-cancel" disabled={disabled} onClick={()=>void dictationSession.transcribe()}>Retry transcription</button>}
      {active&&<button type="button" className="dictation-cancel" onClick={()=>void dictationSession.cancel()}>Cancel dictation</button>}
      {!active&&state.draft&&<button type="button" className="dictation-cancel" onClick={()=>{void dictationSession.discard().then(()=>onText(''));}}>Discard draft</button>}
    </div>;
}
export function DictationTranscript(){
  const state=useDictation(),body=useRef<HTMLDivElement>(null),follow=useRef(true),draft=state.draft;
  useEffect(()=>{if(follow.current&&body.current)body.current.scrollTop=body.current.scrollHeight;},[draft?.liveText,state.finalProgress]);
  if(!draft||!(draft.liveText||draft.finalText||dictationActive(state.phase)))return null;
  return <section className="dictation-preview" aria-label="Dictation transcript">{dictationActive(state.phase)&&<div className="recording-focus"><CommandOrb state={state.phase==='listening'?'listening':'working'} size={56}/><h2>{state.phase==='listening'?`Recording · ${elapsed(state.seconds)}`:'Finishing transcription'}</h2>{state.phase==='listening'&&<span className="voice-meter focus-meter" aria-label="Microphone audio level"><i style={{width:Math.max(5,state.level*100)+'%'}}/></span>}</div>}<div className="dictation-preview-heading"><strong>{state.phase==='listening'?'Live transcript':state.phase==='finishing'?'Live text is retained':'Review your transcript'}</strong><small>Review and edit before Send</small></div><div className="dictation-preview-text" ref={body} onScroll={e=>{follow.current=e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<40;}}>{draft.liveText||'Listening for speech…'}</div>{(state.finalProgress||draft.partialText||draft.finalText)&&<details className="transcript-version"><summary>{state.phase==='finishing'?'Final transcription progress':state.finalProgress||draft.partialText?'Partial final transcript':'Final transcript'}</summary><p>{state.finalProgress||draft.partialText||draft.finalText}</p></details>}
    <div className="button-row">{draft.liveText&&<><button type="button" onClick={()=>void navigator.clipboard.writeText(draft.liveText)}>Copy live text</button><button type="button" onClick={()=>void dictationSession.useVersion('live')}>Use live transcript</button></>}{draft.finalText&&state.phase!=='finishing'&&<button type="button" onClick={()=>void dictationSession.useVersion('final')}>Use final transcript</button>}</div>
  </section>;
}
