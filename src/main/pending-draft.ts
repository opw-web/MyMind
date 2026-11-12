import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ApplyDraftInput,Change,DismissDraftInput,DraftIssue,EditDraftInput,PendingDraft,Receipt,Snapshot} from '../shared/model';
import {CompiledBatch,PlannerDatabase,RestoreToken,UndoToken} from './database';
import {prepareDraft} from './draft';
import {eventIntervalMinutes} from '../shared/calendar';
import {isDate} from '../shared/dates';
import {changeSchema} from '../shared/validation';
const identity={draftId:z.string().min(1),version:z.number().int().positive()};
const applySchema=z.object({...identity,expectedRevision:z.number().int().nonnegative(),requestId:z.string().min(1).max(100)}).strict();
const editSchema=z.object({...identity,expectedRevision:z.number().int().nonnegative(),changes:z.array(changeSchema).optional(),repreview:z.boolean().optional(),resolveIssueIds:z.array(z.string()).optional()}).strict();
export interface RequestQuestion {requestId:string;request:string;entity:'event'|'task';subject:string[];fields:string[];}
interface ConflictRequirement {fields:string[];blocked:boolean;}
interface State {questions:Map<string,RequestQuestion>;conflicts:Map<string,ConflictRequirement>;tombstones:Map<string,Change|undefined>;baseSnapshot:Snapshot;clock:Date;id:string;version:number;baseRevision:number;changes:Change[];compiled:CompiledBatch;undo?:UndoToken;restores:RestoreToken[];unresolved:DraftIssue[];timezone:string;}
export interface DraftTurn {readonly jobId:string;readonly generation:number;readonly version:number;readonly revision:number;readonly draftId?:string;readonly requestId:string;}
/** Only this owner holds compiled states; renderer projections are never Apply input. */
export class PendingDraftService {
 private current?:State;
 private generation=0;
 private active=new Set<string>();
 private dispositions=new Map<string,{status:'applied';receipt:Receipt}|{status:'dismissed'}>();
 private keys=new Map<string,Map<string,string>>();
 constructor(private db:PlannerDatabase,private changed:(draft:PendingDraft|null)=>void=()=>{}){}
 get busy():boolean{return this.active.size>0;}
 getDraft():PendingDraft|null {
  const s=this.current;if(!s)return null;const live=this.db.snapshot();
  return structuredClone({id:s.id,version:s.version,baseRevision:s.baseRevision,changes:s.changes,projectedSnapshot:{...s.compiled.projectedSnapshot,preferences:live.preferences},items:s.compiled.items,unresolved:s.unresolved,stale:s.baseRevision!==live.revision||s.timezone!==live.preferences.timezone,busy:this.busy,timezone:s.timezone,descriptions:s.compiled.descriptions});
 }
 snapshot():Snapshot {return this.getDraft()?.projectedSnapshot??this.db.snapshot();}
 begin(requestId:string):DraftTurn {
  const jobId=randomUUID();this.active.add(jobId);this.changed(this.getDraft());return {jobId,generation:this.generation,version:this.current?.version??0,revision:this.db.revision,draftId:this.current?.id,requestId};
 }
 end(turn?:DraftTurn):void {if(turn)this.active.delete(turn.jobId);else this.active.clear();this.changed(this.getDraft());}
 key(requestId:string,key:string):string {let map=this.keys.get(requestId);if(!map){map=new Map();this.keys.set(requestId,map);}let id=map.get(key);if(!id){id=randomUUID();map.set(key,id);}return id;}
 disposition(id:string){return this.dispositions.get(id);}
 questionContext(id:string):RequestQuestion|undefined {const context=this.current?.questions.get(id);return context&&this.current?.unresolved.some(issue=>issue.id===id)?structuredClone(context):undefined;}
 referencedQuestions(text:string):string[] {
  if(/\b(?:another|different|separate|new)\b|^(?:how|why|what|when|where|if|imagine|suppose)\b|\b(?:don't|do not|never|what if)\b/i.test(text))return [];
  const words:string[]=text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[],matches:string[]=[];
  for(const [id,context] of this.current?.questions??[])if(context.subject.every(word=>words.includes(word))&&words.some((word,index)=>['the','that','this'].includes(word)&&context.subject.includes(words[index+1])))matches.push(id);
  return matches.length===1?matches:[];
 }
 private matches(turn:DraftTurn):void {
  if(turn.generation!==this.generation||turn.version!==(this.current?.version??0)||turn.draftId!==this.current?.id)throw new Error('This draft changed while the assistant was working. Your latest preview is preserved.');
  if(turn.revision!==this.db.revision||this.getDraft()?.stale)throw new Error('Your planner changed. Re-preview the pending draft before editing or Apply.');
 }
 advance(turn:DraftTurn):DraftTurn {if(turn.generation!==this.generation)throw new Error('This draft was dismissed.');return {...turn,version:this.current?.version??0,draftId:this.current?.id};}
 prepare(turn:DraftTurn,previous:Change[],incoming:Change[]):{changes:Change[]} {
  this.matches(turn);const old=this.current,local=prepareDraft(this.snapshot(),previous,incoming),undo=old?.undo,restores=old?.restores??[];
  const baseline=undo||restores.length?this.db.previewBatch({expectedRevision:turn.revision,changes:[],undo,restores}).projectedSnapshot:this.db.snapshot();
  this.db.previewBatch({expectedRevision:turn.revision,changes:prepareDraft(baseline,old?.changes??[],local),undo,restores});return {changes:local};
 }
 stage(turn:DraftTurn,incoming:Change[],options:{answerQuestionIds?:string[];requestQuestions?:{issueId:string;context:RequestQuestion}[];resolveIssueIds?:Set<string>;unresolved?:DraftIssue[];undo?:UndoToken;restore?:RestoreToken;restoreId?:string;restoreEntity?:Change['entity']}={}):PendingDraft {
  this.matches(turn);const old=this.current;
  for(const change of incoming){
    if(change.entity==='task'&&change.fields&&'scheduledDate' in change.fields)throw new Error('Use explicit event sessions for calendar placement.');
    if(change.entity==='event'&&change.fields?.completed!==undefined){const existing=this.snapshot().events.find(event=>event.id===change.id);if(change.action==='create'||!existing?.linkedTaskId)throw new Error('Standalone events have no completion control.');}
  }
  let previous=old?.changes??[];const tombstones=new Map(old?.tombstones??[]);
  for(const change of incoming)if(change.action==='delete'&&change.id){const key=`${change.entity}:${change.id}`;if(!tombstones.has(key))tombstones.set(key,previous.find(c=>c.entity===change.entity&&c.id===change.id));}
  if(options.restoreId){const deletion=previous.find(c=>c.id===options.restoreId&&c.action==='delete'&&(!options.restoreEntity||c.entity===options.restoreEntity)),key=`${options.restoreEntity??deletion?.entity}:${options.restoreId}`,retained=tombstones.get(key);previous=previous.filter(c=>!(c.id===options.restoreId&&c.action==='delete'&&(!options.restoreEntity||c.entity===options.restoreEntity)));if(retained)previous=[...previous,retained];tombstones.delete(key);}
  const undo=options.undo??old?.undo,restores=[...(old?.restores??[]),...(options.restore?[options.restore]:[])];
  const baseline=undo||restores.length?this.db.previewBatch({expectedRevision:turn.revision,changes:[],undo,restores}).projectedSnapshot:this.db.snapshot();
  const changes=prepareDraft(baseline,previous,incoming),clock=old?.clock??new Date(),compiled=this.db.previewBatch({expectedRevision:turn.revision,changes,undo,restores,clock});
  const questions=new Map(old?.questions??[]),answered=new Set<string>();
  for(const id of options.answerQuestionIds??[]){const context=questions.get(id);if(!context)continue;
    const matches=incoming.filter(change=>change.action!=='delete'&&change.entity===context.entity&&change.id).map(change=>({change,target:compiled.projectedSnapshot[context.entity==='event'?'events':'tasks'].find(item=>item.id===change.id)})).filter(({target})=>target&&context.subject.every(word=>(target.title.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).some(token=>token===word)));
    const identities=new Set(matches.map(({change})=>change.id));if(identities.size!==1)continue;
    const idTarget=matches[0].change.id!;
    try{for(const field of context.fields)this.validateResolution({id,required:true,question:'Required request detail',entity:context.entity,targetId:idTarget,field},incoming,compiled.projectedSnapshot);answered.add(id);}catch{}
  }
  const conflicts=new Map(old?.conflicts??[]);
  for(const id of options.resolveIssueIds??[]){const issue=old?.unresolved.find(issue=>issue.id===id);if(!issue)throw new Error('That clarification no longer exists.');this.validateResolution(issue,incoming,compiled.projectedSnapshot,conflicts.get(id));}
  const retained=(old?.unresolved??[]).filter(issue=>{if(options.resolveIssueIds?.has(issue.id)||answered.has(issue.id))return false;if(issue.field==='conflict')return true;try{this.validateResolution(issue,incoming,compiled.projectedSnapshot);return false;}catch{return true;}});
  const unresolved=[...retained,...(options.unresolved??[])];
  for(const entry of options.requestQuestions??[]){const issue=unresolved.find(issue=>issue.id===entry.issueId);if(!issue)throw new Error('The required request question no longer exists.');issue.requestId=entry.context.requestId;questions.set(entry.issueId,structuredClone(entry.context));}
  for(const id of questions.keys())if(!unresolved.some(issue=>issue.id===id))questions.delete(id);
  for(const id of conflicts.keys())if(!unresolved.some(issue=>issue.id===id))conflicts.delete(id);
  this.matches(turn);this.current={questions,conflicts,tombstones,baseSnapshot:old?.baseSnapshot??this.db.snapshot(),clock,id:old?.id??randomUUID(),version:(old?.version??0)+1,baseRevision:turn.revision,changes:compiled.changes,compiled,undo,restores,unresolved,timezone:baseline.preferences.timezone};
  const result=this.getDraft()!;this.changed(result);return result;
 }
 private validateResolution(issue:DraftIssue,changes:Change[],candidate:Snapshot,conflict?:ConflictRequirement):void {
  if(!issue.required)return;
  if(conflict?.blocked)throw new Error('This conflict cannot be resolved by editing fields. Dismiss the proposal and prepare a new request.');
  const patch=changes.find(change=>change.action!=='delete'&&change.id===issue.targetId&&(!issue.entity||change.entity===issue.entity));
  const fields=patch?.fields;
  if(!patch||!fields||!issue.targetId)throw new Error('Resolve this required issue with a matching target and field correction.');
  const collection=candidate[patch.entity==='category'?'categories':`${patch.entity}s` as keyof Snapshot] as unknown as {id:string;[key:string]:unknown}[];
  const target=collection.find(item=>item.id===issue.targetId);if(!target)throw new Error('The required target no longer exists.');
  const supplied=(field:string)=>Object.prototype.hasOwnProperty.call(fields,field);
  if(issue.field==='interval'){
    if(patch.entity!=='event'||!supplied('startTime')||!supplied('endTime')||!target.startTime||!target.endTime||!(eventIntervalMinutes(target as unknown as Snapshot['events'][number])!>0))throw new Error('Resolve the required interval with valid start and end times.');
    return;
  }
  const requiredFields=issue.field==='conflict'?conflict?.fields:issue.field?[issue.field]:undefined;
  if(!requiredFields?.length||requiredFields.some(field=>!supplied(field)))throw new Error('Resolve this issue by explicitly choosing each required field value.');
  if(issue.field!=='conflict')for(const field of requiredFields){const value=target[field];if(['dueDate','startDate','endDate'].includes(field)&&!(typeof value==='string'&&isDate(value)))throw new Error('Resolve the required date with a valid date.');if(['startTime','endTime'].includes(field)&&!(typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value)))throw new Error('Resolve the required time with a valid time.');if(['title','notes'].includes(field)&&!(typeof value==='string'&&value.trim()))throw new Error('Resolve the required detail with a non-empty value.');}
 }
 editDraft(input:EditDraftInput):PendingDraft {
  const p=editSchema.parse(input),s=this.require(p);if(p.expectedRevision!==(p.repreview?this.db.revision:s.baseRevision))throw new Error('Use the current saved revision for this preview.');
  if(p.repreview){
   const live=this.db.snapshot(),unresolved=[...s.unresolved],conflicts=new Map(s.conflicts);let compiled:CompiledBatch;
   const addConflict=(issue:Omit<DraftIssue,'id'|'required'|'field'>,fields:string[],blocked=false)=>{
    const existing=unresolved.find(item=>item.field==='conflict'&&(issue.targetId?item.targetId===issue.targetId&&item.entity===issue.entity:item.question===issue.question));
    if(existing){const old=conflicts.get(existing.id);const combined=[...new Set([...(old?.fields??[]),...fields])];existing.conflictingFields=combined;conflicts.set(existing.id,{fields:combined,blocked:blocked||old?.blocked===true});}
    else{const id=randomUUID();unresolved.push({...issue,id,required:true,field:'conflict',conflictingFields:fields});conflicts.set(id,{fields,blocked});}
   };
   const collection=(snapshot:Snapshot,entity:string)=>(snapshot[entity==='category'?'categories':`${entity}s` as keyof Snapshot] as unknown as {id:string;[key:string]:unknown}[]);
   for(const change of s.changes){if(change.action==='create')continue;const before=collection(s.baseSnapshot,change.entity).find(i=>i.id===change.id),current=collection(live,change.entity).find(i=>i.id===change.id);
    const fields=current&&change.action==='update'?Object.keys(change.fields??{}).filter(field=>JSON.stringify(before?.[field])!==JSON.stringify(current[field])&&JSON.stringify(change.fields?.[field])!==JSON.stringify(current[field])):[];
    if(!current||fields.length)addConflict({targetId:change.id,entity:change.entity,question:`Saved ${change.entity} changed since this proposal. Review and explicitly resolve ${fields.length?fields.join(', '):'the missing target'} for ${String(current?.title??before?.title??change.id)}.`},fields,!current);
   }
   try{compiled=this.db.previewBatch({expectedRevision:live.revision,changes:prepareDraft(live,[],s.changes),undo:s.undo,restores:s.restores,clock:s.clock});}
   catch(error){addConflict({question:error instanceof Error?error.message:'The draft conflicts with saved data.'},[],true);compiled=this.db.previewBatch({expectedRevision:live.revision,changes:[]});}
   s.compiled=compiled;s.conflicts=conflicts;s.baseSnapshot=live;s.baseRevision=live.revision;s.timezone=live.preferences.timezone;s.unresolved=unresolved;s.version++;this.generation++;this.changed(this.getDraft());return this.getDraft()!;
  }
  if(this.getDraft()?.stale)throw new Error('Your planner changed. Re-preview this draft first.');
  const resolved=new Set(p.resolveIssueIds??[]),unknown=[...resolved].some(id=>!s.unresolved.some(i=>i.id===id));if(unknown)throw new Error('That clarification no longer exists.');
  const turn:DraftTurn={jobId:'typed-edit',generation:this.generation,version:s.version,revision:this.db.revision,draftId:s.id,requestId:'typed-edit'};
  return this.stage(turn,p.changes??[],{resolveIssueIds:resolved});
 }
 applyDraft(input:ApplyDraftInput):Receipt {
  const p=applySchema.parse(input);if(this.busy)throw new Error('Wait for the correction to finish or stop it before Apply.');
  const existing=this.db.draftReceipt(p);if(existing)return existing;
  const s=this.require(p);if(p.expectedRevision!==s.baseRevision||this.getDraft()?.stale)throw new Error('Your planner changed. Re-preview this draft before Apply.');
  if(s.unresolved.some(issue=>issue.required))throw new Error('Resolve the required draft questions before Apply.');
  if(!s.compiled.items.some(item=>item.action!=='undo')&&!s.undo)throw new Error('There are no planner changes to apply.');
  const receipt=this.db.applyBatch(s.compiled,p);this.dispositions.set(s.id,{status:'applied',receipt});this.current=undefined;this.generation++;this.changed(null);return receipt;
 }
 dismissDraft(input:DismissDraftInput):void {const p=z.object(identity).strict().parse(input),s=this.require(p);this.dispositions.set(s.id,{status:'dismissed'});this.current=undefined;this.generation++;this.active.clear();this.changed(null);}
 reset():void {if(this.current)this.dispositions.set(this.current.id,{status:'dismissed'});this.current=undefined;this.generation++;this.active.clear();this.changed(null);}
 private require(p:{draftId:string;version:number}):State {const s=this.current;if(!s||s.id!==p.draftId||s.version!==p.version)throw new Error('That draft version is no longer current. Refresh the preview.');return s;}
}
