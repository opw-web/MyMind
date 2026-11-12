import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Change, ChatMessage, Color, COLORS, EventItem, Project, RuntimeStatus, Section, Snapshot, Task } from '../shared/model';
import { daysBetween, monthDates, shiftDate, shortDate, todayIn, weekday } from '../shared/dates';
import Workspace from './Workspace';
import {formatTaskTimestamp} from '../shared/tasks';
import {Checklist,PrerequisitePicker} from './TaskDetails';
import {PixelFlower} from './Pixel';
import {calendarCompletionChanges} from '../shared/calendar';

export type Editor = { kind:'event'; item?:EventItem; date:string; startTime?:string; endTime?:string; endDate?:string; linkedTaskId?:string; linkedStepId?:string } | { kind:'task'; item?:Task; date?:string; dueDate?:string; projectId?:string; sectionId?:string|null } | { kind:'project'; item?:Project } | { kind:'section'; item?:Section; projectId:string };
export function Icon({name,size=18}:{name:string;size?:number}) {
  const paths:Record<string,React.ReactNode> = {
    plus:<path d="M12 5v14M5 12h14"/>, close:<path d="M5 5l14 14M19 5 5 19"/>, left:<path d="m14 5-7 7 7 7"/>, right:<path d="m10 5 7 7-7 7"/>, down:<path d="m6 9 6 6 6-6"/>, up:<path d="m6 15 6-6 6 6"/>,
    undo:<path d="M9 4 4 9l5 5M4 9h9a7 7 0 0 1 0 14"/>,
    calendar:<><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 14h3v3H8z"/></>,
    tasks:<><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m7.5 9 1.5 1.5 2.5-3M13 9h4M7.5 15l1.5 1.5 2.5-3M13 15h4"/></>,
    spark:<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z"/>,
    send:<path d="m3 11 18-8-8 18-2-8-8-2ZM11 13l10-10"/>, edit:<path d="M12 20h9M16 4l4 4-11 11-5 1 1-5L16 4Z"/>,
    trash:<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>, check:<path d="m4 12 5 5L20 6"/>,
    grip:<><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
    filter:<><path d="M4 7h16M7 12h10M10 17h4"/><circle cx="8" cy="7" r="2" fill="currentColor" stroke="none"/></>,
    mic:<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    link:<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>,
    flower:<><circle cx="12" cy="12" r="2"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/></>,
    folder:<path d="M3 7V5h7l2 2h9v12H3V7Z"/>, chevron:<path d="m9 5 7 7-7 7"/>,
    chat:<path d="M4 5h16v11H9l-5 4V5Z"/>, info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.spark}</svg>;
}
export function Dialog({children,onClose,label}:{children:React.ReactNode;onClose:()=>void;label:string}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} className="dialog" aria-label={label} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget){const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)onClose();}}}>{children}</dialog>;
}
export function ColorPicker({value,onChange}:{value:Color;onChange:(value:Color)=>void}) { return <div className="color-picker" aria-label="Note color">{COLORS.map(color=><button type="button" key={color} className={`swatch color-${color} ${value===color?'selected':''}`} title={color} aria-label={`${color} color`} aria-pressed={value===color} onClick={()=>onChange(color)}>{value===color&&<Icon name="check" size={14}/>}</button>)}</div>; }

