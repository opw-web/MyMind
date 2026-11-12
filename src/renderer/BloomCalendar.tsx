import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {DragEvent,HTMLAttributes,ReactNode} from 'react';
import type {PendingDraft,Snapshot,Task} from '../shared/model';
import {CalendarEntry,calendarEntries,moveEventTo} from '../shared/calendar';
import {daysBetween,shiftDate} from '../shared/dates';
import {Icon} from './App';
import {calendarResize,entryKey,navigationRange,visibleAllDayEntries} from './preview-state';
export const HOUR_PX=66,GUTTER=68,HEADER_H=76,ALLDAY_H=62;
const MIN_PX=HOUR_PX/60,MIN_DAY_W=148,EXTEND=60;
export interface CalendarPosition{left:number;top:number;rangeStart?:number;rangeEnd?:number;}
export interface CalendarHandle{scrollToDate(date:string,smooth?:boolean,time?:string|null):void;scrollByDays(days:number):void;position():CalendarPosition;restore(value:CalendarPosition):void;}
interface Props{
 snapshot:Snapshot;today:string;now:number;hidden:Set<string>;busy:boolean;draft:PendingDraft|null;saved:Snapshot;kind:'all'|'planned'|'actual';selected?:string;
 onDay:(date:string)=>void;onNew:(date:string,startTime?:string,endTime?:string,endDate?:string)=>void;onOpen:(item:CalendarEntry|Task)=>void;
 onToggle:(item:CalendarEntry)=>void;onMove:(item:CalendarEntry,fields:Record<string,unknown>)=>void;onLead:(date:string)=>void;
 eventProps:(event:CalendarEntry)=>HTMLAttributes<HTMLElement>;textBoxButton:(item:CalendarEntry|Task)=>ReactNode;timezone:string;
}
const minutes=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3));
const clock=(at:number)=>`${String(Math.floor(at%1440/60)).padStart(2,'0')}:${String(at%60).padStart(2,'0')}`;
const snap=(at:number)=>Math.max(0,Math.min(1440,Math.round(at/15)*15));
type Segment={event:CalendarEntry;start:number;end:number;lane:number;lanes:number};
function daySegments(events:CalendarEntry[],date:string):Segment[]{
 const items=events.filter(e=>e.startTime&&e.startDate<=date&&e.endDate>=date&&!(e.endDate===date&&e.endDate!==e.startDate&&e.endTime==='00:00')).map(event=>{
  const start=event.startDate===date?minutes(event.startTime!):0,end=event.endDate===date?(event.endTime?minutes(event.endTime):Math.min(1440,start+60)):1440;
  return {event,start,end:Math.max(end,start+15)};
 }).sort((a,b)=>a.start-b.start||b.end-a.end);
 const result:Segment[]=[];let cluster:Segment[]=[],clusterEnd=0;
 const flush=()=>{const lanes=Math.max(1,...cluster.map(s=>s.lane+1));cluster.forEach(s=>s.lanes=lanes);result.push(...cluster);cluster=[];};
 for(const item of items){if(cluster.length&&item.start>=clusterEnd)flush();const used=new Set(cluster.filter(s=>s.end>item.start).map(s=>s.lane));let lane=0;while(used.has(lane))lane++;cluster.push({...item,lane,lanes:1});clusterEnd=Math.max(clusterEnd,item.end);}flush();return result;
}
const BloomCalendar=forwardRef<CalendarHandle,Props>(function BloomCalendar({snapshot,saved,draft,kind,selected,today,now,hidden,busy,onDay,onNew,onOpen,onToggle,onMove,onLead,eventProps,textBoxButton,timezone},ref){
 const restoration=useRef<CalendarPosition|null>(null),[layoutVersion,setLayoutVersion]=useState(0);
 const measuredWidth=useRef(0);
 const panel=useRef<HTMLDivElement>(null),leadRef=useRef(''),started=useRef(false),compensate=useRef(0);
 const [range,setRange]=useState({start:-90,end:120}),[dayW,setDayW]=useState(MIN_DAY_W),[navigation,setNavigation]=useState<{date:string;smooth:boolean;time?:string|null}|null>(null),[ghost,setGhost]=useState<{date:string;from:number;to:number}|null>(null);
 const selecting=useRef<{date:string;origin:number;column:HTMLElement;y:number}|null>(null),resizing=useRef<{event:CalendarEntry;date:string;column:HTMLElement}|null>(null);
 const days=useMemo(()=>Array.from({length:range.end-range.start},(_,i)=>shiftDate(today,range.start+i)),[today,range]);
 const unresolved=new Set(draft?.unresolved.filter(i=>i.field==='interval').map(i=>i.targetId));
 const allEntries=calendarEntries(snapshot),entries=allEntries.filter(e=>!unresolved.has(e.id)&&(!e.categoryId||!hidden.has(e.categoryId))&&(kind==='all'||e.kind===kind));
 const changed=(e:CalendarEntry)=>draft?.items.find(i=>i.entity===(e.entryType==='deadline'?'task':'event')&&i.id===(e.entryType==='deadline'?e.linkedTaskId:e.id));
 const originals=calendarEntries(saved).filter(e=>{const item=changed(e);const after=allEntries.find(a=>entryKey(a)===entryKey(e));return item&&(item.action==='delete'||!after||['startDate','endDate','startTime','endTime'].some(k=>e[k as keyof CalendarEntry]!==after[k as keyof CalendarEntry]));});
 const navigate=(date:string,smooth=false,time?:string|null)=>{const offset=daysBetween(today,date),el=panel.current;if(el?.clientWidth&&offset>=range.start&&offset<range.end){el.scrollTo({left:(offset-range.start)*dayW,...(time?{top:Math.max(0,minutes(time)*MIN_PX-90)}:{}),behavior:smooth&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});setNavigation(null);return;}setRange(r=>navigationRange(r,offset));setNavigation({date,smooth,time});};
 useImperativeHandle(ref,()=>({scrollToDate:navigate,scrollByDays:n=>panel.current?.scrollBy({left:n*dayW,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}),position:()=>({left:panel.current?.scrollLeft??0,top:panel.current?.scrollTop??0,rangeStart:range.start,rangeEnd:range.end}),restore:p=>{setNavigation(null);restoration.current=p;if(p.rangeStart!==undefined&&p.rangeEnd!==undefined)setRange({start:p.rangeStart,end:p.rangeEnd});setLayoutVersion(v=>v+1);}}),[today,dayW,range.start,range.end]);
 useLayoutEffect(()=>{const el=panel.current;if(!el)return;const measure=()=>{if(el.clientWidth>0){measuredWidth.current=Math.max(MIN_DAY_W,Math.floor((el.clientWidth-GUTTER-1)/7));setDayW(measuredWidth.current);setLayoutVersion(v=>v+1);}};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();},[]);
 useLayoutEffect(()=>{const el=panel.current,value=restoration.current;if(el?.clientWidth&&value&&measuredWidth.current===dayW){el.scrollLeft=value.left;el.scrollTop=value.top;restoration.current=null;}},[layoutVersion,dayW,range]);
 const previousWidth=useRef(dayW);
 useLayoutEffect(()=>{if(started.current&&panel.current&&previousWidth.current!==dayW)panel.current.scrollLeft=panel.current.scrollLeft*dayW/previousWidth.current;previousWidth.current=dayW;},[dayW]);
 useLayoutEffect(()=>{const el=panel.current;if(!el||measuredWidth.current!==dayW)return;if(navigation){el.scrollTo({left:daysBetween(days[0],navigation.date)*dayW,...(navigation.time?{top:Math.max(0,minutes(navigation.time)*MIN_PX-90)}:{}),behavior:navigation.smooth&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});setNavigation(null);compensate.current=0;started.current=true;}else if(!started.current){el.scrollTo({left:daysBetween(days[0],today)*dayW,top:7*HOUR_PX-14});started.current=true;}else if(compensate.current){el.scrollLeft+=compensate.current*dayW;compensate.current=0;}},[days,dayW,navigation,today]);
 const onScroll=()=>{const el=panel.current;if(!el||!started.current||!el.clientWidth)return;const lead=days[Math.min(days.length-1,Math.max(0,Math.round(el.scrollLeft/dayW)))];if(lead!==leadRef.current){leadRef.current=lead;onLead(lead);}if(el.scrollLeft<dayW*7&&!navigation){compensate.current=EXTEND;setRange(r=>({...r,start:r.start-EXTEND}));}else if(el.scrollWidth-el.scrollLeft-el.clientWidth<dayW*7)setRange(r=>({...r,end:r.end+EXTEND}));};
 const minutesAt=(y:number,column:HTMLElement)=>snap((y-column.getBoundingClientRect().top)/MIN_PX);
 useEffect(()=>{const move=(e:MouseEvent)=>{const s=selecting.current,r=resizing.current;if(s){const at=minutesAt(e.clientY,s.column);setGhost({date:s.date,from:Math.min(s.origin,at),to:Math.max(s.origin,at)});}if(r){const at=minutesAt(e.clientY,r.column);setGhost({date:r.date,from:r.event.startDate===r.date?minutes(r.event.startTime!):0,to:at});}};const up=(e:MouseEvent)=>{const s=selecting.current,r=resizing.current;selecting.current=null;resizing.current=null;setGhost(null);if(s&&Math.abs(e.clientY-s.y)>=6){const at=minutesAt(e.clientY,s.column),from=Math.min(s.origin,at),to=Math.max(s.origin,at,from+15);onNew(shiftDate(s.date,Math.floor(from/1440)),clock(from),clock(to),shiftDate(s.date,Math.floor(to/1440)));}if(r){const fields=calendarResize(r.date,minutesAt(e.clientY,r.column));const duration=daysBetween(r.event.startDate,fields.endDate)*1440+minutes(fields.endTime)-minutes(r.event.startTime!);if(duration>0)onMove(r.event,fields);}};window.addEventListener('mousemove',move);window.addEventListener('mouseup',up);return()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);};},[onNew,onMove]);
 function drag(e:DragEvent,event:CalendarEntry,anchor:string){e.dataTransfer.setData('application/mymind',JSON.stringify({entity:'event',id:event.id,entryType:event.entryType,anchor}));e.dataTransfer.effectAllowed='move';}
 function drop(e:DragEvent,date:string,timed=false){
  e.preventDefault();
  try{
   const data=JSON.parse(e.dataTransfer.getData('application/mymind'));
   const entry=allEntries.find(i=>i.id===data.id&&i.entryType===(data.entryType??'session'));
   if(!entry)return;
   const anchor=data.anchor??entry.startDate;
   const targetDate=shiftDate(entry.startDate,daysBetween(anchor,date));
   if(entry.entryType==='deadline'){onMove(entry,{startDate:targetDate});return;}
   if(!timed){onMove(entry,moveEventTo(entry,targetDate));return;}
   const at=Math.min(1425,minutesAt(e.clientY,e.currentTarget as HTMLElement));
   if(!entry.startTime||anchor===entry.startDate){onMove(entry,moveEventTo(entry,targetDate,clock(at)));return;}
   // A timed continuation starts at midnight on its rendered day.
   const moved=minutes(entry.startTime)+at;
   onMove(entry,moveEventTo(entry,shiftDate(targetDate,Math.floor(moved/1440)),clock(moved%1440)));
  }catch{}
 }
 const card=(event:CalendarEntry,date:string,style?:React.CSSProperties,original=false)=>{
 const proposed=!!changed(event),removed=changed(event)?.action==='delete',task=snapshot.tasks.find(t=>t.id===event.linkedTaskId),timed=!!style;
 return <div key={(original?'original:':'')+entryKey(event)} className={`${timed?'event-block':'all-day-chip'} event-card color-${event.color} ${timed&&Number(style?.height)<47?'event-compact':''} ${event.kind==='actual'?'actual-entry':''} ${event.completed?'is-completed':''} ${original?'preview-original':proposed?'preview-proposed':''} ${selected===entryKey(event)?'preview-selected':''}`} style={style} data-event-id={event.id} data-entry-type={event.entryType} data-linked-task={event.linkedTaskId??undefined} data-start-date={event.startDate} data-end-date={event.endDate} draggable={!original&&!busy} onDragStart={e=>drag(e,event,date)} {...(!original?eventProps(event):{})}>
 {original?<span className="original-label">{removed?'Remove':'Was'} · {event.title}</span>:<>
 {event.canComplete&&<button className={'task-check event-check '+(event.completed?'checked':'')} disabled={busy} aria-label={`${event.completed?'Reopen':'Complete'} ${event.title} in calendar`} onClick={()=>onToggle(event)}>{event.completed&&<Icon name="check" size={11}/>}</button>}
 <button className="event-content" title={event.title} onClick={()=>onOpen(event)}><span className="event-title">{event.entryType==='deadline'?'Deadline · ':''}{event.title}</span>{timed&&<span className="event-time">{event.startDate!==date?'↳ ':''}{event.startTime}–{event.endTime}{event.endDate!==date?' · continues':''}</span>}{event.kind==='actual'&&<span className="entry-kind">Actual</span>}</button>
 {task&&event.entryType==='session'&&<button className="linked-event-open event-link" aria-label={`Open linked ${event.linkedStepId?'step':'task'} for ${event.title}`} onClick={()=>onOpen(task)}><Icon name="link" size={12}/></button>}
 <span className="event-box">{textBoxButton(event.entryType==='deadline'&&task?task:event)}</span>
 {timed&&(event.endDate===date||event.endTime==='00:00'&&event.endDate===shiftDate(date,1))&&<button className="event-resize" aria-label={`Resize ${event.title}`} disabled={busy} onMouseDown={e=>{e.preventDefault();e.stopPropagation();resizing.current={event,date,column:e.currentTarget.closest('.time-column') as HTMLElement};}}/>}
 </>}
 </div>;};
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(now)),minutesNow=Number(parts.find(p=>p.type==='hour')!.value)%24*60+Number(parts.find(p=>p.type==='minute')!.value);
 return <div className="calendar-panel" ref={panel} data-testid="calendar" onScroll={onScroll}><div className="calendar-sheet" style={{width:GUTTER+days.length*dayW}}>
 <div className="day-headers" style={{height:HEADER_H}}><div className="corner-label" style={{width:GUTTER}}>TIME</div>{days.map(date=><button key={date} className={'day-header '+(date===today?'is-today':'')} style={{width:dayW}} data-date={date} aria-label={'Open day '+date} onClick={()=>onDay(date)}><span className="weekday">{new Intl.DateTimeFormat('en',{weekday:'short',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')).toUpperCase()}</span><span className="day-number">{Number(date.slice(8))}</span>{date===today&&<span className="today-dot"/>}</button>)}</div>
 <div className="allday-row" style={{minHeight:ALLDAY_H,top:HEADER_H}}><div className="all-day-gutter" style={{width:GUTTER}}><span>ALL DAY</span></div>{days.map(date=>{const chips=entries.filter(e=>!e.startTime&&e.startDate<=date&&e.endDate>=date);return <div key={date} className="all-day-cell" style={{width:dayW}} data-date={date} onDoubleClick={()=>onNew(date)} onDragOver={e=>e.preventDefault()} onDrop={e=>drop(e,date)}>{visibleAllDayEntries(chips,selected).map(e=>card(e,date))}{originals.filter(e=>!e.startTime&&e.startDate===date).map(e=>card(e,date,undefined,true))}{chips.length>3&&<button className="all-day-more" onClick={()=>onDay(date)}>+{chips.length-3} more</button>}</div>;})}</div>
 <div className="hour-area" style={{height:24*HOUR_PX}}><div className="hour-gutter" style={{width:GUTTER,height:24*HOUR_PX}}>{Array.from({length:24},(_,h)=><div className="hour-mark" key={h} style={{top:h*HOUR_PX}}>{h?`${h%12||12} ${h<12?'AM':'PM'}`:''}</div>)}</div>{days.map(date=><div key={date} className={'time-column '+(date===today?'time-today':'')} style={{width:dayW,height:24*HOUR_PX}} data-date={date} onDoubleClick={e=>{if(e.target===e.currentTarget){const at=Math.min(1380,minutesAt(e.clientY,e.currentTarget));onNew(date,clock(at),clock(at+60),shiftDate(date,Math.floor((at+60)/1440)));}}} onMouseDown={e=>{if(e.button===0&&e.target===e.currentTarget)selecting.current={date,origin:minutesAt(e.clientY,e.currentTarget),column:e.currentTarget,y:e.clientY};}} onDragOver={e=>e.preventDefault()} onDrop={e=>drop(e,date,true)}>
 {daySegments(entries,date).map(({event,start,end,lane,lanes})=>card(event,date,{top:start*MIN_PX,height:Math.max(24,(end-start)*MIN_PX-2),left:`calc(${lane/lanes*100}% + 5px)`,width:`calc(${100/lanes}% - 10px)`}))}
 {daySegments(originals,date).map(({event,start,end})=>card(event,date,{top:start*MIN_PX,height:Math.max(24,(end-start)*MIN_PX-2),left:5,width:'calc(100% - 10px)'},true))}
 {ghost?.date===date&&<div className="drag-ghost" style={{top:ghost.from*MIN_PX,height:Math.max(15,(ghost.to-ghost.from)*MIN_PX)}}/>}{date===today&&<div className="now-line" style={{top:minutesNow*MIN_PX}}><span className="now-bubble"/></div>}
 </div>)}</div></div></div>;
});
export default BloomCalendar;
