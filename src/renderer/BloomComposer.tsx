import {useEffect,useRef,useState} from 'react';
import {ActionReceipt,AssistantViewAction,ChatMessage,Snapshot,RuntimeStatus} from '../shared/model';
import {dictationActive,dictationSession} from './dictation-session';
import {DictationActions,useDictation} from './Dictation';
import {Icon as PlannerIcon} from './App';
import type {PlannerPreviewTarget} from './BloomControls';
import BloomSettings from './BloomSettings';
import './bloom-composer.css';

function mergeMessages(previous:ChatMessage[],incoming:ChatMessage[]){
  return [...new Map([...previous,...incoming].map(message=>[message.id,message])).values()];
}
const Icon=({name}:{name:string})=><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name==='mic'?<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></>:name==='stop'?<rect x="7" y="7" width="10" height="10" rx="1"/>:name==='check'?<path d="m5 12 4 4L19 6"/>:name==='trash'?<><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>:name==='settings'?<><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></>:name==='chat'?<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H4l1.8-3.7A7.5 7.5 0 1 1 20 11.5Z"/>:<><path d="M5 12h14M13 6l6 6-6 6"/></>}</svg>;
const previewDate = new Intl.DateTimeFormat('en-US', {dateStyle:'medium',timeZone:'UTC'});

function calendarPreview(action:ActionReceipt,snapshot:Snapshot){
 if(action.action==='delete')return null;
 const {entity,id}=action.target;
 if(entity==='task'){
  const date=snapshot.tasks.find(task=>task.id===id)?.dueDate;
  return date?{date,target:{entity:'task',id,calendarDeadline:true} satisfies PlannerPreviewTarget}:null;
 }
 if(entity==='event'){
  const date=snapshot.events.find(event=>event.id===id)?.startDate;
  return date?{date,target:action.target}:null;
 }
 return null;
}

