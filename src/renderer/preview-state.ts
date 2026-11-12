import type {Change,PendingDraft,Snapshot} from '../shared/model';
import {shiftDate} from '../shared/dates';
import type {CalendarEntry} from '../shared/calendar';
export function draftOwns(draft:PendingDraft|null,change:Pick<Change,'entity'|'id'>){return !!draft?.items.some(item=>item.entity===change.entity&&item.id===change.id);}
/** Overlay only proposal-owned identities; concurrent saved records and preferences stay live. */
export function previewSnapshot(saved:Snapshot,draft:PendingDraft|null):Snapshot{
  if(!draft)return saved;
  const result={...saved};
  for(const [entity,key] of [['task','tasks'],['event','events'],['project','projects'],['section','sections'],['category','categories']] as const){
    const ids=new Set(draft.items.filter(i=>i.entity===entity).map(i=>i.id));
    const proposed=draft.projectedSnapshot[key];
    const rows=[...saved[key].filter(i=>!ids.has(i.id)),...proposed.filter(i=>ids.has(i.id))];
    rows.sort((a,b)=>{const index=(id:string)=>saved[key].findIndex(i=>i.id===id);const x=index(a.id),y=index(b.id);return (x<0?1e9:x)-(y<0?1e9:y);});
    Object.assign(result,{[key]:rows});
  }
  return result;
}
export function resolutionIds(draft:PendingDraft,changes:Change[]):string[]{
  return draft.unresolved.filter(issue=>!issue.requestId&&!issue.conflictingFields?.length&&changes.some(c=>{
    if(c.entity!==issue.entity||c.id!==issue.targetId||!c.fields)return false;
    if(issue.field==='interval')return typeof c.fields.startTime==='string'&&!!c.fields.startTime&&typeof c.fields.endTime==='string'&&!!c.fields.endTime;
    if(!issue.field||!(issue.field in c.fields))return false;
    const value=c.fields[issue.field];return value!==null&&value!==''&&value!==undefined;
  })).map(i=>i.id);
}
export function calendarResize(date:string,minutes:number){const at=Math.max(0,Math.round(minutes/15)*15);return {endDate:shiftDate(date,Math.floor(at/1440)),endTime:`${String(Math.floor(at%1440/60)).padStart(2,'0')}:${String(at%60).padStart(2,'0')}`};}
export const entryKey=(entry:{id:string;entryType?:string})=>`${entry.entryType??'session'}:${entry.id}`;
export function navigationRange(current:{start:number;end:number},offset:number){const start=Math.min(current.start,offset-7),end=Math.max(current.end,offset+14);return end-start>730?{start:offset-90,end:offset+120}:{start,end};}
/** A new record depending on a proposal-only identity must join the same draft. */
export function draftRequiresChange(draft:PendingDraft|null,saved:Snapshot,change:Change):boolean{
  if(!draft)return false;if(draftOwns(draft,change))return true;
  const fields=change.fields;if(!fields)return false;
  const onlyProposed=(key:'tasks'|'projects'|'sections'|'categories',id:unknown)=>typeof id==='string'&&draft.projectedSnapshot[key].some(item=>item.id===id)&&!saved[key].some(item=>item.id===id);
  if(onlyProposed('tasks',fields.linkedTaskId)||onlyProposed('projects',fields.projectId)||onlyProposed('sections',fields.sectionId)||onlyProposed('categories',fields.categoryId))return true;
  if(Array.isArray(fields.dependsOnIds)&&fields.dependsOnIds.some(id=>onlyProposed('tasks',id)))return true;
  if(typeof fields.linkedTaskId==='string'&&typeof fields.linkedStepId==='string'){
    const pending=draft.projectedSnapshot.tasks.find(task=>task.id===fields.linkedTaskId),live=saved.tasks.find(task=>task.id===fields.linkedTaskId);
    if(pending?.steps.some(step=>step.id===fields.linkedStepId)&&!live?.steps.some(step=>step.id===fields.linkedStepId))return true;
  }
  return false;
}
export function visibleAllDayEntries(entries:CalendarEntry[],selected?:string):CalendarEntry[]{const shown=entries.slice(0,3),target=entries.find(entry=>entryKey(entry)===selected);if(target&&!shown.includes(target))shown[shown.length-1]=target;return shown;}
