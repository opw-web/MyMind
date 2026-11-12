import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';
import {endOfWeek,todayIn} from '../src/shared/dates';
const require=createRequire(import.meta.url),fixture=require('./reasoning-conversation-fixture.cjs');
const repairDeadline=endOfWeek(todayIn());
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const answer=(content:string)=>({message:{role:'assistant',content}});
function setup(responses:any[]){const db=new PlannerDatabase(':memory:'),calls:any[]=[];const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{calls.push(structuredClone(body));return responses.shift()??answer('Done.');}} as unknown as OllamaRuntime;return {db,calls,assistant:new PlannerAssistant(db,runtime,()=>{})};}
const task=(key:string,title:string,prerequisiteKeys:string[]=[],steps:string[]=[])=>({key,title,sourceFragments:['profile'],dateEvidence:null,dueDate:null,sessions:[],calendarEvidence:null,steps,prerequisiteKeys,categoryTitle:'Career'});

test('native task tool records forward prerequisite keys and stable checklist IDs',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[task('output','Update profile',['prep']),task('prep','Prepare career profile',[],['List achievements'])]}),tool('preview_changes',{}),answer('I added the profile preparation and its dependent update.')]);
 try{const result=await chatAndApply(s.assistant,{text:'Add preparation of my career profile and updating my profile after it. Give steps only for preparing the career profile.',requestId:'native'});assert.ok(result.receipt);const state=s.db.snapshot(),prep=state.tasks.find(t=>t.title==='Prepare career profile')!,output=state.tasks.find(t=>t.title==='Update profile')!;assert.deepEqual(output.dependsOnIds,[prep.id]);assert.ok(prep.steps[0].id);assert.equal(s.calls[0].think,true);assert.ok(s.calls[0].tools.some((t:any)=>t.function.name==='stage_tasks'));assert.equal(s.calls[0].format,undefined);assert.equal(s.db.revision,1);}finally{s.db.close();}
});

test('pasted questions followed by corrections authorize updating the existing repair title and deadline',async()=>{
 const s=setup([tool('stage_changes',{changes:[{action:'update',entity:'task',id:'repair',title:'Arrange dishwasher repair at Maple Appliance Repair',notes:'Have the dishwasher inspected.',dueDate:repairDeadline}]}),tool('preview_changes',{}),answer('The dishwasher repair at Maple Appliance Repair is due Sunday.')]);
 try{s.db.mutate({changes:[{action:'create',entity:'task',id:'repair',fields:{title:'Arrange appliance repair'}},{action:'create',entity:'task',id:'portfolio',fields:{title:'Update portfolio'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const result=await chatAndApply(s.assistant,{text:fixture.repairCorrection,requestId:'correction'});assert.ok(result.receipt);const state=s.db.snapshot();assert.equal(state.tasks.length,2);assert.equal(state.tasks.find(t=>t.id==='repair')!.title,'Arrange dishwasher repair at Maple Appliance Repair');assert.equal(state.tasks.find(t=>t.id==='repair')!.dueDate,repairDeadline);assert.equal(state.tasks.find(t=>t.id==='repair')!.scheduledDate,null);}finally{s.db.close();}
});

test('a contextual correction may finish without rewriting an already-correct record',async()=>{
 const s=setup([tool('stage_changes',{changes:[{action:'update',entity:'task',id:'repair',title:'Arrange dishwasher repair at Maple Appliance Repair',dueDate:repairDeadline}]}),tool('preview_changes',{}),answer('Updated the repair task.'),answer(JSON.stringify({isReply:true,updates:[],newTasks:[],unresolved:[]}))]);
 try{s.db.mutate({changes:[{action:'create',entity:'task',id:'repair',fields:{title:'Arrange appliance repair'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});assert.ok((await chatAndApply(s.assistant,{text:fixture.repairCorrection,requestId:'correction'})).receipt);const before=s.db.snapshot();const result=await chatAndApply(s.assistant,{text:fixture.clarification,requestId:'clarification'});assert.deepEqual(s.db.snapshot(),before);assert.equal(result.receipt,undefined);assert.match(result.content,/already.*Maple Appliance Repair/);}finally{s.db.close();}
});

test('model repairs reuse draft task keys rather than creating duplicate tasks',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[task('prep','Prepare profile')]}),tool('stage_tasks',{tasks:[{...task('prep','Prepare career profile'),steps:['List achievements']}]}),tool('preview_changes',{}),answer('Added your preparation task.')]);
 try{const result=await chatAndApply(s.assistant,{text:'Add my profile preparation to my tasks.',requestId:'repair'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,1);assert.equal(s.db.snapshot().tasks[0].title,'Prepare career profile');assert.equal(s.db.snapshot().tasks[0].steps.length,0);}finally{s.db.close();}
});

test('unknown prerequisite keys block saving until the model repairs the draft',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[task('output','Update profile',['missing'])]}),tool('preview_changes',{}),tool('stage_tasks',{tasks:[task('output','Update profile',['prep']),task('prep','Prepare career profile')]}),tool('preview_changes',{}),answer('Saved both tasks and their dependency.')]);
 try{const result=await chatAndApply(s.assistant,{text:'Add preparing and then updating my profile to my tasks.',requestId:'repair'});assert.ok(result.receipt);assert.equal(s.db.revision,1);assert.equal(s.db.snapshot().tasks.length,2);assert.ok(s.calls.some(c=>c.messages.some((m:any)=>m.role==='tool'&&m.content.includes('Unknown prerequisite key'))));}finally{s.db.close();}
});

