import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';

import {Category,Change,ChatMessage,Color,DraftItem,DraftIssue,EventItem,PendingDraft,Receipt,RuntimeStatus,Selection,Snapshot,Task} from '../shared/model';

import {shortDate,todayIn,weekday} from '../shared/dates';

import {ColorPicker,Dialog,Editor,EditorDialog,Icon} from './App';

import Dictation,{DictationActions,DictationTranscript,RecoveredDictations,useDictation} from './Dictation';
import {Checklist} from './TaskDetails';
import TaskFlow,{FlowPosition,TaskFlowHandle} from './TaskFlow';
import {useTextBox} from './TextBox';
import {blockers,isArchivedTask,COMPLETED_TASK_RETENTION_MS,formatTaskTimestamp} from '../shared/tasks';
import {dictationSession,dictationActive} from './dictation-session';
import BloomCalendar,{CalendarHandle} from './BloomCalendar';
import CommandOrb from './CommandOrb';
import type {OrbState} from './CommandOrb';
import {PixelCat,PixelFlower} from './Pixel';
import {CalendarEntry,calendarEntries,calendarCompletionChanges,calendarEntryChanges} from '../shared/calendar';
import {draftOwns,draftRequiresChange,entryKey,previewSnapshot,resolutionIds} from './preview-state';
import DraftReview from './DraftReview';

type View='calendar'|'tasks';
type Panel=null|'settings'|'categories'|'organize'|'category';

const clean=(error:unknown)=>(error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+': Error: /,'');
const monthTitle=(date:string)=>new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));

function ContextSlider({value,disabled,onChange}:{value:number;disabled:boolean;onChange:(value:number)=>void}){
  return <div className="context-control"><label htmlFor="context-slider"><span className="context-heading">Context window<output htmlFor="context-slider">{(value/1024).toLocaleString()}K</output></span><input id="context-slider" aria-label="Context window" aria-valuetext={`${value.toLocaleString()} tokens`} type="range" min={12} max={20} step={1} value={Math.log2(value)} disabled={disabled} onChange={e=>onChange(2**Number(e.target.value))}/><span className="context-scale" aria-hidden="true"><span>4K</span><span>32K</span><span>256K</span><span>1M</span></span></label><label className="context-exact">Tokens<input aria-label="Context window (tokens)" type="number" min={4096} max={1048576} step={1024} value={value} disabled={disabled} onChange={e=>onChange(Number(e.target.value))}/></label></div>;
}