export default function BloomComposer({snapshot,onPreview,onViewAction}:{snapshot:Snapshot;onPreview:(target:PlannerPreviewTarget|null)=>void;onViewAction:(action:AssistantViewAction)=>void}){
 const {preferences}=snapshot;
 const [text,setText]=useState(''),[messages,setMessages]=useState<ChatMessage[]>([]),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[autoSend,setAutoSend]=useState(!!preferences.voiceAutoSend),[settingsOpen,setSettingsOpen]=useState(false),[interimOpen,setInterimOpen]=useState(false),[revealed,setRevealed]=useState<string|null>(null),[reversing,setReversing]=useState<string|null>(null),[removed,setRemoved]=useState<string[]>([]),[cardErrors,setCardErrors]=useState<Record<string,string>>({}),[ticked,setTicked]=useState<string|null>(null),[runtime,setRuntime]=useState<RuntimeStatus|null>(null),[stopping,setStopping]=useState(false);
 const state=useDictation(),active=dictationActive(state.phase),request=useRef(false),textRef=useRef(text),lastVersion=useRef(state.textVersion),bottom=useRef<HTMLDivElement>(null),cancelled=useRef(false),submittedText=useRef(''),modality=useRef<'keyboard'|'mouse'|'touch'>('keyboard');textRef.current=text;
 const settingsButton=useRef<HTMLButtonElement>(null), messageInput=useRef<HTMLInputElement>(null);
 const chatPanel=useRef<HTMLElement>(null), chatToggle=useRef<HTMLButtonElement>(null);
 const [startingChat,setStartingChat]=useState(false), historyReplaced=useRef(false);
 useEffect(()=>{dictationSession.initialize();void window.planner.chatHistory().then(history=>{if(!historyReplaced.current)setMessages(current=>mergeMessages(history,current));}).catch(e=>setError(String(e)));},[]);
 useEffect(()=>{void window.planner.status().then(setRuntime).catch(e=>setError(String(e)));return window.planner.onStatus(setRuntime);},[]);
 useEffect(()=>{setAutoSend(!!preferences.voiceAutoSend);},[preferences.voiceAutoSend]);
 useEffect(()=>{if(lastVersion.current!==state.textVersion){lastVersion.current=state.textVersion;setText(state.text);}},[state.textVersion,state.text]);
 useEffect(()=>{if(open)bottom.current?.scrollIntoView({block:'nearest'});},[messages,open]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{modality.current='keyboard';if(e.key==='Escape'){setRevealed(null);onPreview(null);if(settingsOpen)settingsButton.current?.focus();setSettingsOpen(false);setInterimOpen(false);}};const outside=(e:PointerEvent)=>{modality.current=e.pointerType==='touch'?'touch':'mouse';if(!(e.target instanceof Element)||!e.target.closest('.bloom-action')){setRevealed(null);onPreview(null);}};document.addEventListener('keydown',escape);document.addEventListener('pointerdown',outside);return()=>{document.removeEventListener('keydown',escape);document.removeEventListener('pointerdown',outside);};},[onPreview,settingsOpen]);
 useEffect(()=>{
  if(!open)return;
  const closeOutside=(event:MouseEvent)=>{
   if(chatPanel.current && event.target instanceof Node && !chatPanel.current.contains(event.target) && !chatToggle.current?.contains(event.target))setOpen(false);
  };
  document.addEventListener('click',closeOutside,true);
  return ()=>document.removeEventListener('click',closeOutside,true);
 },[open]);
 const reveal=(id:string|null,target?:PlannerPreviewTarget)=>{setRevealed(id);onPreview(target||null);};
 async function send(value:string){
  if(request.current||!value.trim()||dictationActive(dictationSession.getSnapshot().phase))return;
  request.current=true;cancelled.current=false;submittedText.current=value;setBusy(true);setOpen(true);setError('');
  const trimmed=value.trim(),draft=dictationSession.getSnapshot().draft,requestId=crypto.randomUUID();
  try{
   const check=await window.planner.checkChatInput({text:trimmed});
   if(cancelled.current)return;
   if(!check.fits)throw new Error(check.message||'Please split this message into smaller parts.');
   setMessages(m=>mergeMessages(m,[{id:`${requestId}:user`,role:'user',content:trimmed}]));
   setText(t=>t===value?'':t);
   const result=await window.planner.chat({text:trimmed,requestId});
   setMessages(m=>mergeMessages(m,[{id:`${requestId}:assistant`,role:'assistant',...result}]));
   if(result.status==='failed'||result.status==='interrupted'){setText(current=>current||value);return;}
   if(cancelled.current&&!result.receipt)return;
   if(cancelled.current)setText(current=>current===value?'':current);
   if(draft)await dictationSession.sent(draft.id,draft.generation,value);
   for(const action of result.viewActions||[])onViewAction(action);
  }catch(e){if(!cancelled.current){setError(e instanceof Error?e.message:String(e));setText(t=>t||value);}}
  finally{request.current=false;setBusy(false);setStopping(false);}
 }
 async function newChat(){
  if(request.current||dictationActive(dictationSession.getSnapshot().phase))return;
  request.current=true;
  setStartingChat(true);
  setError('');
  try{
   await window.planner.newChat();
   historyReplaced.current=true;
   setMessages([]);
   reveal(null);
   messageInput.current?.focus();
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{request.current=false;setStartingChat(false);}
 }

 async function stopChat(){if(!request.current||stopping)return;cancelled.current=true;setText(current=>current||submittedText.current);setStopping(true);try{await window.planner.cancelChat();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setStopping(false);}}

 async function toggleMic(){if(active){const result=await dictationSession.stop();if(autoSend&&result?.trim()){lastVersion.current=dictationSession.getSnapshot().textVersion;setText(result);await send(result);}}else await dictationSession.start(textRef.current);}
 async function undo(actionId:string){if(reversing)return;setReversing(actionId);setCardErrors(e=>({...e,[actionId]:''}));try{await window.planner.undoAction({actionId,requestId:crypto.randomUUID()});setRemoved(ids=>[...ids,actionId]);reveal(null);setTimeout(()=>setMessages(m=>m.map(message=>({...message,receipt:message.receipt?{...message.receipt,actions:message.receipt.actions?.map(a=>a.actionId===actionId?{...a,undone:true}:a)}:undefined}))),260);}catch(e){setCardErrors(errors=>({...errors,[actionId]:(e instanceof Error?e.message:String(e)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')}));}finally{setReversing(null);}}

 return <div className={'bloom-composer-area'+(open?' chat-open':'')}>{open&&<section id="bloom-conversation" ref={chatPanel} className="bloom-chat" aria-label="Assistant conversation"><header><strong>LOCAL AI</strong><button type="button" className="bloom-new-chat" disabled={busy||active||startingChat} onClick={()=>void newChat()}>New chat</button><button onClick={()=>{setOpen(false);reveal(null);}} aria-label="Close conversation">×</button></header><div className="bloom-chat-messages">{messages.map(message=><div className={'bloom-message '+message.role} key={message.id}><div className="bloom-message-text">{message.content}</div>{message.receipt?.actions?.filter(action=>!action.undone).map(action=>{
  const calendar=calendarPreview(action,snapshot);
  const dateLabel=calendar ? previewDate.format(new Date(calendar.date+'T00:00:00Z')) : '';
  return <div className={'bloom-action '+action.action+(revealed===action.actionId?' revealed':'')+(removed.includes(action.actionId)?' removing':'')} key={action.actionId} onPointerEnter={e=>{if(e.pointerType==='mouse'){modality.current='mouse';reveal(action.actionId,action.target);}}} onPointerLeave={e=>{if(e.pointerType==='mouse')reveal(null);}} onFocus={e=>{if(modality.current==='keyboard'&&!(e.target instanceof Element&&e.target.closest('.bloom-card-date')))reveal(action.actionId,action.target);}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))reveal(null);}}><button className="bloom-action-title" onClick={()=>reveal(action.actionId,action.target)} aria-expanded={revealed===action.actionId}><span>{action.action==='delete'?'−':'+'}</span><span><small>{action.action.toUpperCase()}</small>{action.title}</span></button>{calendar&&<button type="button" className="bloom-card-date" title={'Show '+dateLabel+' on Calendar'}
    aria-label={'Show '+action.title+' on Calendar, '+dateLabel}
    onPointerEnter={e=>{if(e.pointerType==='mouse')reveal(action.actionId,calendar.target);}}
    onFocus={()=>{if(modality.current==='keyboard')reveal(action.actionId,calendar.target);}}
    onClick={()=>reveal(action.actionId,calendar.target)}><PlannerIcon name="calendar" size={16}/></button>}
   <button className={'bloom-card-tick '+(ticked===action.actionId?'ticked':'')} aria-label={'Mark '+action.title+' acknowledged'} title="Acknowledge" onClick={()=>{setTicked(action.actionId);setTimeout(()=>setTicked(null),400);}}><Icon name="check"/></button><button className="bloom-card-trash" aria-label={'Undo '+action.title} title="Undo action" disabled={reversing===action.actionId||removed.includes(action.actionId)} onClick={()=>void undo(action.actionId)}><Icon name="trash"/></button>{cardErrors[action.actionId]&&<p className="bloom-card-error" role="alert">{cardErrors[action.actionId]}</p>}</div>;})}</div>)}{busy&&<div className="bloom-message assistant bloom-thinking" role="status">{stopping?'Stopping…':runtime?.state==='starting'||runtime?.state==='loading'?runtime.message:'Thinking…'} <button type="button" disabled={stopping} onClick={()=>void stopChat()}>Stop</button></div>}{runtime&&(runtime.state==='starting'||runtime.state==='loading'||runtime.state==='error'||runtime.state==='stopped')&&<div className="bloom-runtime" role={runtime.state==='error'?'alert':'status'}>{runtime.message}{(runtime.state==='error'||runtime.state==='stopped')&&<button onClick={()=>void window.planner.retryRuntime().catch(e=>setError(String(e)))}>Retry</button>}</div>}<div ref={bottom}/></div></section>}
 <div className="bloom-composer-wrap"><div className={'bloom-composer '+(active?'recording':'')}><button className={'bloom-mic '+(active?'active':'')} aria-label={state.phase==='starting'?'Opening microphone':state.phase==='finishing'?'Transcribing':active?'Stop dictation':'Start dictation'} disabled={state.phase==='finishing'} onClick={()=>void toggleMic()}><Icon name={active?'stop':'mic'}/></button><div className="bloom-composer-center"><div className="bloom-composer-meta"><span>LOCAL AI <b>·</b> PRIVATE</span>{active&&<span className="bloom-recording" role="status">● {state.phase==='starting'?'OPENING MICROPHONE':state.phase==='finishing'?'TRANSCRIBING':`RECORDING · ${Math.floor(state.seconds/60)}:${String(state.seconds%60).padStart(2,'0')}`}</span>}{state.phase==='review'&&<span>Final transcript · edit before sending</span>}</div><input ref={messageInput} aria-label="Message local assistant" placeholder="Type a task, schedule a block, or ask anything…" value={text} onChange={e=>{setText(e.target.value);dictationSession.edit(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send(text);}}}/>{state.draft?.liveText&&!active&&<button className="bloom-interim-link" onClick={()=>setInterimOpen(v=>!v)}>{interimOpen?'Hide':'Inspect'} interim</button>}</div><button ref={settingsButton} className="bloom-settings" aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-controls={settingsOpen?"bloom-local-settings":undefined} aria-expanded={settingsOpen} onClick={()=>{setSettingsOpen(v=>!v);setInterimOpen(false);}}><Icon name="settings"/></button><button ref={chatToggle} type="button" className="bloom-chat-toggle"
  aria-label={open?'Hide conversation':'Open conversation'} title={open?'Hide conversation':'Open conversation'}
  aria-controls={open?'bloom-conversation':undefined} aria-expanded={open} onClick={()=>{setOpen(value=>!value);reveal(null);}}>
  <Icon name="chat"/><span>{open?'Hide conversation':'Open conversation'}</span>
 </button><button className="bloom-send" title="Send message" aria-label="Send message" disabled={!text.trim()||active||busy||startingChat} onClick={()=>void send(text)}><Icon name="arrow"/></button></div>{(settingsOpen||interimOpen||state.draft||state.error||error)&&<div className="bloom-composer-extension">{(error||state.error)&&<p role="alert">{error||state.error}</p>}<DictationActions onText={setText} disabled={busy}/>{settingsOpen&&<BloomSettings status={runtime} chatBusy={busy}><fieldset className="bloom-voice-settings"><legend>After dictation</legend><label><input type="radio" name="voice-mode" checked={!autoSend} onChange={()=>{setAutoSend(false);void window.planner.preferences({voiceAutoSend:false}).catch(e=>setError(String(e)));}}/> Edit before Send</label><label><input type="radio" name="voice-mode" checked={autoSend} onChange={()=>{setAutoSend(true);void window.planner.preferences({voiceAutoSend:true}).catch(e=>setError(String(e)));}}/> Send on stop</label></fieldset></BloomSettings>}{interimOpen&&state.draft?.liveText&&<div className="bloom-interim"><strong>Interim transcript</strong><p>{state.draft.liveText}</p></div>}</div>}</div></div>;
}