test('unrequested calendar placement is rejected rather than copied from a deadline',async()=>{
 const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Research printers',dueDate:'2026-10-12',scheduledDate:'2026-10-12'}]}),tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Research printers',dueDate:'2026-10-12'}]}),tool('preview_changes',{}),answer('Added printer research due today.')]);
 try{const result=await chatAndApply(s.assistant,{text:'I need to research printers. Put that down for today.',requestId:'calendar'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,1);assert.equal(s.db.snapshot().tasks[0].scheduledDate,null);}finally{s.db.close();}
});

test('a deadline without supporting wording inside its task source cannot save',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[{...task('read','Read my profile'),sourceFragments:['Read my profile'],dateEvidence:'today',dueDate:'2026-10-12'}]}),tool('preview_changes',{}),tool('finish_request',{outcome:'clarification',message:'Which task did you mean to date?'})]);
 try{const result=await chatAndApply(s.assistant,{text:'Read my profile. I need to collect my parcel today.',requestId:'date-evidence'});assert.equal(s.db.revision,0);assert.equal(result.receipt,undefined);assert.ok(s.calls.some(c=>c.messages.some((m:any)=>m.role==='tool'&&m.content.includes('outside its supporting source'))));}finally{s.db.close();}
});

test('invented transcript evidence is rejected before a draft can save',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[{...task('read','Read my profile'),sourceFragments:['Read my profile today'],dateEvidence:'today',dueDate:'2026-10-12'}]}),tool('finish_request',{outcome:'clarification',message:'What deadline should I use?'})]);
 try{await chatAndApply(s.assistant,{text:'I need to read my profile.',requestId:'source-evidence'});assert.equal(s.db.revision,0);assert.ok(s.calls.some(c=>c.messages.some((m:any)=>m.role==='tool'&&m.content.includes('actual user request verbatim'))));}finally{s.db.close();}
});

