import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlannerDatabase} from '../src/main/database';
import {deadlineLabel,endOfWeek,todayIn} from '../src/shared/dates';
import type {Change} from '../src/shared/model';
import {groundExplicitTaskDeadlines,simpleCreation,simpleCreate} from '../src/main/simple-request';

test('an explicit deadline adjacent to a new task survives omitted model fields without moving its session',()=>{
  const task:Change={action:'create',entity:'task',id:'proposal',fields:{title:'Prepare proposal'}};
  const session:Change={action:'create',entity:'event',fields:{title:'Draft session',linkedTaskId:'proposal',startDate:'2026-11-07'}};
  groundExplicitTaskDeadlines('Create a task called Prepare proposal due 2026-11-10. Also create Draft session on 2026-11-07.',[task,session]);
  assert.equal(task.fields?.dueDate,'2026-11-10');
  assert.equal(session.fields?.startDate,'2026-11-07');
  groundExplicitTaskDeadlines('Create a task called Prepare proposal due 2026-11-11, actually I changed my mind.',[task]);
  assert.equal(task.fields?.dueDate,'2026-11-10');
});
import {authorizedActions} from '../src/main/capabilities';
import {PlannerAssistant} from '../src/main/assistant';
test('Deadline and legacy placement are independent and undoable',()=>{
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:[{action:'create',entity:'task',id:'task',fields:{title:'Finish report',dueDate:'2026-10-18'}}],label:'Deadline',expectedRevision:0,requestId:'one'});
    assert.equal(db.snapshot().tasks[0].scheduledDate,null);
    db.mutate({changes:[{action:'update',entity:'task',id:'task',fields:{scheduledDate:'2026-10-16'}}],label:'Schedule',expectedRevision:1,requestId:'two'});
    assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-18');assert.equal(db.snapshot().events[0].startDate,'2026-10-16');db.undo();assert.equal(db.snapshot().tasks[0].scheduledDate,null);assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-18');
  }finally{db.close();}
});
test('deadline labels and end-of-week dates follow calendar days and timezone midnight',()=>{
  assert.equal(endOfWeek('2026-10-16'),'2026-10-18');assert.equal(endOfWeek('2026-10-18'),'2026-10-18');
  assert.match(deadlineLabel('2027-01-01','2026-12-31'),/1 day left/);
  assert.match(deadlineLabel('2026-10-18','2026-10-18'),/Due today/);
  assert.match(deadlineLabel('2026-10-18','2026-10-20'),/Overdue by 2 days/);
  assert.doesNotMatch(deadlineLabel('2026-10-18','2026-10-20',true),/Overdue/);
  assert.equal(todayIn('Asia/Kolkata',new Date('2026-10-17T18:30:00Z')),'2026-10-18');
  const due=simpleCreate('Add a task Finish report by the end of this week','2026-10-16');assert.equal(due?.fields?.dueDate,'2026-10-18');assert.equal('scheduledDate' in due!.fields!,false);
  const scheduled=simpleCreation('Schedule a task Finish report tomorrow','2026-10-16');assert.ok(scheduled&&'change' in scheduled);assert.equal(scheduled.sessions?.[0].startDate,'2026-10-17');assert.equal(scheduled.change.fields?.dueDate,null);
});
test('v2 migration preserves calendar placements and old Undo states with a safe backup',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'mymind-v3-')),'planner.sqlite');
  let db=new PlannerDatabase(path);db.mutate({changes:[{action:'create',entity:'task',id:'old',fields:{title:'Original',dueDate:'2026-10-18'}}],label:'Original',expectedRevision:0,requestId:'old'});
  db.mutate({changes:[{action:'update',entity:'task',id:'old',fields:{notes:'Updated'}}],label:'Edit',expectedRevision:1,requestId:'edit'});db.close();
  const old=new DatabaseSync(path),task=JSON.parse(old.prepare('SELECT body FROM tasks').get()!.body as string);delete task.scheduledDate;old.prepare('UPDATE tasks SET body=?').run(JSON.stringify(task));
  for(const row of old.prepare('SELECT id,before_state FROM history').all()){const state=JSON.parse(row.before_state as string);state.tasks.forEach((t:any)=>delete t.scheduledDate);old.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);}old.exec('PRAGMA user_version=2');old.close();
  db=new PlannerDatabase(path);try{assert.ok(existsSync(path+'.v2-backup'));assert.equal(db.snapshot().tasks[0].scheduledDate,'2026-10-18');assert.equal(db.revision,2);db.undo();assert.equal(db.snapshot().tasks[0].notes,'');assert.equal(db.snapshot().tasks[0].scheduledDate,'2026-10-18');assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-18');}finally{db.close();}
});
test('new task goal verbs stay creation-only and hypothetical scheduling remains read-only',async()=>{
  assert.deepEqual([...authorizedActions('Add tasks to research abroad programs and update my LinkedIn profile, both due this week.')],['create']);
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:[{action:'create',entity:'task',id:'report',fields:{title:'Report'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});
    let writable=false;const runtime:any={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{writable=body.tools.some((t:any)=>t.function.name==='stage_changes');return {message:{content:'You can set a calendar date in the editor.'}};}};
    const assistant=new PlannerAssistant(db,runtime,()=>{});
    await chatAndApply(assistant,{text:'How would I schedule Report?',selection:{entity:'task',id:'report',revision:1},requestId:'read-only'});
    assert.equal(writable,false);assert.equal(db.revision,1);
  }finally{db.close();}
});
test('removing a known task from the calendar retains its deadline and task identity',async()=>{
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:[{action:'create',entity:'task',id:'report',fields:{title:'Report',dueDate:'2026-10-16',scheduledDate:'2026-10-16'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});
    const runtime:any={model:'test',status:{state:'ready',context:8192},call:async()=>{throw new Error('No model needed for a verified calendar unlink.');}};
    const assistant=new PlannerAssistant(db,runtime,()=>{}),result=await chatAndApply(assistant,{text:'Remove Report from my calendar',requestId:'unlink'});
    assert.ok(result.receipt);assert.equal(db.snapshot().tasks.length,1);assert.equal(db.snapshot().tasks[0].id,'report');assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-16');assert.equal(db.snapshot().events.length,0);db.undo();assert.equal(db.snapshot().events[0].startDate,'2026-10-16');
  }finally{db.close();}
});
