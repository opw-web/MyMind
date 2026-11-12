import React,{useEffect,useState} from 'react';
import {Task,TaskStep} from '../shared/model';
import {Icon} from './App';

export function Checklist({steps:receivedSteps,onChange:receiveChange,editable=false,disabled=false}:{steps:TaskStep[];onChange:(steps:TaskStep[])=>void|Promise<boolean>;editable?:boolean;disabled?:boolean}){
  const [steps,setSteps]=useState(receivedSteps);
  useEffect(()=>setSteps(receivedSteps),[receivedSteps]);
  function onChange(next:TaskStep[]){setSteps(next);const result=receiveChange(next);if(result instanceof Promise)void result.then(saved=>{if(!saved)setSteps(receivedSteps);});}
  function move(index:number,delta:number){const next=[...steps];[next[index],next[index+delta]]=[next[index+delta],next[index]];onChange(next);}
  return <div className="task-checklist">{steps.map((step,index)=><div className="step-row" key={step.id}>
    <label className="step-check"><input type="checkbox" aria-label={`Complete step ${step.title}`} checked={step.completed} disabled={disabled} onChange={e=>onChange(steps.map(s=>s.id===step.id?{...s,completed:e.target.checked}:s))}/></label>
    {editable?<input aria-label={`Step ${index+1} title`} required maxLength={240} value={step.title} disabled={disabled} onChange={e=>onChange(steps.map(s=>s.id===step.id?{...s,title:e.target.value}:s))}/>:<span className={step.completed?'step-completed':''}>{step.title}</span>}
    {editable&&<div className="button-row"><button type="button" className="icon-button" aria-label={`Move step ${index+1} up`} disabled={disabled||index===0} onClick={()=>move(index,-1)}><Icon name="up" size={14}/></button><button type="button" className="icon-button" aria-label={`Move step ${index+1} down`} disabled={disabled||index===steps.length-1} onClick={()=>move(index,1)}><Icon name="down" size={14}/></button><button type="button" className="icon-button" aria-label={`Delete step ${index+1}`} disabled={disabled} onClick={()=>onChange(steps.filter(s=>s.id!==step.id))}><Icon name="close" size={14}/></button></div>}
  </div>)}{editable&&<button type="button" className="subtle-button" disabled={disabled||steps.length>=100} onClick={()=>onChange([...steps,{id:crypto.randomUUID(),title:'',completed:false}])}><Icon name="plus" size={14}/>Add step</button>}</div>;
}

export function PrerequisitePicker({tasks,taskId,ids,onChange,disabled}:{tasks:Task[];taskId?:string;ids:string[];onChange:(ids:string[])=>void;disabled:boolean}){
  const [query,setQuery]=useState('');
  const selected=tasks.filter(t=>ids.includes(t.id));
  return <div className="prerequisite-picker"><label>Prerequisites<input aria-label="Search prerequisite tasks" placeholder="Find a task that must happen first…" value={query} onChange={e=>setQuery(e.target.value)} disabled={disabled}/></label>
    {selected.map(task=><div className="prerequisite-choice" key={task.id}><span>{task.title}{!task.completed&&<small> · unfinished</small>}</span><button className="icon-button" type="button" aria-label={`Remove prerequisite ${task.title}`} disabled={disabled} onClick={()=>onChange(ids.filter(id=>id!==task.id))}><Icon name="close" size={14}/></button></div>)}
    {query.trim()&&<div className="prerequisite-results">{tasks.filter(t=>t.id!==taskId&&!ids.includes(t.id)&&t.title.toLowerCase().includes(query.toLowerCase())).map(t=><button className="subtle-button" type="button" key={t.id} disabled={disabled} onClick={()=>{onChange([...ids,t.id]);setQuery('');}}>{t.title}</button>)}</div>}
    {selected.some(t=>!t.completed)&&<p className="blocked-warning" role="status">Blocked by unfinished prerequisites. You can still mark this task complete.</p>}
  </div>;
}
