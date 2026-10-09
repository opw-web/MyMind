import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PlannerDatabase } from '../src/main/database';
import { Change } from '../src/shared/model';
import { monthDates, shiftDate, daysBetween, todayIn, isDate } from '../src/shared/dates';
function apply(db:PlannerDatabase,changes:Change[],requestId=randomUUID()){return db.mutate({changes,label:'Test changes',expectedRevision:db.revision,requestId});}
test('calendar dates cover leap years, invalid dates, year transitions and timezone midnight',()=>{
  assert.equal(monthDates(2028,1).length,29);assert.equal(monthDates(2027,1).length,28);
  assert.equal(isDate('2026-02-29'),false);assert.equal(isDate('2028-02-29'),true);
  assert.equal(shiftDate('2026-12-31',1),'2027-01-01');assert.equal(daysBetween('2026-12-29','2027-01-02'),4);
  assert.equal(todayIn('Asia/Kolkata',new Date('2026-10-09T18:29:59Z')),'2026-10-09');
  assert.equal(todayIn('Asia/Kolkata',new Date('2026-10-09T18:30:00Z')),'2026-10-10');
});
test('new data is empty except Inbox; dates/tasks persist in one record; mixed batch Undo',()=>{
  const db=new PlannerDatabase(':memory:');try{
    assert.equal(db.snapshot().events.length,0);assert.equal(db.snapshot().projects[0].id,'inbox');
    apply(db,[{action:'create',entity:'task',id:'cornhole',fields:{title:'Cornhole',dueDate:'2026-10-10'}},{action:'create',entity:'event',id:'exam',fields:{title:'Exam',startDate:'2026-10-16',endDate:'2026-10-18'}}]);
    apply(db,[{action:'update',entity:'task',id:'cornhole',fields:{completed:true}},{action:'update',entity:'event',id:'exam',fields:{startDate:'2026-10-19',endDate:'2026-10-21'}}]);
    assert.equal(db.snapshot().tasks[0].completed,true);assert.equal(db.snapshot().events[0].endDate,'2026-10-21');
    db.undo();assert.equal(db.snapshot().tasks[0].completed,false);assert.equal(db.snapshot().events[0].startDate,'2026-10-16');
    db.undo();assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().events.length,0);
  }finally{db.close();}
});
test('moving only an event start date preserves the complete duration',()=>{
  const db=new PlannerDatabase(':memory:');try{apply(db,[{action:'create',entity:'event',id:'trip',fields:{title:'Trip',startDate:'2026-10-09',endDate:'2026-10-11'}}]);apply(db,[{action:'update',entity:'event',id:'trip',fields:{startDate:'2026-10-15'}}]);assert.equal(db.snapshot().events[0].endDate,'2026-10-17');}finally{db.close();}
});
test('invalid fields, references and dates roll back every part of the batch',()=>{
  const db=new PlannerDatabase(':memory:');try{
    const before=db.snapshot();
    assert.throws(()=>apply(db,[{action:'create',entity:'task',fields:{title:'Should roll back'}},{action:'create',entity:'event',fields:{title:'Bad date',startDate:'2026-02-30'}}]));
    assert.deepEqual(db.snapshot(),before);
    assert.throws(()=>apply(db,[{action:'create',entity:'task',fields:{title:'Invalid project',projectId:'missing'}}]));
    assert.throws(()=>apply(db,[{action:'create',entity:'event',fields:{title:'Bad time',startDate:'2026-10-09',startTime:'15:00',endTime:'14:00'}}]));
    assert.throws(()=>apply(db,[{action:'create',entity:'task',fields:{title:'Unsafe key',sql:'DELETE FROM tasks'}}]));
    assert.equal(db.snapshot().tasks.length,0);
  }finally{db.close();}
});
test('preview is reversible, assigns stable IDs, stale requests fail and retries are idempotent',()=>{
  const db=new PlannerDatabase(':memory:');try{
    const staged=db.preview([{action:'create',entity:'task',fields:{title:'Packaging'}}],0);
    assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().canUndo,false);
    const id='same-request';const receipt=apply(db,staged.changes,id);
    assert.equal(db.snapshot().tasks[0].id,staged.changes[0].id);
    const duplicate=db.mutate({changes:staged.changes,label:'Retry',expectedRevision:0,requestId:id});assert.deepEqual(duplicate,receipt);assert.equal(db.snapshot().tasks.length,1);
    assert.throws(()=>db.mutate({changes:[{action:'create',entity:'task',fields:{title:'Stale'}}],label:'Stale',expectedRevision:0,requestId:'new'}),/changed/);
    db.preferences({dayWidth:160});assert.equal(db.revision,1);
  }finally{db.close();}
});
test('deleting sections or projects moves tasks into Inbox and Undo restores organization',()=>{
  const db=new PlannerDatabase(':memory:');try{
    apply(db,[{action:'create',entity:'project',id:'vip',fields:{title:'VIP project'}},{action:'create',entity:'section',id:'prototype',fields:{title:'Prototype',projectId:'vip'}},{action:'create',entity:'task',id:'walls',fields:{title:'Walls',projectId:'vip',sectionId:'prototype'}}]);
    apply(db,[{action:'delete',entity:'section',id:'prototype'}]);assert.equal(db.snapshot().tasks[0].projectId,'inbox');assert.equal(db.snapshot().tasks[0].sectionId,null);
    db.undo();assert.equal(db.snapshot().tasks[0].sectionId,'prototype');
    apply(db,[{action:'delete',entity:'project',id:'vip'}]);assert.equal(db.snapshot().sections.length,0);assert.equal(db.snapshot().tasks[0].projectId,'inbox');
    db.undo();assert.equal(db.snapshot().sections[0].projectId,'vip');assert.equal(db.snapshot().tasks[0].projectId,'vip');
    assert.throws(()=>apply(db,[{action:'delete',entity:'project',id:'inbox'}]));
  }finally{db.close();}
});
