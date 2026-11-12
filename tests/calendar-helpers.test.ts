import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {calendarEntries,calendarCompletionChanges,calendarEntryChanges,eventCompletion,eventIntervalMinutes,moveEventTo} from '../src/shared/calendar';
import {Change,EventItem} from '../src/shared/model';
import {COMPLETED_TASK_RETENTION_MS,isArchivedTask} from '../src/shared/tasks';
const save=(db:PlannerDatabase,changes:Change[])=>db.mutate({changes,label:'Calendar helper',expectedRevision:db.revision,requestId:crypto.randomUUID()});
function fixture(now:()=>Date=()=>new Date('2026-11-01T10:00:00Z')){const db=new PlannerDatabase(':memory:',now);save(db,[{action:'create',entity:'task',id:'t',fields:{title:'Talk',dueDate:'2026-11-13',steps:[{id:'s1',title:'Slides',completed:false},{id:'s2',title:'Practice',completed:true}]}},{action:'create',entity:'event',id:'e1',fields:{title:'Session',startDate:'2026-11-10',linkedTaskId:'t',linkedStepId:'s1'}},{action:'create',entity:'event',id:'e2',fields:{title:'Other session',startDate:'2026-11-11',linkedTaskId:'t'}},{action:'create',entity:'event',id:'free',fields:{title:'Free',startDate:'2026-11-12'}}]);return db;}

test('calendar projection includes independent sessions and all-day deadline even after archival',()=>{
 let clock=new Date('2026-11-01T10:00:00Z');const db=fixture(()=>clock);try{let entries=calendarEntries(db.snapshot());assert.equal(entries.length,4);const deadline=entries.find(e=>e.id==='deadline:t')!;assert.equal(deadline.entryType,'deadline');assert.equal(deadline.startDate,'2026-11-13');assert.equal(deadline.endDate,'2026-11-13');assert.equal(deadline.startTime,null);assert.equal(deadline.canComplete,true);assert.equal(entries.find(e=>e.id==='free')!.canComplete,false);
 save(db,[{action:'update',entity:'task',id:'t',fields:{completed:true}}]);clock=new Date(clock.getTime()+COMPLETED_TASK_RETENTION_MS+1);assert.equal(isArchivedTask(db.snapshot().tasks[0],clock.getTime()),true);entries=calendarEntries(db.snapshot());assert.equal(entries.length,4);assert.ok(entries.filter(e=>e.linkedTaskId==='t').every(e=>e.completed));
 assert.deepEqual(calendarEntryChanges(db.snapshot(),'deadline:t',{startDate:'2026-11-20',title:'Revised task'}),[{action:'update',entity:'task',id:'t',fields:{dueDate:'2026-11-20',title:'Revised task'}}]);
 assert.deepEqual(calendarEntryChanges(db.snapshot(),'e1',{notes:'Only session'}),[{action:'update',entity:'event',id:'e1',fields:{notes:'Only session'}}]);
 }finally{db.close();}
});

test('step completion is independent; reopening step under completed parent preserves other flags',()=>{
 const db=fixture();try{save(db,calendarCompletionChanges(db.snapshot(),'e1',true));assert.equal(db.snapshot().tasks[0].completed,false);assert.deepEqual(db.snapshot().tasks[0].steps.map(s=>s.completed),[true,true]);assert.equal(eventCompletion(db.snapshot().events[0],db.snapshot().tasks),true);assert.equal(eventCompletion(db.snapshot().events[1],db.snapshot().tasks),false);
 save(db,calendarCompletionChanges(db.snapshot(),'deadline:t',true));assert.equal(db.snapshot().events[0].completed,true);assert.equal(db.snapshot().events[1].completed,true);
 save(db,calendarCompletionChanges(db.snapshot(),'e1',false));assert.equal(db.snapshot().tasks[0].completed,false);assert.deepEqual(db.snapshot().tasks[0].steps.map(s=>s.completed),[false,true]);assert.deepEqual(calendarCompletionChanges(db.snapshot(),'free',true),[]);
 }finally{db.close();}
});

test('exact-minute intervals and movement preserve overnight duration',()=>{
 const event={startDate:'2026-11-10',endDate:'2026-11-11',startTime:'23:47',endTime:'07:12'} as EventItem;
 assert.equal(eventIntervalMinutes(event),445);assert.deepEqual(moveEventTo(event,'2026-11-12','23:03'),{startDate:'2026-11-12',endDate:'2026-11-13',startTime:'23:03',endTime:'06:28'});
 assert.deepEqual(moveEventTo(event,'2026-11-12'),{startDate:'2026-11-12',endDate:'2026-11-13',startTime:'23:47',endTime:'07:12'});
 assert.equal(eventIntervalMinutes({...event,startDate:'2026-11-10',endDate:'2026-11-10',startTime:'13:07',endTime:'14:23'}),76);
});

test('movement returns only placement fields even when passed a complete session',()=>{
 const event={id:'session',title:'Independent title',notes:'Private',startDate:'2026-11-10',endDate:'2026-11-10',startTime:'13:07',endTime:'14:23'} as EventItem;
 assert.deepEqual(moveEventTo(event,'2026-11-12'),{startDate:'2026-11-12',endDate:'2026-11-12',startTime:'13:07',endTime:'14:23'});
});


test('colliding legacy session and deadline IDs route by type while ambiguous strings fail safely',()=>{
 const db=fixture();try{
 save(db,[{action:'create',entity:'task',id:'other',fields:{title:'Other work'}},{action:'create',entity:'event',id:'deadline:t',fields:{title:'Legacy session',notes:'Keep session',startDate:'2026-11-09',linkedTaskId:'other'}}]);
 let entries=calendarEntries(db.snapshot());const collisions=entries.filter(entry=>entry.id==='deadline:t');assert.equal(collisions.length,2);
 const deadline=collisions.find(entry=>entry.entryType==='deadline')!,session=collisions.find(entry=>entry.entryType==='session')!,before=db.snapshot().events.find(event=>event.id==='deadline:t')!;
 const initial=db.snapshot();assert.throws(()=>calendarEntryChanges(initial,'deadline:t',{startDate:'2026-11-20'}),/ambiguous/i);assert.throws(()=>calendarCompletionChanges(initial,'deadline:t',true),/ambiguous/i);assert.deepEqual(db.snapshot(),initial);
 save(db,calendarEntryChanges(db.snapshot(),deadline,{startDate:'2026-11-20'}));assert.equal(db.snapshot().tasks.find(task=>task.id==='t')!.dueDate,'2026-11-20');assert.deepEqual(db.snapshot().events.find(event=>event.id==='deadline:t'),before);
 save(db,calendarCompletionChanges(db.snapshot(),deadline,true));assert.equal(db.snapshot().tasks.find(task=>task.id==='t')!.completed,true);assert.equal(db.snapshot().tasks.find(task=>task.id==='other')!.completed,false);assert.deepEqual(db.snapshot().events.find(event=>event.id==='deadline:t'),before);
 save(db,calendarEntryChanges(db.snapshot(),session,{notes:'Session only'}));assert.equal(db.snapshot().events.find(event=>event.id==='deadline:t')!.notes,'Session only');assert.equal(db.snapshot().tasks.find(task=>task.id==='t')!.notes,'');
 save(db,[{action:'update',entity:'event',id:'deadline:t',fields:{completed:true}}]);assert.equal(db.snapshot().tasks.find(task=>task.id==='other')!.completed,true);
 }finally{db.close();}
});
