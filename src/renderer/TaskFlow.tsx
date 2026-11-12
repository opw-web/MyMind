import React,{forwardRef,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import {Change,Snapshot,Task} from '../shared/model';
import {layoutTaskFlow} from '../shared/task-flow';
import {blockers,isArchivedTask} from '../shared/tasks';
import {shortDate} from '../shared/dates';
import {Checklist} from './TaskDetails';
import {Icon} from './App';

export interface FlowPosition{left:number;top:number;zoom:number;}
export interface TaskFlowHandle{position():FlowPosition;restore(value:FlowPosition):void;}
type Props={tasks:Task[];snapshot:Snapshot;today:string;busy:boolean;textBoxButton:(task:Task)=>React.ReactNode;onOpen:(task:Task)=>void;save:(changes:Change[],label:string)=>Promise<boolean>};
const TaskFlow=forwardRef<TaskFlowHandle,Props>(function TaskFlow({tasks,snapshot,today,busy,onOpen,save,textBoxButton},ref){
  const [heights,setHeights]=useState(new Map<string,number>());
  const layout=layoutTaskFlow(tasks,snapshot.tasks.filter(t=>!isArchivedTask(t)),heights),byId=new Map(layout.nodes.map(n=>[n.task.id,n]));
  const viewport=useRef<HTMLDivElement>(null),pan=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const [zoom,setZoom]=useState(1),[layoutTick,setLayoutTick]=useState(0),restoring=useRef<FlowPosition|null>(null);
  useImperativeHandle(ref,()=>({position:()=>({left:viewport.current?.scrollLeft??0,top:viewport.current?.scrollTop??0,zoom}),restore:value=>{restoring.current=value;setZoom(value.zoom);setLayoutTick(t=>t+1);}}),[zoom]);
  useLayoutEffect(()=>{const el=viewport.current;if(!el)return;const observer=new ResizeObserver(()=>setLayoutTick(t=>t+1));observer.observe(el);return()=>observer.disconnect();},[tasks.length>0]);
  useLayoutEffect(()=>{const value=restoring.current,el=viewport.current;if(value&&el?.clientWidth&&value.zoom===zoom){el.scrollLeft=value.left;el.scrollTop=value.top;restoring.current=null;}},[zoom,layoutTick,layout.width,layout.height]);
  useLayoutEffect(()=>{const elements=viewport.current?.querySelectorAll<HTMLElement>('.flow-node');if(!elements?.length)return;const observer=new ResizeObserver(entries=>{setHeights(current=>{const next=new Map(current);let changed=false;for(const entry of entries){const node=entry.target as HTMLElement,id=node.dataset.taskId!,height=Math.ceil(node.offsetHeight);if(height>0&&next.get(id)!==height){next.set(id,height);changed=true;}}return changed?next:current;});});elements.forEach(element=>observer.observe(element));return()=>observer.disconnect();},[tasks,snapshot.tasks]);
  return <div className="task-flow"><div className="flow-toolbar"><span>{tasks.length} tasks{layout.nodes.length>tasks.length?` · ${layout.nodes.length-tasks.length} prerequisite(s) shown for context`:''}</span><div className="button-row"><button className="subtle-button" aria-label="Zoom flowchart out" disabled={zoom<=.55} onClick={()=>setZoom(Math.max(.55,zoom-.15))}>−</button><span>{Math.round(zoom*100)}%</span><button className="subtle-button" aria-label="Zoom flowchart in" disabled={zoom>=1.6} onClick={()=>setZoom(Math.min(1.6,zoom+.15))}>+</button><button className="subtle-button" onClick={()=>setZoom(Math.max(.55,Math.min(1,(viewport.current?.clientWidth??layout.width)/layout.width)))}>Fit</button></div></div>
    {!tasks.length?<div className="empty-state"><Icon name="check" size={30}/><p>No tasks in this view.</p></div>:<div className="flow-viewport" ref={viewport} aria-label="Task flowchart" onPointerDown={e=>{if((e.target as HTMLElement).closest('button,input,.flow-node'))return;pan.current={x:e.clientX,y:e.clientY,left:e.currentTarget.scrollLeft,top:e.currentTarget.scrollTop};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(pan.current){e.currentTarget.scrollLeft=pan.current.left-(e.clientX-pan.current.x);e.currentTarget.scrollTop=pan.current.top-(e.clientY-pan.current.y);}}} onPointerUp={()=>{pan.current=null;}} onPointerCancel={()=>{pan.current=null;}}>
      <div className="flow-surface" style={{width:layout.width*zoom,height:layout.height*zoom}}><div className="flow-plane" style={{width:layout.width,height:layout.height,transform:`scale(${zoom})`}}>
        <svg className="flow-edges" width={layout.width} height={layout.height} role="img" aria-label="Arrows connect prerequisite tasks to dependent tasks"><defs><marker id="task-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>{layout.edges.map(edge=>{const from=byId.get(edge.from)!,to=byId.get(edge.to)!,x1=from.x+from.width,y1=from.y+44,x2=to.x,y2=to.y+44,mid=(x1+x2)/2;return <path className="flow-edge" key={`${edge.from}-${edge.to}`} data-from={edge.from} data-to={edge.to} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2-7} ${y2}`} markerEnd="url(#task-flow-arrow)"><title>{from.task.title} → {to.task.title}</title></path>;})}</svg>
        {layout.nodes.map(({task,x,y,width,context})=>{const blocked=blockers(task,snapshot.tasks),project=snapshot.projects.find(p=>p.id===task.projectId),section=snapshot.sections.find(s=>s.id===task.sectionId);return <article className={`flow-node color-${task.color} ${task.completed?'is-completed':''} ${context?'context-node':''}`} data-task-id={task.id} key={task.id} style={{left:x,top:y,width}}>
          <div className="flow-caption">{context?'Prerequisite':project?.id!=='inbox'?project?.title:'Task'}{section?` / ${section.title}`:''}</div>
          <div className="flow-node-heading"><button className={`task-check ${task.completed?'checked':''}`} disabled={busy} aria-label={`${task.completed?'Reopen':'Complete'} ${task.title} in flowchart`} onClick={()=>void save([{action:'update',entity:'task',id:task.id,fields:{completed:!task.completed}}],task.completed?'Reopen task':'Complete task')}>{task.completed&&<Icon name="check" size={14}/>}</button><button className="task-title" onClick={()=>onOpen(task)}>{task.title}</button><button className="icon-button" aria-label={`Edit task ${task.title}`} onClick={()=>onOpen(task)}><Icon name="edit" size={16}/></button>{textBoxButton(task)}</div>
          {task.dueDate&&<div className="flow-date">Deadline {shortDate(task.dueDate)}{task.dueDate<today&&!task.completed?' · Overdue':''}{snapshot.events.some(e=>e.linkedTaskId===task.id)?' · On Calendar':''}</div>}
          {!task.completed&&blocked.length>0&&<div className="blocked-warning">After {blocked.map((parent,index)=><React.Fragment key={parent.id}>{index>0&&', '}<button onClick={()=>onOpen(parent)}>{parent.title}</button></React.Fragment>)}</div>}
          {task.steps.length>0&&<div className="flow-steps" aria-label={`Steps for ${task.title}`}><Checklist steps={task.steps} disabled={busy} onChange={steps=>save([{action:'update',entity:'task',id:task.id,fields:{steps}}],'Update task steps')}/></div>}
        </article>;})}
      </div></div>
    </div>}
  </div>;
});
export default TaskFlow;
