import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Change,EventItem,Snapshot,Task} from '../shared/model';

type Item=Task|EventItem;
type Draft={entity:'task'|'event';id:string;title:string;base:string;text:string;revision:number;anchor:HTMLElement;editing:boolean;error:string;pending:boolean};
type Save=(changes:Change[],label:string,revision?:number)=>Promise<boolean>;

export function useTextBox(snapshot:Snapshot|null,save:Save){
  const [draft,setDraft]=useState<Draft|null>(null);
  const current=useRef(draft);current.current=draft;
  const latest=useRef(snapshot);latest.current=snapshot;
  const panel=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const restoringFocus=useRef(false);
  const [position,setPosition]=useState({left:8,top:8});
  const keep=()=>clearTimeout(timer.current);
  function update(patch:Partial<Draft>){const value=current.current;if(value){current.current={...value,...patch};setDraft(current.current);}}
  async function close(retry=false):Promise<boolean>{
    keep();const value=current.current;if(!value)return true;if(value.pending)return false;
    if(value.error&&!retry)return false;
    const text=value.text.trim()?value.text:'';
    if(text===value.base){current.current=null;setDraft(null);return true;}
    const state=latest.current,record=value.entity==='task'?state?.tasks.find(t=>t.id===value.id):state?.events.find(e=>e.id===value.id);
    if(!record||record.textBox!==value.base){update({error:'This text box changed elsewhere. Your draft is kept here. Close without saving to load the saved text.'});return false;}
    update({pending:true,error:''});
    // Retry may use a fresh revision only after verifying the saved text still matches our base.
    const ok=await save([{action:'update',entity:value.entity,id:value.id,fields:{textBox:text}}],'Edit text box',retry?state!.revision:value.revision);
    if(ok){current.current=null;setDraft(null);return true;}
    update({pending:false,error:'Could not save. Your text is kept here. Retry saving.'});return false;
  }
  function leave(){keep();timer.current=setTimeout(()=>{if(!panel.current?.contains(document.activeElement))void close();},220);}
  async function open(item:Item,anchor:HTMLElement,editing:boolean){
    keep();let state=latest.current;if(!state)return;
    let target=item;
    const entity='projectId' in target?'task':'event';
    if(current.current?.id===target.id&&current.current.entity===entity){
      if(editing)update({editing:true});
      else if(!panel.current?.contains(document.activeElement))update({anchor});
      return;
    }
    if(current.current&&!await close())return;
    state=latest.current;if(!state||!anchor.isConnected)return;
    const record=entity==='task'?state.tasks.find(t=>t.id===target.id):state.events.find(e=>e.id===target.id);
    if(!record)return;target=record;
    const value:Draft={entity,id:target.id,title:target.title,base:target.textBox,text:target.textBox,revision:state.revision,anchor,editing,error:'',pending:false};
    current.current=value;setDraft(value);
  }
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useLayoutEffect(()=>{
    if(!draft)return;
    const place=()=>{const box=panel.current?.getBoundingClientRect(),anchor=draft.anchor.getBoundingClientRect();const width=box?.width??300,height=box?.height??210;
      const right=anchor.right+8,left=anchor.left-width-8,beside=right+width<=innerWidth-8?right:left>=8?left:null;
      const below=anchor.bottom+4,above=anchor.top-height-4;
      // Keep the popup outside its anchor's hit area during pointer/focus transitions.
      setPosition({left:beside??Math.max(8,Math.min(anchor.left,innerWidth-width-8)),top:beside!==null?Math.max(8,Math.min(anchor.top,innerHeight-height-8)):below+height<=innerHeight-8?below:above>=8?above:Math.max(8,Math.min(below,innerHeight-height-8))});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    const observer=new ResizeObserver(place);if(panel.current)observer.observe(panel.current);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[draft?.id,draft?.anchor]);
  useEffect(()=>{if(draft?.editing)input.current?.focus();},[draft?.id,draft?.editing]);
  useEffect(()=>{
    if(!draft)return;
    const outside=(event:PointerEvent)=>{const target=event.target as Node;if(!panel.current?.contains(target)&&!draft.anchor.contains(target))void close();};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[draft?.id,draft?.anchor]);

  const button=(item:Item)=><button type="button" className={`icon-button text-box-button ${item.textBox?.trim()?'has-text':''}`} aria-label={`Text box for ${item.title}`} aria-haspopup="dialog" onClick={e=>{e.stopPropagation();void open(item,e.currentTarget,true);}} onDragStart={e=>e.preventDefault()}>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/>{item.textBox?.trim()&&<path d="M7 9h10M7 12h10M7 15h6"/>}</svg>
  </button>;
  const eventProps=(item:Item)=>({onMouseEnter:(e:React.MouseEvent<HTMLElement>)=>{void open(item,e.currentTarget,false);},onMouseLeave:leave,
    onClick:(e:React.MouseEvent<HTMLElement>)=>{if(!(e.target as HTMLElement).closest('.text-box-button'))void close();},
    onFocus:(e:React.FocusEvent<HTMLElement>)=>{if(!restoringFocus.current)void open(item,e.currentTarget,false);},onBlur:(e:React.FocusEvent<HTMLElement>)=>{if(!e.currentTarget.contains(e.relatedTarget as Node))leave();}});
  const popup=draft&&createPortal(<div ref={panel} className="text-box-popup" role="dialog" aria-label={`Text box for ${draft.title}`} style={position} onMouseEnter={keep} onMouseLeave={leave} onFocus={keep} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))void close();}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();void close().then(ok=>{if(ok){const target=draft.anchor.matches('button')?draft.anchor:draft.anchor.querySelector<HTMLElement>('button');restoringFocus.current=true;target?.focus();restoringFocus.current=false;}});}}} onPointerDown={e=>e.stopPropagation()}>
    <div className="text-box-heading"><strong>Text box</strong><button type="button" aria-label="Close text box" onClick={()=>void close()}>×</button></div>
    {<textarea ref={input} aria-label={`Text box text for ${draft.title}`} maxLength={10000} rows={5} value={draft.text} disabled={draft.pending} placeholder="Write something…" onFocus={()=>update({editing:true})} onChange={e=>update({text:e.target.value})}/>}
    {draft.pending&&<small role="status">Saving…</small>}
    {draft.error&&<div className="text-box-error"><p role="alert">{draft.error}</p><button type="button" onClick={()=>void close(true)}>Retry saving</button><button type="button" onClick={()=>{keep();current.current=null;setDraft(null);}}>Close without saving</button></div>}
  </div>,draft.anchor.closest('dialog')??document.body);
  return {button,eventProps,popup};
}
