import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlannerDatabase} from '../src/main/database';
import {prepareDraft} from '../src/main/draft';
import {blockers} from '../src/shared/tasks';
import {Change} from '../src/shared/model';

const create=(id:string,fields:Record<string,unknown>={}):Change=>({action:'create',entity:'task',id,fields:{title:id,...fields}});
function save(db:PlannerDatabase,changes:Change[]){return db.mutate({changes,label:'Task structure',expectedRevision:db.revision,requestId:crypto.randomUUID()});}

test('forward and cross-project prerequisites validate the final batch, with independent soft completion',()=>{
  const db=new PlannerDatabase(':memory:');try{
    save(db,[{action:'create',entity:'project',id:'work',fields:{title:'Work'}},create('output',{dependsOnIds:['prep'],projectId:'work'}),create('prep',{steps:[{id:'s1',title:'Collect accomplishments',completed:false}]})]);
    let state=db.snapshot();assert.equal(blockers(state.tasks[0],state.tasks)[0].id,'prep');
    save(db,[{action:'update',entity:'task',id:'output',fields:{completed:true}}]);assert.equal(db.snapshot().tasks[0].completed,true);
    save(db,[{action:'update',entity:'task',id:'prep',fields:{steps:[{id:'s1',title:'Collect accomplishments',completed:true}]}}]);assert.equal(db.snapshot().tasks[1].completed,false);
    save(db,[{action:'update',entity:'task',id:'prep',fields:{completed:true}}]);state=db.snapshot();assert.equal(blockers(state.tasks[0],state.tasks).length,0);
    save(db,[{action:'update',entity:'task',id:'prep',fields:{completed:false}}]);state=db.snapshot();assert.equal(blockers(state.tasks[0],state.tasks).length,1);assert.equal(state.tasks[0].completed,true);
  }finally{db.close();}
});

test('invalid prerequisite graphs roll back both previews and mutations',()=>{
  const db=new PlannerDatabase(':memory:');try{
    for(const changes of [[create('a',{dependsOnIds:['a']})],[create('a',{dependsOnIds:['missing']})],[create('a',{dependsOnIds:['b']}),create('b',{dependsOnIds:['a']})]]){
      assert.throws(()=>db.preview(changes,0),/itself|cycle|no longer exists/);assert.equal(db.snapshot().tasks.length,0);
      assert.throws(()=>save(db,changes),/itself|cycle|no longer exists/);assert.equal(db.revision,0);
    }
    save(db,[create('a'),create('b',{dependsOnIds:['a']})]);
    assert.throws(()=>save(db,[{action:'update',entity:'task',id:'a',fields:{dependsOnIds:['b']}}]),/cycle/);assert.equal(db.revision,1);
  }finally{db.close();}
});

test('deleting a prerequisite removes links and Undo restores exact graph and steps',()=>{
  const db=new PlannerDatabase(':memory:');try{
    save(db,[create('a',{steps:[{id:'step',title:'Prepare',completed:true}]}),create('b',{dependsOnIds:['a']})]);const before=db.snapshot().tasks;
    const result=save(db,[{action:'delete',entity:'task',id:'a'}]);assert.ok(result.descriptions.some(d=>/removed prerequisite/.test(d)));assert.deepEqual(db.snapshot().tasks[0].dependsOnIds,[]);
    db.undo();assert.deepEqual(db.snapshot().tasks,before);
  }finally{db.close();}
});

test('step IDs remain stable through edits, reordering, restart and Undo',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'mymind-steps-')),'planner.sqlite');let db=new PlannerDatabase(path);
  const steps=[{id:'one',title:'First',completed:false},{id:'two',title:'Second',completed:false}];save(db,[create('a',{steps})]);
  save(db,[{action:'update',entity:'task',id:'a',fields:{steps:[{...steps[1],title:'Edited second',completed:true},steps[0]]}}]);db.close();
  db=new PlannerDatabase(path);try{assert.deepEqual(db.snapshot().tasks[0].steps.map(s=>s.id),['two','one']);db.undo();assert.deepEqual(db.snapshot().tasks[0].steps,steps);
    assert.throws(()=>save(db,[{action:'update',entity:'task',id:'a',fields:{steps:[steps[0],steps[0]]}}]),/unique/);
  }finally{db.close();}
});

test('v3 migration backs up WAL data and upgrades historical Undo snapshots without changing dates',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'mymind-v4-')),'planner.sqlite');let db=new PlannerDatabase(path);
  save(db,[create('old',{dueDate:'2026-10-14',scheduledDate:'2026-10-14'})]);save(db,[{action:'update',entity:'task',id:'old',fields:{notes:'Updated'}}]);db.close();
  const legacy=new DatabaseSync(path);for(const row of legacy.prepare('SELECT id,body FROM tasks').all()){const task=JSON.parse(row.body as string);delete task.steps;delete task.dependsOnIds;legacy.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task),row.id as string);}
  for(const row of legacy.prepare('SELECT id,before_state FROM history').all()){const state=JSON.parse(row.before_state as string);state.tasks.forEach((t:any)=>{delete t.steps;delete t.dependsOnIds;});legacy.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);}legacy.exec('PRAGMA user_version=3');legacy.close();
  db=new PlannerDatabase(path);try{assert.ok(existsSync(path+'.v3-backup'));assert.equal(db.revision,2);assert.deepEqual(db.snapshot().tasks[0].steps,[]);assert.deepEqual(db.snapshot().tasks[0].dependsOnIds,[]);db.undo();const task=db.snapshot().tasks[0];assert.equal(task.notes,'');assert.equal(task.dueDate,'2026-10-14');assert.equal(task.scheduledDate,'2026-10-14');assert.deepEqual(task.steps,[]);}finally{db.close();}
});

test('draft titles and temporary IDs resolve task prerequisites and generated steps',()=>{
  const db=new PlannerDatabase(':memory:');try{
    const draft=prepareDraft(db.snapshot(),[],[create('output',{dependsOnTitles:['Career profile']}),create('prep',{title:'Career profile',steps:[{title:'Gather achievements'}]})]);
    save(db,draft);const state=db.snapshot();assert.deepEqual(state.tasks.find(t=>t.id==='output')!.dependsOnIds,['prep']);assert.ok(state.tasks.find(t=>t.id==='prep')!.steps[0].id);
  }finally{db.close();}
});

test('repeated drafts with generated step IDs deduplicate without changing stable steps',()=>{
  const db=new PlannerDatabase(':memory:');try{
    const incoming:Change[]=[{action:'create',entity:'task',fields:{title:'Research options',steps:[{title:'Compare options'}]}}];
    const first=prepareDraft(db.snapshot(),[],incoming),second=prepareDraft(db.snapshot(),first,incoming);
    assert.equal(second.filter(c=>c.entity==='task').length,1);
    assert.deepEqual(second.find(c=>c.entity==='task')!.fields!.steps,first.find(c=>c.entity==='task')!.fields!.steps);
  }finally{db.close();}
});
