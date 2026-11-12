import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {activityReport} from '../src/main/activity';

test('explicit multi-day actual intervals compile together without a model or duplicate records',()=>{
 const db=new PlannerDatabase(':memory:');
 const request='On 2026-11-03 I slept from 11 PM to 6 AM, and on 2026-11-04 I slept from 11 PM to 6 AM. Record both as separate actual Sleep activities in the same Sleep category, each ending the following morning. Do not add tasks or planned sessions.';
 try{
  const report=activityReport(request,'2026-11-06',db.snapshot());
  assert.ok(report&&!report.mixed&&!report.question);
  assert.deepEqual(report.changes.map(({fields})=>[fields?.kind,fields?.startDate,fields?.endDate,fields?.startTime,fields?.endTime]),[
   ['actual','2026-11-03','2026-11-04','23:00','06:00'],
   ['actual','2026-11-04','2026-11-05','23:00','06:00'],
  ]);
  db.mutate({changes:report.changes,label:'Log nights',expectedRevision:0,requestId:'nights'});
  assert.equal(db.snapshot().categories.length,1);
  assert.equal(activityReport(request,'2026-11-06',db.snapshot())?.duplicate,true);
  const mixed=request.replace('Do not add tasks or planned sessions.','Add a task called Pack.');
  assert.equal(activityReport(mixed,'2026-11-06',db.snapshot())?.mixed,true);
 }finally{db.close();}
});
test('sleep duration from last night and morning travel use exact local intervals; ambiguous/hypothetical/quoted reports never execute',()=>{
 const db=new PlannerDatabase(':memory:');try{const state=db.snapshot();const overnight=activityReport('I slept eight hours from 11 PM last night','2026-11-05',state)!;assert.deepEqual(Object.fromEntries(Object.entries(overnight.changes[0].fields!).filter(([key])=>['startDate','endDate','startTime','endTime','kind'].includes(key))),{kind:'actual',startDate:'2026-11-04',endDate:'2026-11-05',startTime:'23:00',endTime:'07:00'});
 const travel=activityReport('From 6 AM to 8 AM got ready and traveled','2026-11-05',state)!;assert.equal(travel.changes[0].fields?.title,'Get ready and travel');assert.equal(travel.changes[0].fields?.startTime,'06:00');assert.equal(travel.changes[0].fields?.endTime,'08:00');
 assert.ok(activityReport('I slept from 1 to 6','2026-11-05',state)?.question);
 for(const text of ['What if I slept from 1 AM to 6 AM?','I would sleep from 1 AM to 6 AM','"Today I slept from 1 AM to 6 AM"','Did I sleep from 1 AM to 6 AM?','I slept from 1 AM to 6 AM every day'])assert.equal(activityReport(text,'2026-11-05',state),undefined,text);
 }finally{db.close();}
});
test('equivalent actual reports reuse renamed Sleep semantics, retain a separate night, and never dedupe planned sessions',()=>{
 const db=new PlannerDatabase(':memory:');try{const one=activityReport('Today I slept from 1 AM to 6 AM','2026-11-05',db.snapshot())!;db.mutate({changes:one.changes,label:'Log',expectedRevision:0,requestId:'one'});const category=db.snapshot().categories[0];db.mutate({changes:[{action:'update',entity:'category',id:category.id,fields:{title:'Rest'}}],label:'Rename',expectedRevision:1,requestId:'rename'});assert.equal(activityReport('Today I slept from 1 AM to 6 AM','2026-11-05',db.snapshot())?.duplicate,true);const next=activityReport('Today I slept from 1 AM to 6 AM','2026-11-06',db.snapshot())!;db.mutate({changes:next.changes,label:'Next',expectedRevision:2,requestId:'next'});assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().events[1].categoryId,category.id);assert.equal(db.snapshot().events.length,2);assert.equal(db.snapshot().tasks.length,0);
 }finally{db.close();}
});
