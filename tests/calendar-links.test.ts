import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {PlannerDatabase} from '../src/main/database';
import {prepareDraft} from '../src/main/draft';
import {PlannerAssistant} from '../src/main/assistant';
import {applyCalendarIntent} from '../src/main/calendar-intent';
import {validateWorkload} from '../src/main/workload';
import {Change} from '../src/shared/model';
const exact=createRequire(import.meta.url)('./calendar-linked-fixture.cjs') as string;
const definitions=[
 ['Finalize workshop supply budget','Today, I need to finalize the workshop supply budget','2026-10-13','today'],
 ['Choose a compact laser cutter','research and choose a compact laser cutter today','2026-10-13','today'],
 ['Schedule an appliance repair','On Thursday, I need to schedule an appliance repair','2026-10-15','on thursday'],
 ['Check for evening workshop classes','check whether the community workshop has evening classes',null,null],
 ['Renew library card','renew my library card',null,null],
 ['Review spring class offerings','review spring class offerings',null,null],
 ['Find a local framing shop','find a local framing shop',null,null],
 ['Finish cardboard model','finish my cardboard model today','2026-10-13','today'],
 ['Start display stand','tomorrow I need to start the display stand','2026-10-14','tomorrow']
];
const draft=()=>definitions.map(([title,source,dueDate,dateEvidence],i)=>({key:`t${i}`,title:title!,sourceFragments:[source!],dueDate,dateEvidence,steps:[],prerequisiteKeys:[],categoryTitle:'Tasks'}));
function save(db:PlannerDatabase,changes:Change[]){return db.mutate({changes,label:'Test',expectedRevision:db.revision,requestId:crypto.randomUUID()});}
const create=(db:PlannerDatabase)=>save(db,[{action:'create',entity:'task',id:'task',fields:{title:'Prototype',notes:'Notes',dueDate:'2026-10-13',scheduledDate:'2026-10-13'}}]);

