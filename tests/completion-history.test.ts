import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlannerDatabase} from '../src/main/database';
import {Change} from '../src/shared/model';
import {COMPLETED_TASK_RETENTION_MS,isArchivedTask,formatTaskTimestamp} from '../src/shared/tasks';
import {requestedStepTargets,enforceRequestedSteps} from '../src/main/step-intent';
import {validateWorkload} from '../src/main/workload';

const apply=(db:PlannerDatabase,changes:Change[])=>db.mutate({changes,label:'Test',requestId:`test-${db.revision}`,expectedRevision:db.revision});
test('timestamps persist; only a completion transition starts the retention window',()=>{
  const folder=mkdtempSync(join(tmpdir(),'mymind-completion-')),file=join(folder,'planner.sqlite');
  let clock=new Date('2026-10-13T10:00:00Z'),db=new PlannerDatabase(file,()=>clock);
  try{
    apply(db,[{action:'create',entity:'task',id:'t',fields:{title:'Research'}}]);
    const created=db.snapshot().tasks[0].createdAt;
    clock=new Date('2026-10-13T11:00:00Z');apply(db,[{action:'update',entity:'task',id:'t',fields:{completed:true}}]);
    const completed=db.snapshot().tasks[0].completedAt!;
    assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()+COMPLETED_TASK_RETENTION_MS-1),false);
    assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()+COMPLETED_TASK_RETENTION_MS),true);
    clock=new Date('2026-10-14T12:00:00Z');apply(db,[{action:'update',entity:'task',id:'t',fields:{completed:true,title:'Revised research'}}]);
    assert.equal(db.snapshot().tasks[0].completedAt,completed);assert.equal(db.snapshot().tasks[0].createdAt,created);
    db.close();db=new PlannerDatabase(file,()=>clock);assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()),true);
    apply(db,[{action:'update',entity:'task',id:'t',fields:{completed:false}}]);assert.equal(db.snapshot().tasks[0].completedAt,null);
    assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()),false);
    apply(db,[{action:'update',entity:'task',id:'t',fields:{completed:true}}]);assert.equal(db.snapshot().tasks[0].completedAt,clock.toISOString());
    db.undo();assert.equal(db.snapshot().tasks[0].completedAt,null);
    assert.throws(()=>apply(db,[{action:'update',entity:'task',id:'t',fields:{createdAt:'2000-01-01T00:00:00Z'}}]));
    assert.match(formatTaskTimestamp(created,'Asia/Kolkata'),/3:30/);assert.equal(formatTaskTimestamp(null,'Asia/Kolkata'),'Unknown');
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

test('events remain visible; linked completion derives from tasks and standalone activities have none',()=>{
  let clock=new Date('2026-10-13T10:00:00Z');const db=new PlannerDatabase(':memory:',()=>clock);
  try{
    apply(db,[{action:'create',entity:'task',id:'t',fields:{title:'Research',scheduledDate:'2026-10-13'}},{action:'create',entity:'event',id:'e',fields:{title:'Meeting',startDate:'2026-10-13'}}]);
    const linked=db.snapshot().events.find(e=>e.linkedTaskId==='t')!;
    apply(db,[{action:'update',entity:'event',id:linked.id,fields:{completed:true}},{action:'update',entity:'event',id:'e',fields:{completed:true}}]);
    assert.equal(db.snapshot().tasks[0].completedAt,clock.toISOString());
    clock=new Date(clock.getTime()+COMPLETED_TASK_RETENTION_MS);assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()),true);
    assert.equal(db.snapshot().events.length,2);assert.equal(db.snapshot().events.find(e=>e.id===linked.id)!.completed,true);assert.equal(db.snapshot().events.find(e=>e.id==='e')!.completed,false);
    apply(db,[{action:'update',entity:'task',id:'t',fields:{completed:false}}]);assert.equal(db.snapshot().events.find(e=>e.id===linked.id)!.completed,false);
    apply(db,[{action:'update',entity:'event',id:linked.id,fields:{completed:true}}]);assert.equal(db.snapshot().tasks[0].completed,true);apply(db,[{action:'update',entity:'event',id:linked.id,fields:{completed:false}}]);
    assert.equal(db.snapshot().tasks[0].completed,false);
  }finally{db.close();}
});