export default function Workspace(){

  const [saved,setSnapshot]=useState<Snapshot|null>(null),[status,setStatus]=useState<RuntimeStatus|null>(null);

  const [draft,setDraft]=useState<PendingDraft|null>(null),[clarificationIssueId,setClarificationIssueId]=useState<string|null>(null),[calendarKind,setCalendarKind]=useState<'all'|'planned'|'actual'>('all'),[editorDraft,setEditorDraft]=useState(false);
  const snapshot=useMemo(()=>saved?previewSnapshot(saved,draft):null,[saved,draft]);
  const [view,setView]=useState<View>('calendar');

  const [today,setToday]=useState(todayIn()),[lead,setLead]=useState(todayIn()),[clock,setClock]=useState(Date.now());

  const [editor,setEditor]=useState<Editor|null>(null),[day,setDay]=useState<string|null>(null),[selection,setSelection]=useState<Selection|null>(null);

  const [busy,setBusy]=useState(false),[toast,setToast]=useState<{text:string;error?:boolean}|null>(null);

  const [settingsBusy,setSettingsBusy]=useState(false),[models,setModels]=useState<string[]>([]),[selectedModel,setSelectedModel]=useState(''),[contextTokens,setContextTokens]=useState(65536),[activeContext,setActiveContext]=useState<number|null>(null),[settingsError,setSettingsError]=useState('');
  const loadSettings=async()=>{setSettingsBusy(true);setSettingsError('');try{const value=await window.planner.runtimeSettings();setModels(value.models);setSelectedModel(value.model);setContextTokens(value.context);setActiveContext(value.activeContext);}catch(e){setSettingsError(clean(e));}finally{setSettingsBusy(false);}};
  const applySettings=async()=>{setSettingsBusy(true);setSettingsError('');setActiveContext(null);try{await window.planner.configureRuntime({model:selectedModel,context:contextTokens});await loadSettings();}catch(e){setSettingsError(clean(e));}finally{setSettingsBusy(false);}};
  const [taskLayout,setTaskLayout]=useState<'checklist'|'flow'>('checklist');
  const [now,setNow]=useState(Date.now());
  const [hiddenSteps,setHiddenSteps]=useState(new Set<string>());
  const [taskView,setTaskView]=useState<'all'|'today'|'overdue'|'ready'|'blocked'|'archived'>('all'),[filter,setFilter]=useState('all'),[collapsed,setCollapsed]=useState(new Set<string>()),[inline,setInline]=useState<string|null>(null);
  const [hiddenCats,setHiddenCats]=useState(new Set<string>()),[popover,setPopover]=useState(false);

  const [messages,setMessages]=useState<ChatMessage[]>([]),[text,setText]=useState(''),[thinking,setThinking]=useState(false),[progress,setProgress]=useState(''),[trimmed,setTrimmed]=useState(false),[newMessage,setNewMessage]=useState(false);
  const [voiceOptions,setVoiceOptions]=useState(false),[progressStage,setProgressStage]=useState(''),[sheet,setSheet]=useState(false);

  const dictation=useDictation(),dictating=dictationActive(dictation.phase);
  const [voiceMode,setVoiceMode]=useState(false),[spoken,setSpoken]=useState(false),[speaking,setSpeaking]=useState(false);

  const [panel,setPanel]=useState<Panel>(null),[categoryEditor,setCategoryEditor]=useState<Category|{id?:string;title:string;color:Color}|null>(null),[organize,setOrganize]=useState<{changes:Change[];descriptions:string[];revision:number}|null>(null);

  const taskFlow=useRef<TaskFlowHandle>(null),calendar=useRef<CalendarHandle>(null),chatBody=useRef<HTMLDivElement>(null),initial=useRef(true),mounted=useRef(true),saving=useRef(false),pinned=useRef(true),toastTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);

  const active=useRef<{requestId:string;messageId:string;epoch:number;submitted:boolean}|null>(null),epoch=useRef(0),audio=useRef<{context:AudioContext;source?:AudioBufferSourceNode}|null>(null),speechEpoch=useRef(0);

  const navigationTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),navigationEpoch=useRef(0);
  const prior=useRef<{view:View;filter:string;taskView:typeof taskView;taskLayout:typeof taskLayout;hiddenCats:Set<string>;calendarKind:typeof calendarKind;collapsed:Set<string>;hiddenSteps:Set<string>;sheet:boolean;calendar:{left:number;top:number};task:{left:number;top:number};flow?:FlowPosition}|null>(null);
  const restoring=useRef<{calendar?:{left:number;top:number};task?:{left:number;top:number};flow?:FlowPosition}|null>(null);
  useLayoutEffect(()=>{const value=restoring.current;if(!value)return;if(value.calendar){calendar.current?.restore(value.calendar);delete value.calendar;}const el=document.querySelector<HTMLElement>('.task-scroll');if(value.task&&el?.clientWidth){el.scrollLeft=value.task.left;el.scrollTop=value.task.top;delete value.task;}if(value.flow&&taskFlow.current){taskFlow.current.restore(value.flow);delete value.flow;}if(!value.calendar&&!value.task&&!value.flow)restoring.current=null;});
  const notify=useCallback((value:string,error=false)=>{setToast({text:value,error});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(null),error?10000:5000);},[]);

  const refresh=useCallback(async()=>{try{const state=await window.planner.snapshot();if(!mounted.current)return;setSnapshot(state);setToday(todayIn(state.preferences.timezone));if(initial.current){setSpoken(state.preferences.spokenReplies??false);setTaskLayout(state.preferences.taskLayout??'checklist');initial.current=false;}}catch(e){notify(clean(e),true);}},[notify]);

  useEffect(()=>{const media=window.matchMedia('(prefers-color-scheme: dark)');const update=()=>{const appearance=snapshot?.preferences.appearance??'light';document.documentElement.dataset.theme=appearance==='system'?(media.matches?'dark':'light'):appearance;};if(snapshot)update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[snapshot?.preferences.appearance]);
  const preference=(patch:Record<string,unknown>)=>void window.planner.preferences(patch).catch(e=>notify(clean(e),true));

  useEffect(()=>{mounted.current=true;void refresh();void window.planner.status().then(setStatus);const a=window.planner.onChanged(refresh),b=window.planner.onStatus(setStatus),c=window.planner.onChatEvent(event=>{

    if(!active.current||active.current.requestId!==event.requestId)return;

    const id=active.current.messageId;

    if(event.type==='progress'){setProgress(event.message);setProgressStage(event.stage);}

    if(event.type==='text')setMessages(current=>current.map(m=>m.id===id?{...m,content:m.content+event.text}:m));

    if(event.type==='receipt'){setMessages(current=>current.map(m=>m.id===id?{...m,receipt:event.receipt}:m));void refresh();}

    if(event.type==='done')setTrimmed(event.contextTrimmed);

  });return()=>{mounted.current=false;a();b();c();clearTimeout(toastTimer.current);clearTimeout(navigationTimer.current);navigationEpoch.current++;stopAudio();};},[refresh]);

  useEffect(()=>{void window.planner.getDraft().then(setDraft);return window.planner.onDraftChanged(setDraft);},[]);
  useEffect(()=>{setSelection(current=>{if(!current?.draftId)return current;if(!draft)return null;return {...current,draftId:draft.id,draftVersion:draft.version};});if(clarificationIssueId&&!draft?.unresolved.some(i=>i.id===clarificationIssueId&&i.requestId))setClarificationIssueId(null);},[draft]);

  useEffect(()=>{const hide=()=>{if(document.hidden)stopAudio();};document.addEventListener('visibilitychange',hide);window.addEventListener('blur',stopAudio);return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('blur',stopAudio);};},[]);
  useEffect(()=>{dictationSession.initialize();},[]);
  useEffect(()=>{if(dictation.textVersion)setText(dictation.text);},[dictation.textVersion]);
  useEffect(()=>{if(dictation.error)notify(clean(dictation.error),true);},[dictation.error,notify]);
  useEffect(()=>{if(dictating||dictation.draft)setSheet(true);},[dictating,!!dictation.draft]);

  useEffect(()=>{
    const update=()=>setNow(Date.now());
    const expires=snapshot?.tasks.filter(t=>t.completed&&t.completedAt).map(t=>Date.parse(t.completedAt!)+COMPLETED_TASK_RETENTION_MS).filter(time=>time>Date.now())??[];
    const timer=expires.length?setTimeout(update,Math.max(1,Math.min(...expires)-Date.now())):undefined;
    window.addEventListener('focus',update);
    document.addEventListener('visibilitychange',update);
    return()=>{clearTimeout(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};
  },[snapshot?.tasks,now]);

  useEffect(()=>{const update=()=>{setToday(todayIn(snapshot?.preferences.timezone));setClock(Date.now());},timer=setInterval(update,15000);window.addEventListener('focus',update);return()=>{clearInterval(timer);window.removeEventListener('focus',update);};},[snapshot?.preferences.timezone]);

  useEffect(()=>{const input=document.getElementById('assistant-input') as HTMLTextAreaElement|null;if(input){input.style.height='auto';input.style.height=`${Math.min(96,input.scrollHeight)}px`;}},[text]);

  useEffect(()=>{if(!sheet)setVoiceMode(false);},[sheet]);

  useEffect(()=>{if(pinned.current){chatBody.current?.scrollTo({top:chatBody.current.scrollHeight});setNewMessage(false);}else if(messages.length)setNewMessage(true);},[messages,thinking,sheet]);

  useEffect(()=>{const handler=(e:KeyboardEvent)=>{const target=e.target as HTMLElement,editing=['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable;if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='z'&&(!editing||(target?.id==='assistant-input'&&!text.trim()&&!dictating))){e.preventDefault();if(!e.repeat&&snapshot?.canUndo)void undo();}if(e.key==='Escape'&&popover)setPopover(false);};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[snapshot,busy,text,dictating,popover]);

  function stopAudio(){speechEpoch.current++;audio.current?.source?.stop();void audio.current?.context.close().catch(()=>{});audio.current=null;setSpeaking(false);}

  async function speak(content:string){stopAudio();const serial=speechEpoch.current;setSpeaking(true);try{const result=await window.planner.speak({text:content.replace(/[*#`]/g,'')});if(serial!==speechEpoch.current)return;const context=new AudioContext({sampleRate:result.sampleRate}),values=new Float32Array(result.pcm),buffer=context.createBuffer(1,values.length,result.sampleRate);buffer.copyToChannel(values,0);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);audio.current={context,source};source.onended=()=>{if(serial===speechEpoch.current){audio.current=null;void context.close();setSpeaking(false);}};await context.resume();source.start();}catch(e){if(serial===speechEpoch.current){setSpeaking(false);notify(clean(e),true);}}}

  async function save(changes:Change[],label:string,expectedRevision=saved?.revision,forceDraft=false):Promise<boolean>{if(draft&&(forceDraft||changes.some(c=>draftRequiresChange(draft,saved!,c))))return editProposal(changes);if(saving.current||expectedRevision===undefined)return false;saving.current=true;setBusy(true);try{const receipt=await window.planner.mutate({changes,label,expectedRevision,requestId:crypto.randomUUID()});await refresh();notify(receipt.descriptions.filter(d=>!d.includes('category:')).join(' · ')||receipt.label);return true;}catch(e){notify(clean(e),true);await refresh();return false;}finally{saving.current=false;setBusy(false);}}

  async function editProposal(changes:Change[],resolveIssueIds?:string[]):Promise<boolean>{if(!draft||saving.current)return false;saving.current=true;setBusy(true);try{const next=await window.planner.editDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,changes,resolveIssueIds:resolveIssueIds??resolutionIds(draft,changes)});setDraft(next);notify('Proposal updated · not saved');return true;}catch(e){notify(clean(e),true);return false;}finally{saving.current=false;setBusy(false);}}
  function cancelNavigation(){clearTimeout(navigationTimer.current);navigationEpoch.current++;}
  function navigateDraft(item:DraftItem,delay=false){cancelNavigation();if(document.querySelector('dialog[open]')||document.activeElement?.closest('.text-box-popup'))return;const serial=navigationEpoch.current;
    const run=()=>{if(serial!==navigationEpoch.current||!snapshot||!saved||!draft||document.querySelector('dialog[open]')||document.activeElement?.closest('.text-box-popup'))return;
      if(!prior.current){const el=document.querySelector('.task-scroll');prior.current={view,filter,taskView,taskLayout,hiddenCats:new Set(hiddenCats),calendarKind,collapsed:new Set(collapsed),hiddenSteps:new Set(hiddenSteps),sheet,calendar:calendar.current?.position()??{left:0,top:0},task:{left:el?.scrollLeft??0,top:el?.scrollTop??0},flow:view==='tasks'&&taskLayout==='flow'?taskFlow.current?.position():undefined};}
      setSheet(false);setClarificationIssueId(null);
      if(item.entity==='event'){const event=snapshot.events.find(e=>e.id===item.id)??saved.events.find(e=>e.id===item.id);if(!event)return;setView('calendar');setHiddenCats(new Set());setCalendarKind('all');setSelection({entity:'event',entryType:'session',id:item.id,revision:saved.revision,draftId:draft.id,draftVersion:draft.version});calendar.current?.scrollToDate(event.startDate,false,event.startTime);}
      else if(item.entity==='task'){const task=snapshot.tasks.find(t=>t.id===item.id)??saved.tasks.find(t=>t.id===item.id);if(!task)return;setView('tasks');setFilter('all');setTaskLayout('checklist');setTaskView(isArchivedTask(task,now)?'archived':'all');setCollapsed(c=>{const n=new Set(c);n.delete(task.projectId);return n;});setHiddenSteps(c=>{const n=new Set(c);n.delete(task.id);return n;});setSelection({entity:'task',id:item.id,revision:saved.revision,draftId:draft.id,draftVersion:draft.version});requestAnimationFrame(()=>requestAnimationFrame(()=>{if(serial===navigationEpoch.current){const target=Array.from(document.querySelectorAll<HTMLElement>('[data-task-id]')).find(e=>e.dataset.taskId===task.id&&e.getClientRects().length>0);target?.scrollIntoView({block:'nearest',behavior:'instant'});}}));}
    };if(delay)navigationTimer.current=setTimeout(run,120);else run();
  }
  function restoreNavigation(){cancelNavigation();const value=prior.current;prior.current=null;if(!value)return;restoring.current={calendar:value.calendar,task:value.task,flow:value.flow};setView(value.view);setFilter(value.filter);setTaskView(value.taskView);setTaskLayout(value.taskLayout);setHiddenCats(value.hiddenCats);setCalendarKind(value.calendarKind);setCollapsed(value.collapsed);setHiddenSteps(value.hiddenSteps);setSheet(value.sheet);}
  async function dismissProposal(){if(!draft)return;try{await window.planner.dismissDraft({draftId:draft.id,version:draft.version});setDraft(null);setSelection(null);setClarificationIssueId(null);restoreNavigation();}catch(e){notify(clean(e),true);}}
  async function applyProposal(){if(!draft)return;setBusy(true);try{const receipt=await window.planner.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:crypto.randomUUID()});setDraft(null);prior.current=null;setSelection(null);setMessages(current=>[...current,{id:crypto.randomUUID(),role:'assistant',content:'',receipt}]);await refresh();notify('Saved to your planner · Undo is available');}catch(e){notify(clean(e),true);}finally{setBusy(false);}}
  async function refreshProposal(){if(!draft||!saved)return;setBusy(true);try{setDraft(await window.planner.editDraft({draftId:draft.id,version:draft.version,expectedRevision:saved.revision,repreview:true}));}catch(e){notify(clean(e),true);}finally{setBusy(false);}}
  function openDraftItem(item:DraftItem){cancelNavigation();if(!snapshot)return;const record=item.entity==='event'?snapshot.events.find(e=>e.id===item.id):item.entity==='task'?snapshot.tasks.find(t=>t.id===item.id):null;if(record){openItem(record);setEditorDraft(true);}else if(item.entity==='project'){const value=snapshot.projects.find(i=>i.id===item.id);if(value){openEditor({kind:'project',item:value});setEditorDraft(true);}}else if(item.entity==='section'){const value=snapshot.sections.find(i=>i.id===item.id);if(value){openEditor({kind:'section',item:value,projectId:value.projectId});setEditorDraft(true);}}else if(item.entity==='category'){const value=snapshot.categories.find(i=>i.id===item.id);if(value)setCategoryEditor(value);}}
  async function resolveConflict(issue:DraftIssue,source:'saved'|'proposed'){if(!draft||!saved||!issue.entity||!issue.targetId)return;const state=source==='saved'?saved:draft.projectedSnapshot,key=({task:'tasks',event:'events',project:'projects',section:'sections',category:'categories'} as const)[issue.entity],record=state[key].find(i=>i.id===issue.targetId) as unknown as Record<string,unknown>|undefined;if(!record){notify('This item no longer exists. Dismiss and make a new proposal.',true);return;}const fields=Object.fromEntries((issue.conflictingFields??[]).map(field=>[field,record[field]]));await editProposal([{action:'update',entity:issue.entity,id:issue.targetId,fields}],[issue.id]);}

  async function undo(revision?:number){if(busy)return;setBusy(true);try{const result=await window.planner.undo(revision);await refresh();notify(result.label);}catch(e){notify(clean(e),true);}finally{setBusy(false);}}

  function openEditor(next:Editor){cancelNavigation();setEditorDraft(false);setDay(null);setPopover(false);setEditor(next);}

  function openItem(item:EventItem|Task|CalendarEntry){const isEvent='startDate'in item,entry=isEvent?(item as CalendarEntry).entryType??'session':undefined,target=entry==='deadline'?snapshot!.tasks.find(t=>t.id===(item as EventItem).linkedTaskId)!:item;setSelection({entity:isEvent?'event':'task',id:item.id,entryType:entry,revision:saved!.revision,...(draft&&draftOwns(draft,{entity:entry==='deadline'?'task':isEvent?'event':'task',id:target.id})?{draftId:draft.id,draftVersion:draft.version}:{})});openEditor('startDate'in target?{kind:'event',item:target,date:target.startDate}:{kind:'task',item:target as Task});setEditorDraft(!!draft&&draftOwns(draft,{entity:'startDate'in target?'event':'task',id:target.id}));}

  function openReceipt(receipt:Receipt){const item=receipt.items?.flatMap(target=>[...snapshot!.events,...snapshot!.tasks].filter(item=>item.id===target.id&&(target.entity==='event'||target.entity==='task')))[0];if(item)openItem(item);}

  function openPanel(next:Panel){setPopover(false);setPanel(next);if(next==='settings')void loadSettings();}
  function closePanel(){setPanel(null);setCategoryEditor(null);setOrganize(null);}
  async function openOrganize(){try{setOrganize(await window.planner.organizePreview());openPanel('organize');}catch(error){notify(clean(error),true);}}

  async function newChat(){
    setVoiceMode(false);stopAudio();void window.planner.cancelChat();epoch.current++;active.current=null;setThinking(false);
    try{await dictationSession.detach();setProgress('');setMessages([]);setText('');setSelection(null);setClarificationIssueId(null);restoreNavigation();setTrimmed(false);setNewMessage(false);await window.planner.newChat();setText('');await refresh();}catch(e){notify(clean(e),true);}
  }


  async function sendText(value:string){
    if(dictating||!value.trim()||active.current)return;
    stopAudio();setSheet(true);
    const requestId=crypto.randomUUID(),messageId=crypto.randomUUID(),currentEpoch=epoch.current,voiceDraft=dictationSession.getSnapshot().draft;
    active.current={requestId,messageId,epoch:currentEpoch,submitted:false};
    setThinking(true);setProgress('Checking your message');
    let submitted=false;
    try{
      const selected=selection&&snapshot?(selection.entity==='event'?calendarEntries(snapshot).find(i=>i.id===selection.id&&i.entryType===(selection.entryType??'session')):snapshot.tasks.find(i=>i.id===selection.id)):undefined;
      const input={text:value.trim(),...(selected?{selection:{...selection!,revision:saved!.revision,...(selection?.draftId&&draft?{draftId:draft.id,draftVersion:draft.version}:{})}}:{}),...(clarificationIssueId?{clarificationIssueId}:{})};
      const check=await window.planner.checkChatInput(input);
      if(currentEpoch!==epoch.current||active.current?.requestId!==requestId)return;
      if(!check.fits){notify(check.message||'Please split this message into smaller parts.',true);return;}
      active.current.submitted=true;submitted=true;pinned.current=true;
      setText(current=>current===value?'':current);setProgress('Understanding your request');
      setMessages(current=>[...current,{id:crypto.randomUUID(),role:'user',content:value.trim()},{id:messageId,role:'assistant',content:''}]);
      const result=await window.planner.chat({...input,requestId});
      if(voiceDraft)await dictationSession.sent(voiceDraft.id,voiceDraft.generation,value);
      if(currentEpoch!==epoch.current)return;
      setMessages(current=>current.map(m=>m.id===messageId?{...m,...result}:m));setTrimmed(!!result.contextTrimmed);
      if(result.receipt)await refresh();
      if(spoken&&result.content&&document.visibilityState==='visible'&&document.hasFocus())void speak(result.content);
    }catch(e){
      if(currentEpoch===epoch.current){
        if(submitted){setText(current=>current.trim()?current:value);setMessages(current=>current.map(m=>m.id===messageId?{...m,content:m.content?`${m.content}\n\n${clean(e)}`:clean(e)}:m));}
        else notify(clean(e),true);
      }
    }finally{
      if(currentEpoch===epoch.current&&active.current?.requestId===requestId){active.current=null;setThinking(false);setProgress('');}
    }
  }

  function drag(e:React.DragEvent,entity:'event'|'task',id:string,anchor?:string){e.dataTransfer.setData('application/mymind',JSON.stringify({entity,id,anchor}));e.dataTransfer.effectAllowed='move';}

  function dropTask(e:React.DragEvent,projectId:string,sectionId:string|null,before?:Task){e.preventDefault();e.stopPropagation();try{const d=JSON.parse(e.dataTransfer.getData('application/mymind'));if(d.entity!=='task'||!snapshot)return;const item=snapshot.tasks.find(t=>t.id===d.id);if(!item)return;const tasks=snapshot.tasks.filter(t=>t.projectId===projectId&&t.sectionId===sectionId&&t.id!==d.id),at=before?tasks.findIndex(t=>t.id===before.id):tasks.length;tasks.splice(at<0?tasks.length:at,0,item);void save(tasks.map((t,order)=>({action:'update',entity:'task',id:t.id,fields:{projectId,sectionId,order}})),'Move task');}catch{}}

  const textBox=useTextBox(snapshot,save);

  if(!snapshot)return <div className="loading-screen"><PixelFlower size={56}/><h1>MYMIND</h1><p>Opening your planner…</p>{toast&&<p role="alert">{toast.text}</p>}</div>;

  const category=(item:EventItem|Task)=>snapshot.categories.find(c=>c.id===item.categoryId);

  const badge=(item:EventItem|Task)=>category(item)&&<span className={`category-badge color-${item.color}`}>{category(item)!.title}</span>;

  const categoryTasks=snapshot.tasks.filter(t=>filter==='all'||(filter==='none'?!t.categoryId:t.categoryId===filter));
  const visible=categoryTasks.filter(t=>!isArchivedTask(t,now)),archived=categoryTasks.filter(t=>isArchivedTask(t,now)).sort((a,b)=>(b.completedAt??'').localeCompare(a.completedAt??''));

  const todayTasks=visible.filter(t=>t.dueDate===today),overdue=visible.filter(t=>t.dueDate&&t.dueDate<today&&!t.completed);

  const ready=visible.filter(t=>!t.completed&&!blockers(t,snapshot.tasks).length),blocked=visible.filter(t=>!t.completed&&blockers(t,snapshot.tasks).length);
  const focused=taskView==='today'?todayTasks:taskView==='overdue'?overdue:taskView==='ready'?ready:taskView==='archived'?archived:blocked;
  const viewLabels={all:'All tasks',today:'Today',overdue:'Overdue',ready:'Ready',blocked:'Blocked',archived:'Archived'};
  const blockedNotice=(task:Task)=>!task.completed&&blockers(task,snapshot.tasks).length>0&&<div className="blocked-warning" role="status">Blocked by {blockers(task,snapshot.tasks).map((t,index)=><React.Fragment key={t.id}>{index>0&&', '}<button onClick={()=>openItem(t)} title="Open prerequisite">{t.title}</button></React.Fragment>)}<span className="blocked-hint">You can still complete this task.</span></div>;

  const taskRow=(task:Task)=>{
    const stepsDone=task.steps.filter(s=>s.completed).length,open=task.steps.length>0&&!hiddenSteps.has(task.id);
    return <div key={task.id} data-task-id={task.id} className={`task-entry task-row ${draftOwns(draft,{entity:'task',id:task.id})?'preview-proposed':''} ${task.completed?'is-completed task-done':''} ${selection?.id===task.id?'selected-item':''}`} draggable={inline!==task.id} onDragStart={e=>drag(e,'task',task.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>dropTask(e,task.projectId,task.sectionId,task)}>
      <div className="task-main-row">
        <button className={`task-check ${task.completed?'checked':''}`} aria-label={`${task.completed?'Reopen':'Complete'} ${task.title}`} disabled={busy} onClick={()=>void save([{action:'update',entity:'task',id:task.id,fields:{completed:!task.completed}}],task.completed?'Reopen task':'Complete task')}>{task.completed&&<Icon name="check" size={13}/>}</button>
        <div className="task-content">
          {inline===task.id?<input autoFocus aria-label="Edit task title" defaultValue={task.title} onBlur={e=>{const title=e.target.value.trim();setInline(null);if(title&&title!==task.title)void save([{action:'update',entity:'task',id:task.id,fields:{title}}],'Edit task');}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){e.currentTarget.value=task.title;e.currentTarget.blur();}}}/>:<button className="task-title task-title-button" onClick={()=>{openItem(task);}}>{task.title}</button>}
          {task.notes&&<span className="task-notes">{task.notes}</span>}
          <div className="task-meta">{task.dueDate&&<span className={'task-due '+(task.dueDate<today&&!task.completed?'overdue':'')}><Icon name="clock" size={12}/>Deadline {shortDate(task.dueDate)}{task.dueDate<today&&!task.completed?' · Overdue':''}</span>}{snapshot.events.some(e=>e.linkedTaskId===task.id)&&<span className="task-sessions"><Icon name="calendar" size={12}/>On Calendar</span>}{badge(task)}{taskView==='archived'&&<><span>Created: {formatTaskTimestamp(task.createdAt,snapshot.preferences.timezone)}</span><span>Completed: {formatTaskTimestamp(task.completedAt,snapshot.preferences.timezone)}</span></>}</div>
        </div>
        {task.steps.length>0&&<button className="steps-toggle step-progress" aria-label={`Toggle steps for ${task.title}`} aria-expanded={open} onClick={()=>setHiddenSteps(current=>{const next=new Set(current);if(next.has(task.id))next.delete(task.id);else next.add(task.id);return next;})}>{stepsDone}/{task.steps.length} steps done <Icon name={open?'up':'down'} size={12}/></button>}
        <select className="row-category" aria-label={`Category for ${task.title}`} value={task.categoryId??''} onChange={e=>void save([{action:'update',entity:'task',id:task.id,fields:{categoryId:e.target.value||null,colorOverride:null}}],'Change category')}><option value="">Uncategorized</option>{snapshot.categories.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>
        <div className="task-actions"><button className="icon-button tiny-action" aria-label={`Edit task ${task.title}`} onClick={()=>openItem(task)}><Icon name="edit" size={15}/></button>{textBox.button(task)}</div>
      </div>
      {blockedNotice(task)}
      {open&&<div className="task-steps steps-list" aria-label={`Steps for ${task.title}`}><Checklist steps={task.steps} disabled={busy} onChange={steps=>save([{action:'update',entity:'task',id:task.id,fields:{steps}}],'Update task steps')}/></div>}
    </div>;
  };

  const taskGroup=(projectId:string,sectionId:string|null)=><div className="task-group" onDragOver={e=>e.preventDefault()} onDrop={e=>dropTask(e,projectId,sectionId)}>{visible.filter(t=>t.projectId===projectId&&t.sectionId===sectionId).map(taskRow)}<button className="add-task-inline add-step-inline" onClick={()=>openEditor({kind:'task',projectId,sectionId})}><Icon name="plus" size={14}/>Add task</button></div>;

  const orbState:OrbState=dictation.phase==='listening'?'listening':dictation.phase==='finishing'?'working':speaking?'composing':thinking?({understanding:'solving',searching:'searching',preparing:'weaving',saving:'working',responding:'composing'} as Record<string,OrbState>)[progressStage]??'working':'breathing';
  const savedDictations=dictation.drafts.filter(d=>d.id!==dictation.draft?.id&&(d.bytes||d.reviewText.trim()||d.liveText||d.finalText));
  const showRecovery=()=>{const node=document.querySelector<HTMLDetailsElement>('.recovered-dictations');if(node){node.open=true;node.scrollIntoView({block:'nearest'});}};
  const elapsed=`${Math.floor(dictation.seconds/60)}:${String(dictation.seconds%60).padStart(2,'0')}`;
  const openTasks=snapshot.tasks.filter(t=>!t.completed).length;
  const hiddenCount=snapshot.categories.filter(c=>hiddenCats.has(c.id)).length;

  const undoButton=<button className="btn btn-outline toolbar-undo" aria-label="Undo last change" disabled={!snapshot.canUndo||busy} onClick={()=>void undo()}><Icon name="undo" size={15}/>Undo</button>;

  const recordingNotice=dictating?<div className="global-recording" role="status"><span className="rec-dot"/><span>{dictation.phase==='listening'?'Recording · '+elapsed:'Finishing transcription…'}</span>{dictation.phase==='listening'&&<button className="btn btn-outline" onClick={()=>void dictationSession.stop()}>Stop recording</button>}</div>:null;

  const planRow=(item:EventItem|Task)=>{
    const event='startDate'in item?item as CalendarEntry:undefined,task=event?.linkedTaskId?snapshot.tasks.find(task=>task.id===event.linkedTaskId):!event?item as Task:undefined;
    return <div className={'plan-row '+(item.completed?'is-completed':'')} key={event?entryKey(event):item.id}>
      {(!event||event.canComplete)&&<button className={'task-check '+(item.completed?'checked':'')} aria-label={(item.completed?'Reopen ':'Complete ')+item.title} disabled={busy} onClick={()=>void save(event?calendarCompletionChanges(snapshot,event,!event.completed):[{action:'update',entity:'task',id:item.id,fields:{completed:!item.completed}}],'Toggle completion',undefined,!!event&&draftOwns(draft,{entity:event.entryType==='deadline'?'task':'event',id:event.entryType==='deadline'?event.linkedTaskId!:event.id}))}>{item.completed&&<Icon name="check" size={13}/>}</button>}
      <button className="plan-identity" onClick={()=>openItem(item)}><strong>{item.title}</strong><small>{event?(event.startTime?event.startTime+(event.endTime?'–'+event.endTime:''):'All day'):'Date '+(task!.dueDate?shortDate(task!.dueDate):'not set')}{task&&event?' · Linked':event?' · Calendar':' · Not on calendar'}</small></button>
      <button className="icon-button" aria-label={'Open '+item.title} onClick={()=>openItem(item)}><Icon name="right" size={16}/></button>
    </div>;
  };

  const dayEvents=day?calendarEntries(snapshot).filter(event=>event.startDate<=day&&event.endDate>=day&&!draft?.unresolved.some(i=>i.field==='interval'&&i.targetId===event.id)):[];
  const dayDialog=day&&<Dialog label="Day agenda" onClose={()=>setDay(null)}>
    <div className="dialog-head dialog-heading"><div className="dialog-title"><PixelFlower size={28}/><h2>{weekday(day)+', '+shortDate(day)}</h2></div><button className="icon-button" aria-label="Close agenda" onClick={()=>setDay(null)}><Icon name="close"/></button></div>
    <div className="dialog-body day-detail">
      {dayEvents.some(event=>!event.startTime)?<h3 className="tasks-section-label">ALL DAY<span className="label-line"/></h3>:null}
      {dayEvents.filter(event=>!event.startTime).map(planRow)}
      {dayEvents.some(event=>event.startTime)&&<h3 className="tasks-section-label">TIMED<span className="label-line"/></h3>}
      {dayEvents.filter(event=>event.startTime).sort((a,b)=>(a.startTime??'').localeCompare(b.startTime??'')).map(planRow)}
      {!dayEvents.length&&<p className="empty-state">Nothing planned for this day.</p>}
    </div>
    <div className="dialog-footer"><button className="btn btn-primary" onClick={()=>openEditor({kind:'event',date:day})}>New event</button><button className="btn btn-outline" onClick={()=>openEditor({kind:'task',date:day})}>New task on this day</button></div>
  </Dialog>;

  const settingsDialog=panel==='settings'&&<Dialog label="Assistant settings" onClose={closePanel}>
    <div className="dialog-head dialog-heading"><div className="dialog-title"><PixelFlower size={28}/><h2>Settings</h2></div><button className="icon-button" aria-label="Close settings" onClick={closePanel}><Icon name="close"/></button></div>
    <div className="dialog-body assistant-settings">
      <label>Appearance<select aria-label="Appearance" value={snapshot.preferences.appearance??'light'} onChange={e=>preference({appearance:e.target.value})}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select></label>
      <label>Ollama model<select aria-label="Ollama model" value={selectedModel} disabled={settingsBusy||thinking} onChange={e=>setSelectedModel(e.target.value)}>{!models.includes(selectedModel)&&<option value={selectedModel} disabled>{selectedModel?`${selectedModel} · unavailable`:'No eligible model selected'}</option>}{models.map(model=><option key={model}>{model}</option>)}</select></label>
      <p className="form-hint">Only installed local Ollama library models with completion and tools appear here.</p>
      {selectedModel&&!models.includes(selectedModel)&&<p className="form-error" role="status">This saved model is unavailable or ineligible. Select an installed local library model with completion and tools, then Apply and reload. Your current selection has not been changed.</p>}
      <ContextSlider value={contextTokens} disabled={settingsBusy||thinking} onChange={setContextTokens}/>
      <p className="form-hint">Active model: {status?.model??'Unknown'}<br/>Verified active context: {activeContext===null?'Not loaded or not verified':activeContext.toLocaleString()+' tokens'}</p>
      <p className="form-hint">MYMIND runs its own Ollama server. Apply and reload saves your model and context for future launches. Refresh checks the active context. Larger windows use more memory.</p>
      <label className="inline-check"><input type="checkbox" checked={spoken} onChange={e=>{setSpoken(e.target.checked);preference({spokenReplies:e.target.checked});if(!e.target.checked)stopAudio();}}/>Spoken replies</label>
      <p className="form-hint">Read AI replies aloud using a local voice. Off by default.</p>
      <p className="form-hint">Recording → transcript review → Send. Review and edit the transcript before sending it to your assistant. AI changes stay in preview until you Apply.</p>
      {settingsError&&<p className="form-error" role="alert">{settingsError}</p>}
      {settingsBusy&&<p role="status" className="form-hint">Checking or loading Ollama…</p>}
    </div>
    <div className="dialog-footer"><button className="btn btn-primary" disabled={settingsBusy||thinking||!models.includes(selectedModel)||!Number.isInteger(contextTokens)||contextTokens<4096||contextTokens>1048576} onClick={()=>void applySettings()}>Apply and reload</button><button className="btn btn-outline" disabled={settingsBusy} onClick={()=>void loadSettings()}>Refresh</button></div>
  </Dialog>;

  const organizeDialog=panel==='organize'&&organize&&<Dialog label="Review assignments" onClose={closePanel}>
    <div className="dialog-head dialog-heading"><div className="dialog-title"><PixelFlower size={28}/><h2>Review assignments</h2></div><button className="icon-button" aria-label="Close review" onClick={closePanel}><Icon name="close"/></button></div>
    <div className="dialog-body review-list"><p className="form-hint">Review category changes before applying the batch.</p>{organize.changes.some(change=>change.entity==='task'||change.entity==='event')?organize.changes.filter(change=>{
      if(change.entity!=='task'&&change.entity!=='event')return false;
      const event=change.entity==='event'?snapshot.events.find(event=>event.id===change.id):undefined;
      return !event?.linkedTaskId||!organize.changes.some(other=>other.entity==='task'&&other.id===event.linkedTaskId);
    }).map(change=>{
      const item=change.entity==='task'?snapshot.tasks.find(task=>task.id===change.id):snapshot.events.find(event=>event.id===change.id);
      const before=snapshot.categories.find(category=>category.id===item?.categoryId)?.title??'Uncategorized';
      const after=snapshot.categories.find(category=>category.id===change.fields?.categoryId)?.title??organize.changes.find(category=>category.entity==='category'&&category.id===change.fields?.categoryId)?.fields?.title??'Uncategorized';
      return <div className="assignment-review-row" key={change.entity+change.id}><strong>{item?.title}</strong><span>{before} → {String(after)}</span></div>;
    }):<p className="empty-state">Every item already has a category.</p>}</div>
    <div className="dialog-footer"><button className="btn btn-primary" disabled={busy||!organize.changes.length} onClick={async()=>{if(await save(organize.changes,'Organize existing items',organize.revision))closePanel();}}>Apply categories</button><button className="btn btn-outline" onClick={closePanel}>Cancel</button></div>
  </Dialog>;

  const categoryDialog=categoryEditor&&<CategoryDialog category={categoryEditor} busy={busy} onClose={()=>setCategoryEditor(null)} save={save}/>;

  const categoryPopover=popover&&<div className="category-popover" role="dialog" aria-label="Calendars">
    <div className="pop-title"><span>CALENDARS</span><button onClick={()=>setHiddenCats(new Set())}>Show all</button></div>
    {snapshot.categories.map(category=><div className="cat-pop-row" key={category.id}>
      <label className="cat-pick"><input type="checkbox" checked={!hiddenCats.has(category.id)} onChange={e=>setHiddenCats(current=>{const next=new Set(current);if(e.target.checked)next.delete(category.id);else next.add(category.id);return next;})}/><span className={'category-dot color-'+category.color}/><span className="cat-name">{category.title}</span></label>
      <button className="cat-mini-btn" aria-label={'Edit category '+category.title} onClick={()=>{setPopover(false);setCategoryEditor(category);}}><Icon name="edit" size={14}/></button>
    </div>)}
    <div className="cat-add-row"><button className="btn btn-outline" onClick={()=>{setPopover(false);setCategoryEditor({title:'',color:'sky'});}}><Icon name="plus" size={14}/>New category</button><button className="btn btn-ghost" onClick={()=>void openOrganize()}>Preview assignment changes</button></div>
  </div>;

  const chatSheet=sheet&&<section className="chat-panel chat-sheet" aria-label="Assistant conversation">
    <div className="chat-header">
      <CommandOrb state={orbState} size={30}/>
      <h2>MYMIND</h2>
      <span className={'runtime-line '+(status?.state==='ready'?'ready':'')}><i/>{status?.state==='ready'?'Local AI ready':status?.message??'Starting…'}</span>
      <span className="grow"/>
      <button className="btn btn-outline" onClick={()=>void newChat()}>New chat</button>
      <button className="btn btn-outline" aria-expanded={voiceOptions} aria-controls="voice-options" onClick={()=>setVoiceOptions(!voiceOptions)}>Voice options</button>
      <button className="icon-button" aria-label="Hide conversation" onClick={()=>setSheet(false)}><Icon name="down" size={18}/></button>
    </div>
    <div className="chat-messages" ref={chatBody} onScroll={e=>{pinned.current=e.currentTarget.scrollHeight-e.currentTarget.scrollTop-e.currentTarget.clientHeight<80;if(pinned.current)setNewMessage(false);}}>
      {messages.length===0&&!dictation.draft&&!dictating?<div className="chat-welcome example-panel">
        <div className="example-panel-title">TRY A COMMAND</div>
        <button disabled={dictating} onClick={()=>setText('What do I need to do today?')}>What do I need to do today?</button>
        <button disabled={dictating} onClick={()=>setText('Help me prepare for an interview.')}>Help me prepare for an interview.</button>
        <button disabled={dictating} onClick={()=>setText('Block tomorrow 2pm to 4pm for focused study.')}>Block tomorrow 2pm to 4pm for focused study.</button>
        {savedDictations.length>0&&<button onClick={showRecovery}>Saved dictations ({savedDictations.length})</button>}
      </div>:messages.map(message=><article key={message.id} className={'chat-message '+message.role}>
        <span className="chat-speaker">{message.role==='user'?'You':'MYMIND'}</span>
        {message.content&&<MessageContent content={message.content}/>}
        {message.receipt&&<div className="action-card">
          <span className="saved-label"><Icon name="check" size={15}/>Saved to your planner</span>
          {message.receipt.descriptions.filter(d=>!d.includes('category:')).map((description,index)=><p key={index}>{description}</p>)}
          <div className="button-row">
            <button className="btn btn-outline" onClick={()=>openReceipt(message.receipt!)} disabled={!message.receipt.items?.some(item=>snapshot.events.some(event=>event.id===item.id)||snapshot.tasks.some(task=>task.id===item.id))}>Open</button>
            <button className="btn btn-outline" disabled={busy||!snapshot.canUndo||snapshot.revision!==message.receipt.revision||message.receipt.label.startsWith('Undid ')} onClick={()=>void undo(message.receipt!.revision)}>Undo these changes</button>
          </div>
        </div>}
        {thinking&&active.current?.messageId===message.id&&<div className="chat-progress" role="status"><CommandOrb state={orbState} size={22}/>{progress}</div>}
      </article>)}
      <DictationTranscript/>
      <DictationActions onText={setText} disabled={thinking||speaking}/>
      <RecoveredDictations text={text}/>
      {status?.state!=='ready'&&<div className={'runtime-notice '+(status?.state==='error'?'runtime-error':'')} role="status">
        <span>{status?.message??'Starting the local assistant…'}</span>
        {status?.state==='error'&&<button className="btn btn-outline" onClick={()=>void window.planner.retryRuntime()}>Retry assistant</button>}
        <small>Your manual planner is available.</small>
      </div>}
    </div>
    {newMessage&&<button className="new-message" onClick={()=>{pinned.current=true;chatBody.current?.scrollTo({top:chatBody.current.scrollHeight,behavior:'smooth'});setNewMessage(false);}}>New response <Icon name="down" size={14}/></button>}
    {(voiceOptions||voiceMode||speaking)&&<div className="voice-options" id="voice-options">
      <button className={'btn btn-outline '+(voiceMode?'active':'')} disabled={status?.state!=='ready'} onClick={()=>{stopAudio();setVoiceMode(!voiceMode);if(voiceMode)void dictationSession.cancel();}}>{voiceMode?'End voice session':'Start voice session'}</button>
      <label className="inline-check"><input type="checkbox" checked={spoken} onChange={e=>{setSpoken(e.target.checked);preference({spokenReplies:e.target.checked});if(!e.target.checked)stopAudio();}}/>Spoken replies</label>
      {voiceMode&&<small>Stop, review, then Send each turn.</small>}
      {speaking&&<span role="status">{audio.current?'Speaking…':'Preparing voice…'}</span>}
    </div>}
    {trimmed&&<small className="context-note">Earlier exchanges are outside the active context. New chat starts fresh.</small>}
  </section>;

  const selectedItem=selection?(selection.entity==='event'?calendarEntries(snapshot).find(item=>item.id===selection.id&&item.entryType===(selection.entryType??'session')):snapshot.tasks.find(item=>item.id===selection.id)):undefined;
  const composer=<div className="composer-wrap">
    {chatSheet}
    {draft&&<DraftReview draft={draft} saved={saved!} selected={selection?selection.entity+':'+selection.id:null} disabled={busy||thinking||dictating} onNavigate={navigateDraft} onCancelNavigate={cancelNavigation} onOpen={openDraftItem} onApply={()=>void applyProposal()} onDismiss={()=>void dismissProposal()} onRefresh={()=>void refreshProposal()} onAnswer={issue=>{setSelection(null);setClarificationIssueId(issue.id);setSheet(false);document.getElementById('assistant-input')?.focus();}} onConflict={(issue,source)=>void resolveConflict(issue,source)}/>}
    {clarificationIssueId&&<div className="selection-chip"><span>Answering: {draft?.unresolved.find(i=>i.id===clarificationIssueId)?.question}</span><button className="icon-button" aria-label="Clear question context" onClick={()=>setClarificationIssueId(null)}><Icon name="close" size={14}/></button></div>}
    {selectedItem&&!selection?.draftId&&<div className="selection-chip"><span>Discussing: {selectedItem.title}</span><button className="icon-button" aria-label="Clear selected item" onClick={()=>setSelection(null)}><Icon name="close" size={14}/></button></div>}
    <form className={'chat-form composer '+(dictating?'composer-recording':'')} onSubmit={e=>{e.preventDefault();if(!dictating)void sendText(text);}}>
      <Dictation text={text} onText={setText} disabled={thinking||speaking} autoStart={voiceMode&&!thinking&&!speaking&&!text.trim()}/>
      <div className="composer-center">
        <div className="composer-meta">
          <span className="composer-label">LOCAL AI</span>
          {dictation.phase==='listening'&&<span className="recording-label" aria-label="Recording duration"><span className="rec-dot"/>Recording · {elapsed}</span>}
          {dictation.phase==='finishing'&&<span className="refining-label">Refining transcript…</span>}
          {!dictating&&dictation.draft&&<span className="ready-label">Transcript ready · review, then send</span>}
          {thinking&&<span className="refining-label">{progress||'Working…'}</span>}
          {dictation.phase==='listening'&&<span className="voice-bars" aria-hidden="true">{Array.from({length:9},(_,i)=><i key={i} style={{animationDelay:i*0.1+'s'}}/>)}</span>}
        </div>
        <textarea id="assistant-input" className="composer-input" aria-label="Message local assistant" rows={1} placeholder="Ask anything, or tell MYMIND what needs doing…" value={text} readOnly={dictating}  onChange={e=>{setText(e.target.value);dictationSession.edit(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!dictating)void sendText(text);}}}/>
      </div>
      <button type="button" className="example-toggle" aria-label={sheet?'Hide conversation':'Show conversation'} aria-pressed={sheet} onClick={()=>setSheet(!sheet)}><Icon name="chat" size={16}/><span>Chat</span></button>
      {thinking||speaking?<button type="button" className="send-btn stop-button" aria-label="Stop response" onClick={()=>{stopAudio();setVoiceMode(false);if(active.current&&!active.current.submitted){active.current=null;setThinking(false);setProgress('');}else void window.planner.cancelChat();if(speaking)void window.planner.cancelSpeech();}}><span className="mic-stop"/></button>:<button className="send-btn" type="submit" aria-label="Send message" disabled={!text.trim()||dictating||status?.state!=='ready'}><Icon name="send" size={18}/></button>}
    </form>
  </div>;

  const calendarScreen=<>
    <header className="topbar">
      <div className="title-wrap"><span className="bar-flower"><PixelFlower size={30}/></span><h1 data-testid="calendar-year">{monthTitle(lead)}</h1><span className="mini-muted">a little room to bloom</span></div>
      <div className="toolbar-actions">
        <div className="nav-pair"><button className="sq-btn" aria-label="Previous week" onClick={()=>calendar.current?.scrollByDays(-7)}><Icon name="left" size={17}/></button><button className="sq-btn" aria-label="Next week" onClick={()=>calendar.current?.scrollByDays(7)}><Icon name="right" size={17}/></button></div>
        <button className="btn btn-outline today-button" onClick={()=>calendar.current?.scrollToDate(today,true)}>Today</button>
        <span className="toolbar-separator"/>
        <div className="popover-anchor"><button className="btn btn-outline" aria-expanded={popover} aria-label="Calendars" onClick={()=>setPopover(!popover)}><Icon name="filter" size={15}/>Calendars{hiddenCount>0&&<span className="filter-counter">{snapshot.categories.length-hiddenCount}/{snapshot.categories.length}</span>}</button>{categoryPopover}</div>
        {undoButton}
        <button className="btn btn-primary" aria-label="New event" onClick={()=>openEditor({kind:'event',date:today})}><Icon name="plus" size={15}/>New event</button>
      </div>
    </header>
    <div className="subbar"><div className="segmented" aria-label="Calendar session filter">{(['all','planned','actual'] as const).map(kind=><button key={kind} aria-pressed={calendarKind===kind} className={calendarKind===kind?'chosen active':''} onClick={()=>setCalendarKind(kind)}>{kind==='all'?'All':kind==='planned'?'Planned':'Actual'}</button>)}</div><div className="subbar-left"><span className="small-flower">✳</span>Time to make space for what matters.</div>{recordingNotice??<span className="today-label">{weekday(today)+', '+shortDate(today)}</span>}</div>
    <BloomCalendar ref={calendar} snapshot={snapshot} saved={saved!} draft={draft} kind={calendarKind} selected={selection?.entity==='event'?entryKey({id:selection.id,entryType:selection.entryType}):undefined} today={today} now={clock} timezone={snapshot.preferences.timezone} hidden={hiddenCats} busy={busy||!!draft?.busy} onDay={setDay} onLead={setLead} onNew={(date,startTime,endTime,endDate)=>openEditor({kind:'event',date,startTime,endTime,endDate})} onOpen={openItem} onToggle={item=>void save(calendarCompletionChanges(snapshot,item,!item.completed),'Toggle linked work',undefined,draftOwns(draft,{entity:item.entryType==='deadline'?'task':'event',id:item.entryType==='deadline'?item.linkedTaskId!:item.id}))} onMove={(item,fields)=>void save(calendarEntryChanges(snapshot,item,fields),'Move calendar entry',undefined,draftOwns(draft,{entity:item.entryType==='deadline'?'task':'event',id:item.entryType==='deadline'?item.linkedTaskId!:item.id}))} eventProps={textBox.eventProps} textBoxButton={textBox.button}/>

    <div className="calendar-footnote"><span><span className="soft-dot"/>Drag across a day to sketch a block<span className="hint-separator">·</span>Double-click to add<span className="hint-separator">·</span>Select a day for its agenda</span><span>Scroll sideways for more days</span></div>
  </>;

  const tasksScreen=<>
    <header className="topbar task-topbar">
      <div className="title-wrap"><span className="bar-flower"><PixelFlower size={30}/></span><h1>My tasks</h1><span className="mini-muted">{openTasks} little {openTasks===1?'thing':'things'} on your list</span></div>
      <div className="toolbar-actions">{undoButton}<button className="btn btn-outline new-project" onClick={()=>openEditor({kind:'project'})}><Icon name="folder" size={15}/>New project</button><button className="btn btn-primary" aria-label="New task" onClick={()=>openEditor({kind:'task'})}><Icon name="plus" size={15}/>New task</button></div>
    </header>
    <div className="tasks-subbar">
      <div className="subbar-left"><span className="small-flower">✳</span>One thoughtful step at a time.</div>
      <div className="task-filters">
        {recordingNotice}
        <div className="segmented task-tabs" aria-label="Task filters">{(['all','today','overdue','ready','blocked','archived'] as const).map(tab=><button className={taskView===tab?'chosen active':''} key={tab} aria-pressed={taskView===tab} onClick={()=>setTaskView(tab)}>{tab==='all'?'All':viewLabels[tab]}</button>)}</div>
        <div className="segmented task-layout-switch" aria-label="Task layout">{(['checklist','flow'] as const).map(layout=><button className={taskLayout===layout?'chosen active':''} key={layout} aria-pressed={taskLayout===layout} onClick={()=>{setTaskLayout(layout);preference({taskLayout:layout});}}>{layout==='checklist'?'Checklist':'Flowchart'}</button>)}</div>
        <select className="filter-select" aria-label="Filter by category" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All categories</option><option value="none">Uncategorized</option>{snapshot.categories.map(category=><option key={category.id} value={category.id}>{category.title}</option>)}</select>
      </div>
    </div>
    <div className={'tasks-content task-scroll '+(taskLayout==='flow'&&taskView!=='archived'?'flow-mode':'checklist-view')}>
      <div className="tasks-column">
        {draft?.items.filter(i=>i.entity==='task'&&i.action==='delete').map(item=><div data-task-id={item.id} key={'removed:'+item.id} className="task-row preview-original removed-task">Remove task · {item.title}</div>)}
        <div className="flow-presentation" style={{display:taskLayout==='flow'&&taskView!=='archived'?'flex':'none'}}><TaskFlow ref={taskFlow} tasks={taskView==='all'?visible:focused} snapshot={snapshot} today={today} busy={busy} onOpen={openItem} save={save} textBoxButton={textBox.button}/></div>
        {taskLayout==='flow'&&taskView!=='archived'?null:taskView==='all'?<>
          <div className="tasks-section-label">PROJECTS<span className="label-line"/></div>
          {snapshot.projects.map(project=>{
            const own=visible.filter(t=>t.projectId===project.id),done=own.filter(t=>t.completed).length;
            return <section className="project-panel project-block" key={project.id}>
              <div className="project-head project-heading">
                <button className="project-collapse project-toggle" aria-label={(collapsed.has(project.id)?'Expand ':'Collapse ')+project.title} aria-expanded={!collapsed.has(project.id)} onClick={()=>setCollapsed(current=>{const next=new Set(current);next.has(project.id)?next.delete(project.id):next.add(project.id);return next;})}><Icon name={collapsed.has(project.id)?'right':'down'} size={16}/></button>
                <span className="project-folder"><Icon name="folder" size={18}/></span>
                <h2 className="project-name">{project.title}</h2>
                {own.length>0&&<><span className="project-progress">{done}/{own.length} done</span><div className="mini-progress"><span style={{width:Math.round(done/own.length*100)+'%'}}/></div></>}
                <div className="button-row project-actions">{project.id!=='inbox'&&<button className="tiny-action" aria-label={'Edit project '+project.title} title="Edit project" onClick={()=>openEditor({kind:'project',item:project})}><Icon name="edit" size={15}/></button>}<button className="tiny-action" aria-label={'Add section to '+project.title} title="Add section" onClick={()=>openEditor({kind:'section',projectId:project.id})}><Icon name="plus" size={15}/></button></div>
              </div>
              {!collapsed.has(project.id)&&<div className="project-tasks">{(visible.some(task=>task.projectId===project.id&&task.sectionId===null)||!snapshot.sections.some(section=>section.projectId===project.id))&&taskGroup(project.id,null)}{snapshot.sections.filter(section=>section.projectId===project.id).map(section=><div className="section-block" key={section.id}><div className="section-heading"><h3>{section.title}</h3><button className="icon-button tiny-action" aria-label={'Edit section '+section.title} onClick={()=>openEditor({kind:'section',item:section,projectId:project.id})}><Icon name="edit" size={14}/></button></div>{taskGroup(project.id,section.id)}</div>)}</div>}
            </section>;
          })}
        </>:<section className="project-panel project-block"><div className="project-head"><h2 className="project-name">{viewLabels[taskView]}</h2></div><div className="project-tasks">{focused.map(taskRow)}{!focused.length&&<div className="project-empty empty-state"><p>{taskView==='today'?'No tasks dated today.':taskView==='blocked'?'No blocked tasks.':taskView==='ready'?'No tasks ready to start.':taskView==='archived'?'No archived tasks.':'You’re caught up.'}</p></div>}<button className="add-task-inline add-step-inline" onClick={()=>openEditor({kind:'task',dueDate:taskView==='today'?today:undefined})}><Icon name="plus" size={14}/>{taskView==='today'?'Add a task for today':'Add task'}</button></div></section>}
        <div className="task-footer task-footer-message"><PixelCat size={44} happy/><div><strong>Gentle reminder</strong><span>Completed tasks stay here for 24 hours, then move to Archived.</span></div></div>
      </div>
    </div>
  </>;

  return <div className="app-shell command-shell">
    <aside className="sidebar">
      <div className="brand-logo" aria-label="MYMIND"><PixelFlower size={40}/><span className="brand-small">m</span></div>
      <nav className="side-nav" aria-label="Main navigation">
        {([{value:'calendar',label:'Calendar',icon:'calendar'},{value:'tasks',label:'Tasks',icon:'tasks'}] as const).map(item=><button key={item.value} className={'side-button nav-item '+(view===item.value?'active':'')} aria-label={item.label+' view'} aria-current={view===item.value?'page':undefined} title={item.label} onClick={()=>{setView(item.value);setDay(null);setPopover(false);}}><Icon name={item.icon} size={24}/></button>)}
      </nav>
      <div className="side-bottom">
        <button className="side-button" aria-label="Assistant settings" title="Settings" onClick={()=>openPanel('settings')}><Icon name="settings" size={22}/></button>
        <PixelFlower size={25} className="sidebar-tulip"/>
        <PixelCat size={43}/>
        <span className="side-caption">mymind</span>
      </div>
    </aside>
    <main className="main-shell">
      <div className="screen-content"><div className="workspace-screen" style={{display:view==='calendar'?'flex':'none'}}>{calendarScreen}</div><div className="workspace-screen" style={{display:view==='tasks'?'flex':'none'}}>{tasksScreen}</div></div>
      {composer}
    </main>
    {editor&&<EditorDialog key={editor.kind+'-'+(editor.item?.id??'new')} editor={editor} snapshot={snapshot} pending={editorDraft} needsInterval={editor.kind==='event'&&draft?.unresolved.some(i=>i.targetId===editor.item?.id&&i.field==='interval')} save={(changes,label,revision)=>save(changes,label,revision,editorDraft)} busy={busy||!!draft?.busy} onClose={()=>setEditor(null)} onOpen={openItem} onSchedule={task=>{openEditor({kind:'event',date:today,linkedTaskId:task.id});setEditorDraft(draftOwns(draft,{entity:'task',id:task.id}));}}/>}
    {dayDialog}{settingsDialog}{organizeDialog}{categoryDialog}
    {textBox.popup}
    {toast&&<div className={'toast '+(toast.error?'error':'')} role={toast.error?'alert':'status'}><PixelFlower size={20}/><span>{toast.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={()=>setToast(null)}><Icon name="close" size={14}/></button></div>}
  </div>;
}

function CategoryDialog({category,busy,onClose,save}:{category:{id?:string;title:string;color:Color};busy:boolean;onClose:()=>void;save:(changes:Change[],label:string)=>Promise<boolean>}){

  const [title,setTitle]=useState(category.title),[color,setColor]=useState(category.color);

  return <Dialog label="Edit category" onClose={onClose}><form className="editor-form" onSubmit={async e=>{e.preventDefault();if(await save([{action:category.id?'update':'create',entity:'category',id:category.id,fields:{title,color}}],'Save category'))onClose();}}><div className="dialog-heading dialog-head"><div className="dialog-title"><PixelFlower size={28}/><h2>{category.id?'Edit':'New'} category</h2></div><button className="icon-button" type="button" aria-label="Close category editor" onClick={onClose}><Icon name="close"/></button></div><div className="editor-body dialog-body"><label>Name<input autoFocus required maxLength={80} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Color</label><ColorPicker value={color} onChange={setColor}/>{category.id&&<details className="editor-more"><summary>More category actions</summary><button className="danger-button" type="button" disabled={busy} onClick={async()=>{if(await save([{action:'delete',entity:'category',id:category.id}],'Delete category'))onClose();}}>Delete category</button></details>}</div><div className="dialog-footer"><button className="btn btn-primary" disabled={busy}>Save category</button><button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button></div></form></Dialog>;

}



function MessageContent({content}:{content:string}){

  const inline=(line:string)=>line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i)=>part.startsWith('**')&&part.endsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part.startsWith('`')&&part.endsWith('`')?<code key={i}>{part.slice(1,-1)}</code>:part);

  return <div className="message-content">{content.split('\n').map((line,index)=>{if(!line.trim())return <div className="message-space" key={index}/>;const heading=/^#{1,4}\s+(.*)/.exec(line),list=/^\s*(?:[-*]|(\d+)[.)])\s+(.*)/.exec(line);if(heading)return <h3 key={index}>{inline(heading[1])}</h3>;if(list)return <div className="message-list-row" key={index}><span>{list[1]?list[1]+'.':'•'}</span><span>{inline(list[2])}</span></div>;return <div key={index}>{inline(line)}</div>;})}</div>;

}
