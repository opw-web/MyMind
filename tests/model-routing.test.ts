import test from 'node:test';
import assert from 'node:assert/strict';
import {categorizeChanges} from '../src/main/categories';
import {authorizedActions} from '../src/main/capabilities';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';

test('Qwen 4B gets the named record from a large planner without sending unrelated record details',async()=>{
 const db=new PlannerDatabase(':memory:');
 const tasks=Array.from({length:24},(_,index)=>({action:'create' as const,entity:'task' as const,id:`routine-${index}`,fields:{title:`Routine item ${index}`}}));
 db.mutate({changes:[...tasks,{action:'create',entity:'task',id:'needle',fields:{title:'Renew passport'}}],label:'Fixture',requestId:'large-catalog',expectedRevision:0});
 const runtime={model:'qwen3.5:4b',status:{state:'ready',context:16384},call:async(_endpoint:string,body:any)=>{
  const system=body.messages[0].content as string;
  const sample=/Known planner records [^\n]+?: (\[.*\])\.\n/.exec(system);
  assert.ok(sample);
  const records=JSON.parse(sample[1]);
  assert.ok(records.some((record:{id:string})=>record.id==='needle'));
  assert.ok(records.length<=8);
  assert.equal(body.think,false);
  assert.equal(body.options.temperature,0.2);
  assert.equal(body.options.num_predict,2048);
  return {message:{content:'Renew passport is in your planner.'}};
 }};
 try{
  const assistant=new PlannerAssistant(db,runtime as any,()=>{});
  await assistant.chat({text:'What is the status of Renew passport?',requestId:'query-passport'});
  assert.equal(db.revision,1);
 }finally{db.close();}
});

test('explicit recording authorizes factual activities beside a negative task clause, while questions and negation remain read-only',()=>{
 assert.ok(authorizedActions('Record both as separate actual Sleep activities. Do not add tasks or planned sessions.').has('create'));
 for(const text of ['Do not record actual Sleep activities','What if I record actual Sleep activities?','Should I record actual Sleep activities?','Imagine I record actual Sleep activities','"Record actual Sleep activities"'])assert.equal(authorizedActions(text).has('create'),false,text);
});
test('independent session requests expose the expressive change tool and produce one unapplied linked proposal',async()=>{
 const db=new PlannerDatabase(':memory:');let calls=0;const tool=(name:string,args:unknown)=>({message:{tool_calls:[{function:{name,arguments:args}}]}});
 const runtime:any={model:'fixture',modelOptions:{num_ctx:65536,num_gpu:3},status:{state:'ready',context:16384},call:async(_path:string,body:any)=>{assert.equal(body.options.num_ctx,16384);assert.equal(body.options.num_gpu,3);assert.ok(body.tools.some((t:any)=>t.function.name==='stage_changes'));assert.equal(body.tools.some((t:any)=>t.function.name==='stage_tasks'),false);return calls++===0?tool('stage_changes',{changes:[{action:'create',entity:'task',id:'work',title:'Work'},{action:'create',entity:'event',title:'Named session',notes:'Independent',linkedTaskId:'work',startDate:'2026-11-07',startTime:'10:00',endTime:'11:00'}]}):tool('preview_changes',{});}};
 try{const assistant=new PlannerAssistant(db,runtime,()=>{});await assistant.chat({text:'Create a Work task and one planned session named Named session on 2026-11-07 from 10:00 to 11:00, linked to Work, with independent notes.',requestId:'mixed'});const d=assistant.getDraft()!;assert.equal(d.projectedSnapshot.events[0].title,'Named session');assert.equal(d.projectedSnapshot.events[0].notes,'Independent');assert.equal(d.projectedSnapshot.events[0].linkedTaskId,d.projectedSnapshot.tasks[0].id);assert.equal(db.revision,0);assert.equal(db.snapshot().events.length,0);}finally{db.close();}
});

test('actual sessions resolve a newly proposed category title and a renamed saved alias without early writes',()=>{
 const db=new PlannerDatabase(':memory:');try{
  const assistant=new PlannerAssistant(db,{} as any,()=>{}),turn=assistant.drafts.begin('sleep');
  assistant.drafts.stage(turn,[{action:'create',entity:'category',fields:{title:'Sleep'}},...['2026-11-03','2026-11-04'].map(startDate=>({action:'create' as const,entity:'event' as const,fields:{title:'Sleep',kind:'actual',categoryId:'Sleep',startDate,startTime:'23:00',endDate:startDate==='2026-11-03'?'2026-11-04':'2026-11-05',endTime:'06:00'}}))]);assistant.drafts.end(turn);
  const d=assistant.getDraft()!;assert.equal(d.projectedSnapshot.categories.length,1);assert.equal(d.projectedSnapshot.events.length,2);assert.ok(d.projectedSnapshot.events.every(e=>e.categoryId===d.projectedSnapshot.categories[0].id));assert.equal(db.revision,0);assert.equal(db.snapshot().categories.length,0);
  assistant.applyDraft({draftId:d.id,version:d.version,expectedRevision:d.baseRevision,requestId:'apply-category'});const id=db.snapshot().categories[0].id;db.mutate({changes:[{action:'update',entity:'category',id,fields:{title:'Rest'}}],label:'Rename',expectedRevision:db.revision,requestId:'rename'});
  const next=assistant.drafts.begin('another-night');assistant.drafts.stage(next,[{action:'create',entity:'event',fields:{title:'Sleep',kind:'actual',categoryId:'sleep',startDate:'2026-11-05',endDate:'2026-11-06',startTime:'23:00',endTime:'06:00'}}]);assistant.drafts.end(next);assert.equal(assistant.getDraft()!.projectedSnapshot.events.at(-1)!.categoryId,id);assert.equal(db.snapshot().events.length,2);
  const bad=assistant.drafts.begin('unknown');assert.throws(()=>assistant.drafts.stage(bad,[{action:'create',entity:'event',fields:{title:'Unknown',categoryId:'made-up-id',startDate:'2026-11-06'}}]),/category/i);assistant.drafts.end(bad);
  assert.throws(()=>categorizeChanges({...db.snapshot(),categories:[...db.snapshot().categories,{id:'ambiguous',title:'Other',color:'sky',aliases:['sleep']}]},[{action:'create',entity:'event',fields:{title:'Sleep',categoryId:'sleep',startDate:'2026-11-06'}}]),/Several categories/);
 }finally{db.close();}
});
