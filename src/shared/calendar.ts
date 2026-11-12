import {Change,EventItem,Snapshot,Task} from './model';
import {daysBetween,isDate,shiftDate} from './dates';

export interface CalendarEntry extends EventItem { entryType:'session'|'deadline'; canComplete:boolean; }
/** Use a typed reference whenever a legacy session ID collides with a deadline ID. */
export type CalendarEntryReference = Pick<CalendarEntry,'id'|'entryType'> | string;

/** Completion belongs to work, never to an independently logged activity. */
export function eventCompletion(event:Pick<EventItem,'linkedTaskId'|'linkedStepId'>,tasks:Task[]):boolean|null {
  const task=tasks.find(t=>t.id===event.linkedTaskId);
  if(!task)return null;
  const step=event.linkedStepId?task.steps.find(s=>s.id===event.linkedStepId):undefined;
  if(event.linkedStepId&&!step)return null;
  return task.completed||Boolean(step?.completed);
}

/** Calendar sessions remain visible when linked work is archived. Deadlines are projections only. */
export function calendarEntries(snapshot:Pick<Snapshot,'events'|'tasks'>):CalendarEntry[]{
  const sessions=snapshot.events.map(event=>{
    const completed=eventCompletion(event,snapshot.tasks);
    return {...event,entryType:'session' as const,completed:completed??false,canComplete:completed!==null};
  });
  const deadlines:CalendarEntry[]=snapshot.tasks.filter(task=>task.dueDate).map(task=>({
    id:`deadline:${task.id}`,entryType:'deadline',kind:'planned',title:task.title,notes:task.notes,textBox:task.textBox,
    categoryId:task.categoryId,colorOverride:task.colorOverride,color:task.color,
    linkedTaskId:task.id,linkedStepId:null,startDate:task.dueDate!,endDate:task.dueDate!,startTime:null,endTime:null,
    completed:task.completed,canComplete:true
  }));
  return [...sessions,...deadlines];
}
function findEntry(snapshot:Pick<Snapshot,'events'|'tasks'>,entry:CalendarEntryReference):CalendarEntry {
  const matches=calendarEntries(snapshot).filter(item=>typeof entry==='string'?item.id===entry:item.id===entry.id&&item.entryType===entry.entryType);
  if(matches.length>1)throw new Error('That calendar entry ID is ambiguous. Use its entryType and ID.');
  const found=matches[0];
  if(!found)throw new Error('That calendar entry no longer exists. Refresh and try again.');
  return found;
}
export function calendarCompletionChanges(snapshot:Pick<Snapshot,'events'|'tasks'>,entry:CalendarEntryReference,completed:boolean):Change[]{
  const selected=findEntry(snapshot,entry);
  if(!selected.canComplete)return [];
  const task=snapshot.tasks.find(t=>t.id===selected.linkedTaskId)!;
  if(!selected.linkedStepId)return [{action:'update',entity:'task',id:task.id,fields:{completed}}];
  return [{action:'update',entity:'task',id:task.id,fields:{
    ...(!completed&&task.completed?{completed:false}:{}),
    steps:task.steps.map(step=>step.id===selected.linkedStepId?{...step,completed}:step)
  }}];
}

/** Deadline editing/movement is a task edit; no deadline row is ever persisted. */
export function calendarEntryChanges(snapshot:Pick<Snapshot,'events'|'tasks'>,entry:CalendarEntryReference,fields:Record<string,unknown>):Change[]{
  const selected=findEntry(snapshot,entry);
  if(selected.entryType==='session')return [{action:'update',entity:'event',id:selected.id,fields}];
  const taskFields:Record<string,unknown>={};
  for(const [key,value] of Object.entries(fields)){
    if(key==='startDate')taskFields.dueDate=value;
    else if(['dueDate','title','notes','textBox','categoryId','categoryTitle','colorOverride','color','completed'].includes(key))taskFields[key]=value;
    else if(key==='endDate'&&value===fields.startDate||['startTime','endTime'].includes(key)&&value===null)continue;
    else throw new Error('A deadline is an all-day task date.');
  }
  return [{action:'update',entity:'task',id:selected.linkedTaskId!,fields:taskFields}];
}
const clockMinutes=(time:string)=>{
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('Use a valid time in HH:mm format.');
  return Number(time.slice(0,2))*60+Number(time.slice(3));
};
export function eventIntervalMinutes(event:Pick<EventItem,'startDate'|'endDate'|'startTime'|'endTime'>):number|null{
  if(!event.startTime||!event.endTime)return null;
  return daysBetween(event.startDate,event.endDate)*1440+clockMinutes(event.endTime)-clockMinutes(event.startTime);
}
/** Move exact times without snapping; the interactive resize control owns its snap policy. */
export function moveEventTo(event:Pick<EventItem,'startDate'|'endDate'|'startTime'|'endTime'>,date:string,time?:string|null):Pick<EventItem,'startDate'|'endDate'|'startTime'|'endTime'>{
  if(!isDate(date))throw new Error('Use a valid date in YYYY-MM-DD format.');
  if(time===undefined)return {startDate:date,endDate:shiftDate(event.endDate,daysBetween(event.startDate,date)),startTime:event.startTime,endTime:event.endTime};
  if(time===null)return {startDate:date,endDate:shiftDate(date,daysBetween(event.startDate,event.endDate)),startTime:null,endTime:null};
  const start=clockMinutes(time),duration=eventIntervalMinutes(event),end=duration===null?null:start+duration;
  if(duration!==null&&duration<=0)throw new Error('The end time must be after the start time.');
  return {startDate:date,startTime:time,endDate:shiftDate(date,end===null?daysBetween(event.startDate,event.endDate):Math.floor(end/1440)),endTime:end===null?null:`${String(Math.floor(end%1440/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`};
}