test('a long workload previews all clear work while required questions block Apply',async()=>{
 const text='I need to review my profile. '+ 'These are background notes about my work. '.repeat(22);
 const s=setup([answer(JSON.stringify({tasks:[{key:'review',title:'Review my profile',source:'review my profile',dueDate:null,sessions:[],dependsOnKeys:[],notes:'',steps:['List achievements']}],unresolved:[{taskKey:'review',field:'title',source:'review my profile',question:'Which profile did you mean?'}]}))]);
 try{const result=await chatAndApply(s.assistant,{text,requestId:'extract'});assert.ok(result.preview);assert.equal(result.receipt,undefined);assert.equal(s.db.revision,0);assert.equal(s.db.snapshot().tasks.length,0);assert.equal(result.preview.draft.projectedSnapshot.tasks.length,1);assert.throws(()=>s.assistant.applyDraft({draftId:result.preview!.draft.id,version:result.preview!.draft.version,expectedRevision:0,requestId:'blocked'}),/questions/);assert.equal(s.calls[0].tools,undefined);assert.ok(s.calls[0].format);assert.equal(s.calls[0].messages.at(-1).content,text.trim());assert.match(result.content,/Proposed 1 tasks/);assert.match(result.content,/Which profile/);assert.equal(result.preview!.draft.projectedSnapshot.tasks[0].dueDate,null);}finally{s.db.close();}
});

test('a short clarification after saving updates the same task, and New chat clears it',async()=>{
 const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',id:'car',title:'Take car for servicing'}]}),tool('preview_changes',{}),tool('finish_request',{outcome:'clarification',message:'What deadline should the car service task have?',targetIds:['car']}),answer(JSON.stringify({isReply:true,updates:[{id:'car',title:'Take car for servicing',notes:'',dueDate:'2026-10-18'}],newTasks:[],unresolved:[]}))]);
 try{const first=await chatAndApply(s.assistant,{text:'Add taking the car for servicing, but I am not sure about its deadline.',requestId:'save-question'});assert.ok(first.preview);assert.equal(first.receipt,undefined);const corrected=await chatAndApply(s.assistant,{text:'coming Sunday',requestId:'short-answer'});assert.ok(corrected.receipt);assert.equal(s.db.snapshot().tasks.length,1);assert.equal(s.db.snapshot().tasks[0].id,'car');assert.equal(s.db.snapshot().tasks[0].dueDate,'2026-10-18');await s.assistant.reset();const revision=s.db.revision;await chatAndApply(s.assistant,{text:'Sunday',requestId:'after-reset'});assert.equal(s.db.revision,revision);}finally{s.db.close();}
});