test('grouped calendar instructions cover five tasks and exclude the four task-only items',()=>{
 const tasks=draft().map(t=>({...t,sessions:[] as {startDate:string}[]}));applyCalendarIntent(exact,tasks);
 assert.deepEqual(tasks.map(t=>t.sessions[0]?.startDate??null),['2026-10-13','2026-10-13','2026-10-15',null,null,null,null,'2026-10-13','2026-10-14']);
});
test('the exact prompt repairs missing calendar placements before one atomic save',async()=>{
 const db=new PlannerDatabase(':memory:');const runtime:any={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>body.format?{message:{content:JSON.stringify({tasks:definitions.map(([title,source,dueDate],i)=>({key:`t${i}`,title,source,notes:'',dueDate,sessions:[],steps:[],dependsOnKeys:[]})),unresolved:[]})}}:{message:{content:'Calendar dates and deadlines are independent.'}}};
 try{const assistant=new PlannerAssistant(db,runtime,()=>{});const reply=await chatAndApply(assistant,{text:exact,requestId:'exact'}),state=db.snapshot();assert.ok(reply.receipt);assert.equal(state.revision,1);assert.equal(state.tasks.length,9);assert.equal(state.events.length,5);assert.equal(new Set(state.events.map(e=>e.linkedTaskId)).size,5);assert.ok(state.tasks.every(t=>!t.completed));assert.ok(state.events.every(e=>e.startTime===null&&e.endTime===null&&e.startDate===e.endDate));
 // Recreate the reported omission without changing the assistant context.
 const repaired=await chatAndApply(assistant,{text:'i dont see them on the calendar',requestId:'repair'});assert.equal(repaired.receipt,undefined);assert.equal(db.snapshot().events.length,5);assert.equal(db.snapshot().tasks.length,9);
 const before=db.revision;await chatAndApply(assistant,{text:'Why do calendar dates differ from deadlines?',requestId:'question'});assert.equal(db.revision,before);
 }finally{db.close();}
});
test('legacy scheduling creates one independent session; later edits and deletion preserve both identities',()=>{
 const db=new PlannerDatabase(':memory:');try{create(db);const event=db.snapshot().events[0];
 save(db,[{action:'update',entity:'task',id:'task',fields:{title:'New prototype',notes:'Revised',scheduledDate:'2026-10-14'}}]);
 assert.equal(db.snapshot().events[0].title,'Prototype');assert.equal(db.snapshot().events[0].notes,'Notes');assert.equal(db.snapshot().events[0].startDate,'2026-10-13');
 save(db,[{action:'update',entity:'event',id:event.id,fields:{title:'Renamed session',startDate:'2026-10-15',endDate:'2026-10-16'}}]);assert.equal(db.snapshot().tasks[0].title,'New prototype');assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-13');
 save(db,[{action:'delete',entity:'event',id:event.id}]);assert.equal(db.snapshot().tasks.length,1);db.undo();
 save(db,[{action:'delete',entity:'task',id:'task'}]);assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].linkedTaskId,null);db.undo();assert.equal(db.snapshot().events[0].linkedTaskId,'task');
 save(db,[{action:'update',entity:'task',id:'task',fields:{scheduledDate:null}}]);assert.equal(db.snapshot().events.length,1);
 }finally{db.close();}
});
test('multiple links and independent paired edits are valid; dangling references roll back',()=>{
 const db=new PlannerDatabase(':memory:');try{create(db);const event=db.snapshot().events[0];
 save(db,[{action:'create',entity:'event',fields:{title:'Second session',startDate:'2026-10-14',linkedTaskId:'task'}},{action:'update',entity:'task',id:'task',fields:{title:'Task title'}},{action:'update',entity:'event',id:event.id,fields:{title:'Session title'}}]);
 const before=db.snapshot();assert.equal(before.events.length,2);assert.throws(()=>save(db,[{action:'create',entity:'event',fields:{title:'Missing task',startDate:'2026-10-13',linkedTaskId:'missing'}}]));assert.deepEqual(db.snapshot(),before);
 const preview=db.preview([{action:'update',entity:'task',id:'task',fields:{title:'Preview'}}],db.revision);assert.deepEqual(db.snapshot(),before);save(db,preview.changes);assert.equal(db.snapshot().events[0].title,'Session title');
 }finally{db.close();}
});
test('v4 migration backs up committed WAL data, normalizes historical events and survives restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mymind-links-')),path=join(dir,'planner.sqlite');let db=new PlannerDatabase(path);
 try{save(db,[{action:'create',entity:'event',fields:{title:'Appointment',startDate:'2026-10-13'}}]);save(db,[{action:'create',entity:'task',fields:{title:'Deadline only',dueDate:'2026-10-14'}}]);db.close();
 const old=new DatabaseSync(path);for(const row of old.prepare('SELECT id,body FROM events').all()){const event=JSON.parse(row.body as string);delete event.linkedTaskId;old.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event),row.id as string);}old.exec('PRAGMA user_version=4');old.close();
 db=new PlannerDatabase(path);assert.ok(existsSync(path+'.v4-backup'));assert.equal(db.snapshot().events[0].linkedTaskId,null);db.undo();assert.equal(db.snapshot().events[0].linkedTaskId,null);create(db);const saved=db.snapshot();db.close();db=new PlannerDatabase(path);assert.deepEqual(db.snapshot(),saved);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('resolved grouped calendar dates do not leave stale clarification questions',()=>{
 const value={tasks:definitions.map(([title,source,dueDate],i)=>({key:`t${i}`,title,source,notes:'',dueDate,sessions:[],steps:[],dependsOnKeys:[]})),unresolved:[{taskKey:'t2',field:'sessions',source:'add these 3 on the calendar as well',question:'What date?'},{taskKey:'t8',field:'sessions',source:'add these 2 on my calendar',question:'What date?'}]};
 const result=validateWorkload(value,exact);assert.deepEqual(result.unresolved,[]);assert.equal(result.tasks.filter(t=>t.sessions.length).length,5);
});

test('draft task repairs preserve independent session ID/content until an explicit session correction',()=>{
 const db=new PlannerDatabase(':memory:');try{const before=db.snapshot(),preview=db.preview(prepareDraft(before,[],[{action:'create',entity:'task',id:'new',fields:{title:'Prototype',scheduledDate:'2026-10-13'}}]),0);const id=preview.changes.find(c=>c.entity==='event')!.id;
 const repaired=db.preview(prepareDraft(before,preview.changes,[{action:'update',entity:'task',id:'new',fields:{title:'Revised prototype',dueDate:'2026-10-16'}}]),0);save(db,repaired.changes);assert.equal(db.snapshot().events[0].id,id);assert.equal(db.snapshot().events[0].title,'Prototype');assert.equal(db.snapshot().events[0].startDate,'2026-10-13');assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-16');
 }finally{db.close();}
});
test('categories and color overrides remain independent on linked sessions',()=>{
 const db=new PlannerDatabase(':memory:');try{create(db);const event=db.snapshot().events[0];save(db,[{action:'update',entity:'task',id:'task',fields:{categoryTitle:'Research',colorOverride:null}}]);assert.equal(db.snapshot().events[0].categoryId,event.categoryId);assert.notEqual(db.snapshot().events[0].categoryId,db.snapshot().tasks[0].categoryId);
 const taskColor=db.snapshot().tasks[0].color;save(db,[{action:'update',entity:'event',id:event.id,fields:{colorOverride:'rose',notes:'Event notes'}}]);assert.equal(db.snapshot().tasks[0].color,taskColor);assert.equal(db.snapshot().tasks[0].notes,'Notes');assert.equal(db.snapshot().events[0].color,'rose');
 }finally{db.close();}
});
