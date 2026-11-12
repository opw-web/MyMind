import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlannerDatabase} from '../src/main/database';
import {Change} from '../src/shared/model';
const save=(db:PlannerDatabase,changes:Change[])=>db.mutate({changes,label:'Text box test',expectedRevision:db.revision,requestId:randomUUID()});

test('text boxes are separate from Notes, validated, independent, cleared and undoable',()=>{
  const db=new PlannerDatabase(':memory:');
  try{
    save(db,[{action:'create',entity:'task',id:'task',fields:{title:'Work',notes:'Keep notes',textBox:'First\nSecond'}},{action:'create',entity:'event',id:'standalone',fields:{title:'Meeting',startDate:'2026-10-13'}}]);
    assert.equal(db.snapshot().events[0].textBox,'');
    save(db,[{action:'update',entity:'task',id:'task',fields:{scheduledDate:'2026-10-13'}}]);
    const event=db.snapshot().events.find(e=>e.linkedTaskId==='task')!;
    assert.equal(event.textBox,'First\nSecond');
    save(db,[{action:'update',entity:'event',id:event.id,fields:{textBox:'From calendar'}}]);
    assert.equal(db.snapshot().tasks[0].textBox,'First\nSecond');
    assert.equal(db.snapshot().tasks[0].notes,'Keep notes');
    save(db,[{action:'update',entity:'task',id:'task',fields:{textBox:' \n\t'}}]);
    assert.equal(db.snapshot().tasks[0].textBox,'');
    assert.equal(db.snapshot().events.find(e=>e.id===event.id)!.textBox,'From calendar');
    db.undo();assert.equal(db.snapshot().tasks[0].textBox,'First\nSecond');
    assert.equal(db.snapshot().events.find(e=>e.id===event.id)!.textBox,'From calendar');
    for(const entity of ['task','event'] as const){const id=entity==='task'?'task':'standalone';
      assert.throws(()=>save(db,[{action:'update',entity,id,fields:{textBox:'x'.repeat(10001)}}]));
      save(db,[{action:'update',entity,id,fields:{textBox:'x'.repeat(10000)}}]);
    }
    save(db,[{action:'update',entity:'task',id:'task',fields:{textBox:'A'}},{action:'update',entity:'event',id:event.id,fields:{textBox:'B'}}]);assert.equal(db.snapshot().tasks[0].textBox,'A');assert.equal(db.snapshot().events.find(e=>e.id===event.id)!.textBox,'B');
  }finally{db.close();}
});

test('v6 migration initializes text boxes in records and Undo history, preserves Notes and survives restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mymind-textbox-')),path=join(dir,'planner.sqlite');let db=new PlannerDatabase(path);
  try{
    save(db,[{action:'create',entity:'task',id:'task',fields:{title:'Work',notes:'Task notes',scheduledDate:'2026-10-13'}},{action:'create',entity:'event',id:'event',fields:{title:'Meeting',notes:'Event notes',startDate:'2026-10-14'}}]);
    save(db,[{action:'update',entity:'task',id:'task',fields:{title:'Revised'}}]);
    for(const table of ['tasks','events'])for(const row of db.db.prepare(`SELECT id,body FROM ${table}`).all()){
      const item=JSON.parse(row.body as string);delete item.textBox;db.db.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(JSON.stringify(item),row.id as string);
    }
    for(const row of db.db.prepare('SELECT id,before_state FROM history').all()){
      const state=JSON.parse(row.before_state as string);for(const item of [...state.tasks,...state.events])delete item.textBox;
      db.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);
    }
    db.db.exec('PRAGMA user_version=6');db.close();db=new PlannerDatabase(path);
    assert.ok(existsSync(path+'.v6-backup'));assert.equal(db.snapshot().tasks[0].textBox,'');assert.equal(db.snapshot().tasks[0].notes,'Task notes');
    assert.ok(db.snapshot().events.every(e=>e.textBox===''));db.undo();assert.equal(db.snapshot().tasks[0].title,'Work');assert.equal(db.snapshot().tasks[0].textBox,'');
    assert.equal(db.snapshot().events.find(e=>e.id==='event')!.notes,'Event notes');
    save(db,[{action:'update',entity:'task',id:'task',fields:{textBox:'Persistent\ntext'}}]);const state=db.snapshot();db.close();db=new PlannerDatabase(path);assert.deepEqual(db.snapshot(),state);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