test('rich existing checklists fit correction context and need retrieval before replacement',async()=>{
 const records=Array.from({length:18},(_,i)=>({action:'create' as const,entity:'task' as const,id:`task-${i}`,fields:{title:`Research project ${i}`,notes:'Research background. '.repeat(40),steps:Array.from({length:8},(_,j)=>({id:`step-${i}-${j}`,title:`Research detail ${j} `+'supporting information '.repeat(3),completed:false}))}}));
 const s=setup([tool('stage_changes',{changes:[{action:'update',entity:'task',id:'task-0',steps:[{title:'Replacement'}]}]}),tool('find_items',{entity:'task',query:'Research project 0'}),tool('stage_changes',{changes:[{action:'update',entity:'task',id:'task-0',steps:[...records[0].fields.steps,{title:'Review conclusions'}]}]}),tool('preview_changes',{}),answer('Added the review step.')]);
 try{s.db.mutate({changes:records,label:'Rich fixture',expectedRevision:0,requestId:'rich'});assert.deepEqual(s.assistant.checkInput({text:'Add a step to Research project 0: Review conclusions.'}),{fits:true});const result=await chatAndApply(s.assistant,{text:'Add a step to Research project 0: Review conclusions.',requestId:'step-add'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks[0].steps.length,9);assert.equal(s.db.snapshot().tasks[0].steps[0].id,'step-0-0');assert.ok(s.calls.some(c=>c.messages.some((m:any)=>m.role==='tool'&&m.content.includes('before replacing its checklist'))));}finally{s.db.close();}
});
test('a complete correction updates meaning and deadline while preserving task structure and calendar placement',async()=>{
 const s=setup([tool('find_items',{entity:'task',query:'repair'}),answer('The repair task is saved.'),answer(JSON.stringify({isReply:false,updates:[{id:'repair',title:'Arrange appliance repair',notes:'Visit Maple Appliance Repair on Sunday.',dueDate:repairDeadline},{id:'uneditable',title:'Update portfolio',notes:'Dictation correction.',dueDate:null}],newTasks:[],unresolved:[]})),answer(JSON.stringify({isReply:true,updates:[{id:'repair',title:'Arrange dishwasher repair at Maple Appliance Repair',notes:'Have the dishwasher inspected.',dueDate:repairDeadline}],newTasks:[],unresolved:[]}))]);
 try{s.db.mutate({changes:[{action:'create',entity:'task',id:'prep',fields:{title:'Find appliance warranty'}},{action:'create',entity:'task',id:'repair',fields:{title:'Arrange appliance repair',notes:'Destination and deadline unconfirmed.',scheduledDate:'2026-10-14',dependsOnIds:['prep'],steps:[{id:'documents',title:'Bring warranty',completed:true}]}}],label:'Fixture',expectedRevision:0,requestId:'correction-fixture'});await chatAndApply(s.assistant,{text:'Show my appliance repair task',requestId:'lookup'});const result=await chatAndApply(s.assistant,{text:fixture.repairCorrection,requestId:'complete-correction'});assert.ok(result.receipt);const repair=s.db.snapshot().tasks.find(t=>t.id==='repair')!;assert.equal(repair.title,'Arrange dishwasher repair at Maple Appliance Repair');assert.equal(repair.notes,'Have the dishwasher inspected.');assert.equal(repair.dueDate,repairDeadline);assert.equal(repair.scheduledDate,'2026-10-14');assert.equal(s.db.snapshot().events.find(e=>e.linkedTaskId==='repair')!.startDate,'2026-10-14');assert.deepEqual(repair.dependsOnIds,['prep']);assert.deepEqual(repair.steps,[{id:'documents',title:'Bring warranty',completed:true}]);assert.equal(s.db.snapshot().tasks.length,2);assert.ok(s.calls.at(-1).format);assert.match(result.content,/Maple Appliance Repair/);}finally{s.db.close();}
});


test('assistant drops unsolicited steps from native creates and preserves checklists on unrelated edits',async()=>{
 const s=setup([tool('stage_tasks',{tasks:[task('research','Research profile',[],['Invented step'])]}),tool('preview_changes',{}),answer('Saved.'),tool('stage_changes',{changes:[{action:'update',entity:'task',id:'existing',notes:'Updated notes',steps:[]}]}),tool('preview_changes',{}),answer('Updated.')]);
 try{
  s.db.mutate({changes:[{action:'create',entity:'task',id:'existing',fields:{title:'Existing task',steps:[{id:'manual',title:'Manual step',completed:false}]}}],label:'Fixture',expectedRevision:0,requestId:'existing'});
  await chatAndApply(s.assistant,{text:'Add research profile to my tasks.',requestId:'no-steps'});assert.deepEqual(s.db.snapshot().tasks.find(t=>t.title==='Research profile')!.steps,[]);
  await chatAndApply(s.assistant,{text:'Update the notes on Existing task to Updated notes.',requestId:'notes'});assert.equal(s.db.snapshot().tasks.find(t=>t.id==='existing')!.steps[0].id,'manual');
 }finally{s.db.close();}
});

test('legacy standalone completion requests preserve the activity without completion semantics',async()=>{
 const s=setup([]);try{
  s.db.mutate({changes:[{action:'create',entity:'event',id:'meeting',fields:{title:'Team meeting',startDate:'2026-10-13'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});
  const result=await chatAndApply(s.assistant,{text:'Mark Team meeting complete.',requestId:'event-done'});assert.equal(s.db.snapshot().events[0].completed,false);
  await chatAndApply(s.assistant,{text:'Reopen Team meeting.',requestId:'event-reopen'});assert.equal(s.db.snapshot().events[0].completed,false);assert.equal(s.db.snapshot().events.length,1);
 }finally{s.db.close();}
});