export function EditorDialog({editor,snapshot,onClose,save,busy,onOpen,pending,onSchedule,needsInterval}:{editor:Editor;snapshot:Snapshot;onClose:()=>void;save:(changes:Change[],label:string,expectedRevision?:number)=>Promise<boolean>;busy:boolean;onOpen?:(item:EventItem|Task)=>void;pending?:boolean;needsInterval?:boolean;onSchedule?:(task:Task)=>void}) {
  const original=editor.item;
  const revision=useRef(snapshot.revision);
  const [steps,setSteps]=useState(editor.kind==='task'?editor.item?.steps??[]:[]);
  const [dependsOnIds,setDependsOnIds]=useState(editor.kind==='task'?editor.item?.dependsOnIds??[]:[]);
  const [completed,setCompleted]=useState(original&&'completed'in original?original.completed:false);
  const [title,setTitle]=useState(original?.title??'');
  const [notes,setNotes]=useState(original&&'notes'in original?original.notes:'');
  const [color,setColor]=useState<Color>(original&&'color'in original?original.color:editor.kind==='task'?'sage':'coral');
  const [categoryId,setCategoryId]=useState(original&&'categoryId'in original?original.categoryId??'':'auto');
  const [override,setOverride]=useState(original&&'colorOverride'in original?!!original.colorOverride:false);
  const [startDate,setStartDate]=useState(editor.kind==='event'?editor.item?.startDate??editor.date:'');
  const [endDate,setEndDate]=useState(editor.kind==='event'?editor.item?.endDate??editor.endDate??editor.date:'');
  const [timed,setTimed]=useState(editor.kind==='event'&&(!!needsInterval||!!(editor.item?.startTime??editor.startTime)));
  const [startTime,setStartTime]=useState(editor.kind==='event'?editor.item?.startTime??editor.startTime??'':'09:00');
  const [endTime,setEndTime]=useState(editor.kind==='event'?editor.item?.endTime??editor.endTime??'':'');
  const [dueDate,setDueDate]=useState(editor.kind==='task'?editor.item?.dueDate??editor.dueDate??editor.date??'':'');
  const [linkedTaskId,setLinkedTaskId]=useState(editor.kind==='event'?editor.item?.linkedTaskId??editor.linkedTaskId??'':'');
  const [linkedStepId,setLinkedStepId]=useState(editor.kind==='event'?editor.item?.linkedStepId??editor.linkedStepId??'':'');
  const [eventKind,setEventKind]=useState(editor.kind==='event'?editor.item?.kind??'planned':'planned');
  const [dateRange,setDateRange]=useState(editor.kind==='event'&&(editor.item?editor.item.endDate!==editor.item.startDate:!!editor.endDate&&editor.endDate!==editor.date));
  const [projectId,setProjectId]=useState(editor.kind==='task'?editor.item?.projectId??editor.projectId??'inbox':editor.kind==='section'?editor.projectId:'inbox');
  const [sectionId,setSectionId]=useState(editor.kind==='task'?editor.item?.sectionId??editor.sectionId??'':'');
  const [error,setError]=useState('');
  const entity=editor.kind;
  async function submit(e:React.FormEvent){
    e.preventDefault();setError('');if(!title.trim())return setError('Give this a title.');
    if(entity==='event'&&needsInterval&&(!timed||!startTime||!endTime))return setError('Time needed: enter an explicit start and end time.');
    if(entity==='event'&&endDate<startDate)return setError('End date must be on or after the start date.');
    if(entity==='event'&&timed&&startDate===endDate&&endTime&&endTime<=startTime)return setError('End time must be after the start time.');
    const fields:Record<string,unknown>=entity==='event'?{title,notes,color,kind:eventKind,linkedTaskId:linkedTaskId||null,linkedStepId:linkedStepId||null,startDate,endDate:dateRange?endDate:startDate,startTime:timed?startTime:null,endTime:timed&&endTime?endTime:null}:entity==='task'?{title,notes,color,completed,dueDate:dueDate||null,projectId,sectionId:sectionId||null}:entity==='section'?{title,projectId}:{title};
    if(entity==='event'||entity==='task'){if(!override)delete fields.color;fields.colorOverride=override?color:null;if(categoryId!=='auto')fields.categoryId=categoryId||null;}
    if(entity==='task'){fields.steps=steps;fields.dependsOnIds=dependsOnIds;}
    const changes:Change[]=[{action:original?'update':'create',entity,id:original?.id,fields}];
    if(entity==='event'&&editor.kind==='event'&&editor.item&&completed!==editor.item.completed)changes.push(...calendarCompletionChanges({...snapshot,events:snapshot.events.map(event=>event.id===editor.item!.id?{...event,linkedTaskId:linkedTaskId||null,linkedStepId:linkedStepId||null}:event)},{id:editor.item.id,entryType:'session'},completed));
    if(await save(changes,`${original?'Edit':'Add'} ${entity}`,revision.current))onClose();
  }
  const linkedTask=editor.kind==='event'?snapshot.tasks.find(task=>task.id===editor.item?.linkedTaskId):undefined;
  const form=<form className="editor-form" onSubmit={submit} aria-label={`${original?'Edit':'New'} ${entity}`}>
    <div className="dialog-heading dialog-head"><div className="dialog-title"><PixelFlower size={28}/><h2>{pending?'Proposal · ':''}{original?'Edit':'New'} {entity}</h2></div><button type="button" className="icon-button" aria-label="Close editor" onClick={onClose}><Icon name="close"/></button></div>
    <div className="editor-body dialog-body">
    <label>Title<input autoFocus required maxLength={240} placeholder={entity==='event'?'What’s happening?':entity==='task'?'What needs doing?':`Name this ${entity}`} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    {(entity==='event'||entity==='task')&&<>
      {(entity==='task'||entity==='event'&&!!editor.item&&!!linkedTaskId)&&<label className="inline-check"><input type="checkbox" checked={completed} disabled={busy} onChange={e=>setCompleted(e.target.checked)}/>{entity==='task'?'Mark complete':'Mark linked work complete'}</label>}
      {editor.kind==='task'&&editor.item&&<div className="task-timestamps"><span>Created: {formatTaskTimestamp(editor.item.createdAt,snapshot.preferences.timezone)}</span>{editor.item.completed&&<span>Completed: {formatTaskTimestamp(editor.item.completedAt,snapshot.preferences.timezone)}</span>}</div>}
      {entity==='event'?<>
        {needsInterval&&<p className="time-needed" role="status">Time needed · give this actual activity its start and end time before Apply.</p>}
        <div className="form-grid"><label>Session type<select aria-label="Session type" value={eventKind} onChange={e=>setEventKind(e.target.value as 'planned'|'actual')}><option value="planned">Planned</option><option value="actual">Actual</option></select></label><label>Linked task<select aria-label="Linked task" value={linkedTaskId} onChange={e=>{setLinkedTaskId(e.target.value);setLinkedStepId('');}}><option value="">No linked task</option>{snapshot.projects.map(project=><optgroup label={project.title} key={project.id}>{snapshot.tasks.filter(task=>task.projectId===project.id).map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</optgroup>)}</select></label></div>
        {linkedTaskId&&<label>Linked step<select aria-label="Linked step" value={linkedStepId} onChange={e=>setLinkedStepId(e.target.value)}><option value="">Whole task</option>{snapshot.tasks.find(t=>t.id===linkedTaskId)?.steps.map(step=><option key={step.id} value={step.id}>{step.title}</option>)}</select></label>}
        <label>Date<input aria-label="Date" type="date" required value={startDate} onChange={e=>{const value=e.target.value;setStartDate(value);if(linkedTask&&dateRange&&value&&startDate)setEndDate(shiftDate(endDate,daysBetween(startDate,value)));else if(!dateRange||endDate===startDate||endDate<value)setEndDate(value);}}/></label>
        {<label className="inline-check"><input type="checkbox" checked={dateRange} onChange={e=>{setDateRange(e.target.checked);if(!e.target.checked)setEndDate(startDate);}}/>Date range</label>}
        {dateRange&&<label>Through <span className="optional">Includes both the first and last day{linkedTask?' · existing calendar range':''}</span><input aria-label="End of Date range" type="date" required min={startDate} value={endDate} onChange={e=>setEndDate(e.target.value)}/></label>}
        <label className="inline-check"><input type="checkbox" checked={timed} onChange={e=>setTimed(e.target.checked)}/>Time <span className="optional">optional</span></label>
        {timed&&<div className="form-grid"><label>Start time<input type="time" required value={startTime} onChange={e=>setStartTime(e.target.value)}/></label><label>End time <span className="optional">optional</span><input type="time" value={endTime} onChange={e=>setEndTime(e.target.value)}/></label></div>}
      </>:<>
        <div className="form-grid"><label>Project<select aria-label="Project" value={projectId} onChange={e=>{setProjectId(e.target.value);setSectionId('');}}>{snapshot.projects.map(project=><option key={project.id} value={project.id}>{project.title}</option>)}</select></label><label>Section<select aria-label="Section" value={sectionId} onChange={e=>setSectionId(e.target.value)}><option value="">No section</option>{snapshot.sections.filter(section=>section.projectId===projectId).map(section=><option key={section.id} value={section.id}>{section.title}</option>)}</select></label></div>
        <label>Deadline <span className="optional">optional · independent of work sessions</span><input id="task-date" aria-label="Deadline" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
        {editor.kind==='task'&&editor.item&&<div className="session-list"><strong>Work sessions</strong>{snapshot.events.filter(event=>event.linkedTaskId===editor.item!.id).map(event=><button type="button" className="subtle-button" key={event.id} onClick={()=>onOpen?.(event)}>{event.kind==='actual'?'Actual':'Planned'} · {event.title} · {event.startDate} {event.startTime}</button>)}<button type="button" className="subtle-button" onClick={()=>onSchedule?.(editor.item!)}>Schedule work</button></div>}
        <fieldset className="task-structure"><legend>Steps <span className="optional">{steps.filter(s=>s.completed).length}/{steps.length} done</span></legend><Checklist steps={steps} onChange={setSteps} editable disabled={busy}/></fieldset>
        <PrerequisitePicker tasks={snapshot.tasks} taskId={original?.id} ids={dependsOnIds} onChange={setDependsOnIds} disabled={busy}/>
      </>}
      <label>Category<select aria-label="Category" value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="auto">Choose automatically</option><option value="">Uncategorized</option>{snapshot.categories.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label className="inline-check"><input type="checkbox" checked={override} onChange={e=>setOverride(e.target.checked)}/>Use a custom color</label>{override&&<ColorPicker value={color} onChange={setColor}/>}
      <label>Notes <span className="optional">optional</span><textarea rows={4} maxLength={10000} placeholder="Add a little more detail…" value={notes} onChange={e=>setNotes(e.target.value)}/></label>
      {linkedTask&&onOpen&&<><p className="form-hint">Linked to {linkedTask.title}. This session has its own dates and notes.</p><button type="button" className="subtle-button linked-record" onClick={()=>onOpen(linkedTask)}>Open task</button></>}
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {original&&original.id!=='inbox'&&<details className="editor-more"><summary>More {entity} actions</summary>{linkedTask&&<p className="form-hint">Removing this calendar entry keeps the task and its Date.</p>}<button type="button" className="danger-button" disabled={busy} onClick={async()=>{if(await save([{action:'delete',entity,id:original.id}],`Delete ${entity}`))onClose();}}><Icon name="trash" size={15}/>{linkedTask?'Remove calendar entry':`Delete ${entity}`}</button></details>}
    {(entity==='project'||entity==='section')&&original&&<p className="form-hint">Deleting this heading moves its tasks into Inbox. You can undo it.</p>}
    </div>
    <div className="dialog-footer"><button type="submit" className="primary-button" disabled={busy}>{busy?'Saving…':original?'Save changes':`Add ${entity}`}</button><button type="button" className="subtle-button" onClick={onClose}>Cancel</button></div>
  </form>;
  return <Dialog label={`${original?'Edit':'New'} ${entity}`} onClose={onClose}>{form}</Dialog>;
}

export default Workspace;