test('reset is one undoable, idempotent transaction preserving planner organization and preferences',()=>{
  const db=new PlannerDatabase(':memory:');try{
    apply(db,[{action:'create',entity:'project',id:'p',fields:{title:'Project'}},{action:'create',entity:'section',id:'s',fields:{title:'Section',projectId:'p'}},{action:'create',entity:'task',id:'t',fields:{title:'Research',projectId:'p',sectionId:'s',scheduledDate:'2026-10-13'}},{action:'create',entity:'task',id:'output',fields:{title:'Report',dependsOnIds:['t']}}]);
    const before=db.snapshot(),receipt=db.clearTasksAndEvents('reset')!,after=db.snapshot();
    assert.equal(after.tasks.length,0);assert.equal(after.events.length,0);assert.equal(after.revision,before.revision+1);
    for(const key of ['projects','sections','categories','preferences'] as const)assert.deepEqual(after[key],before[key]);
    assert.deepEqual(db.clearTasksAndEvents('reset'),receipt);db.undo();assert.deepEqual(db.snapshot().tasks,before.tasks);assert.deepEqual(db.snapshot().events,before.events);
  }finally{db.close();}
});

test('v5 migration normalizes legacy timestamps and linked event state, including Undo history',()=>{
  const folder=mkdtempSync(join(tmpdir(),'mymind-v5-')),file=join(folder,'planner.sqlite');let db=new PlannerDatabase(file);
  try{
    apply(db,[{action:'create',entity:'task',id:'t',fields:{title:'Research',completed:true,scheduledDate:'2026-10-13'}}]);
    apply(db,[{action:'update',entity:'task',id:'t',fields:{notes:'Updated'}}]);
    for(const row of db.db.prepare('SELECT id,body FROM tasks').all()){const task=JSON.parse(String(row.body));delete task.createdAt;delete task.completedAt;db.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task),String(row.id));}
    for(const row of db.db.prepare('SELECT id,body FROM events').all()){const event=JSON.parse(String(row.body));delete event.completed;db.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event),String(row.id));}
    for(const row of db.db.prepare('SELECT id,before_state FROM history').all()){const state=JSON.parse(String(row.before_state));state.tasks.forEach((t:any)=>{delete t.createdAt;delete t.completedAt;});state.events.forEach((e:any)=>delete e.completed);db.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),Number(row.id));}
    db.db.exec('PRAGMA user_version=5');db.close();db=new PlannerDatabase(file);
    assert.equal(db.snapshot().tasks[0].createdAt,null);assert.equal(isArchivedTask(db.snapshot().tasks[0]),true);assert.equal(db.snapshot().events[0].completed,true);
    db.undo();assert.equal(db.snapshot().tasks[0].completedAt,null);assert.equal(db.snapshot().events[0].completed,true);
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});

test('steps require a positive request scoped to the intended task',()=>{
  const targets=[{title:'Research Mars'},{title:'Research Venus'}];
  assert.deepEqual([...requestedStepTargets('Add research Mars and research Venus.',targets)],[]);
  assert.deepEqual([...requestedStepTargets('Add research Mars and research Venus. Give steps only for Mars.',targets)],[0]);
  assert.deepEqual([...requestedStepTargets('Add research Mars and research Venus with steps only for Mars.',targets)],[0]);
  assert.deepEqual([...requestedStepTargets('Add research Mars and research Venus. Include steps for both tasks.',targets)],[0,1]);
  assert.deepEqual([...requestedStepTargets('Add research Mars without steps.',targets)],[]);
  assert.deepEqual([...requestedStepTargets('Add research Mars with steps and research Venus.',targets)],[0]);
  const db=new PlannerDatabase(':memory:');try{
    apply(db,[{action:'create',entity:'task',id:'old',fields:{title:'Research Mars',steps:[{id:'step',title:'Keep me',completed:true}]}}]);
    const changes:Change[]=[{action:'update',entity:'task',id:'old',fields:{notes:'Updated',steps:[]}},{action:'create',entity:'task',fields:{title:'Research Venus',steps:[{title:'Invented'}]}}];
    enforceRequestedSteps(changes,'Update Mars notes and add research Venus.',db.snapshot());assert.equal(changes[0].fields!.steps,undefined);assert.deepEqual(changes[1].fields!.steps,[]);
    const draft=validateWorkload({tasks:[{key:'mars',title:'Research Mars',source:'research Mars',notes:'',dueDate:null,sessions:[],steps:['Invented'],dependsOnKeys:[]}],unresolved:[]},'I need to research Mars.');assert.deepEqual(draft.tasks[0].steps,[]);
  }finally{db.close();}
});
