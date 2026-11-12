import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlannerDatabase} from '../src/main/database';
import {Change} from '../src/shared/model';
const save=(db:PlannerDatabase,changes:Change[])=>db.mutate({changes,label:'Date test',expectedRevision:db.revision,requestId:crypto.randomUUID()});
const dates=(db:PlannerDatabase)=>{const {tasks,events}=db.snapshot();assert.equal(tasks[0].dueDate,'2026-10-23');assert.equal(tasks[0].scheduledDate,'2026-10-19');assert.equal(events.length,1);assert.equal(events[0].startDate,'2026-10-19');};

test('deadline edits do not move sessions; clearing deadlines and deleting tasks preserve blocks',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'task',id:'outline',fields:{title:'Outline',dueDate:'2026-10-23',scheduledDate:'2026-10-19'}}]);dates(db);
 save(db,[{action:'update',entity:'task',id:'outline',fields:{dueDate:null}}]);assert.equal(db.snapshot().events[0].startDate,'2026-10-19');db.undo();dates(db);
 const event=db.snapshot().events[0];save(db,[{action:'delete',entity:'event',id:event.id}]);assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-23');db.undo();dates(db);
 save(db,[{action:'delete',entity:'task',id:'outline'}]);assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].linkedTaskId,null);db.undo();dates(db);
 }finally{db.close();}
});
test('distinct deadline and placement values are valid; standalone inclusive ranges retain duration',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'task',id:'task',fields:{title:'Task',scheduledDate:'2026-10-19',dueDate:'2026-10-23'}}]);assert.equal(db.snapshot().tasks[0].dueDate,'2026-10-23');assert.equal(db.snapshot().events[0].startDate,'2026-10-19');
 save(db,[{action:'create',entity:'event',id:'trip',fields:{title:'Trip',startDate:'2026-10-30',endDate:'2026-11-02'}}]);
 save(db,[{action:'update',entity:'event',id:'trip',fields:{startDate:'2026-11-01'}}]);assert.equal(db.snapshot().events.find(e=>e.id==='trip')!.endDate,'2026-11-04');
 }finally{db.close();}
});
test('v7 upgrade preserves independent dueDate and Calendar placement, backs up committed WAL, normalizes Undo and survives restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mymind-shared-date-')),path=join(dir,'planner.sqlite');let db=new PlannerDatabase(path);
  try{
    save(db,[{action:'create',entity:'task',id:'outline',fields:{title:'Outline',scheduledDate:'2026-10-19'}}]);save(db,[{action:'update',entity:'task',id:'outline',fields:{notes:'Saved note'}}]);db.close();
    const legacy=new DatabaseSync(path);legacy.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=7;');
    const task=JSON.parse(legacy.prepare('SELECT body FROM tasks').get()!.body as string);task.dueDate='2026-10-23';task.scheduledDate='2026-10-20';legacy.prepare('UPDATE tasks SET body=?').run(JSON.stringify(task));
    for(const row of legacy.prepare('SELECT id,before_state FROM history').all()){const state=JSON.parse(row.before_state as string);for(const t of state.tasks){t.dueDate='2026-10-23';t.scheduledDate='2026-10-20';}legacy.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);}
    db=new PlannerDatabase(path);legacy.close();dates(db);assert.equal(db.revision,2);assert.ok(existsSync(path+'.v7-backup'));
    const backup=new DatabaseSync(path+'.v7-backup');assert.equal(JSON.parse(backup.prepare('SELECT body FROM tasks').get()!.body as string).dueDate,'2026-10-23');backup.close();
    db.undo();dates(db);assert.equal(db.snapshot().tasks[0].notes,'');const saved=db.snapshot();db.close();db=new PlannerDatabase(path);assert.deepEqual(db.snapshot(),saved);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
