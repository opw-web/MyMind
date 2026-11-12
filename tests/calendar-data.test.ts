import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PlannerDatabase} from '../src/main/database';
import {prepareDraft} from '../src/main/draft';
import {Change} from '../src/shared/model';
const save=(db:PlannerDatabase,changes:Change[])=>db.mutate({changes,label:'Calendar test',expectedRevision:db.revision,requestId:crypto.randomUUID()});
const task=(db:PlannerDatabase)=>save(db,[{action:'create',entity:'task',id:'work',fields:{title:'Prepare talk',notes:'Task notes',textBox:'Task box',dueDate:'2026-11-13',steps:[{id:'slides',title:'Slides',completed:false},{id:'practice',title:'Practice',completed:true}]}}]);
const session=(id:string,date:string,extra:Record<string,unknown>={}):Change=>({action:'create',entity:'event',id,fields:{title:id,notes:`${id} notes`,textBox:`${id} box`,startDate:date,linkedTaskId:'work',...extra}});

test('Tuesday and Wednesday sessions retain independent content, kind and Friday deadline',()=>{
 const db=new PlannerDatabase(':memory:');try{
 task(db);save(db,[session('tuesday','2026-11-10'),session('wednesday','2026-11-11',{kind:'actual',linkedStepId:'slides',startTime:'13:07',endTime:'14:23'})]);
 const first=db.snapshot();assert.equal(first.tasks[0].dueDate,'2026-11-13');assert.equal(first.events.length,2);assert.equal(first.events[0].kind,'planned');
 save(db,[{action:'update',entity:'task',id:'work',fields:{title:'Changed task',notes:'changed',textBox:'changed',dueDate:'2026-11-20',categoryTitle:'Research'}}]);
 assert.deepEqual(db.snapshot().events,first.events);
 save(db,[{action:'update',entity:'event',id:'tuesday',fields:{title:'Tuesday only',notes:'Independent',textBox:'Independent box',startDate:'2026-11-17'}}]);
 assert.equal(db.snapshot().tasks[0].dueDate,'2026-11-20');assert.equal(db.snapshot().tasks[0].title,'Changed task');assert.equal(db.snapshot().events[1].startDate,'2026-11-11');
 db.undo();assert.deepEqual(db.snapshot().events,first.events);
 }finally{db.close();}
});

test('task and step removal detach sessions while preserving their independent data',()=>{
 const db=new PlannerDatabase(':memory:');try{task(db);save(db,[session('s','2026-11-10',{linkedStepId:'slides'})]);const content=db.snapshot().events[0];
 save(db,[{action:'update',entity:'task',id:'work',fields:{steps:[{id:'practice',title:'Practice',completed:true}]}}]);
 assert.deepEqual(db.snapshot().events[0],{...content,linkedStepId:null});db.undo();assert.equal(db.snapshot().events[0].linkedStepId,'slides');
 save(db,[{action:'delete',entity:'task',id:'work'}]);assert.deepEqual(db.snapshot().events[0],{...content,linkedTaskId:null,linkedStepId:null});db.undo();assert.equal(db.snapshot().events[0].linkedStepId,'slides');
 }finally{db.close();}
});

test('link validation permits multiple blocks and reassignment but rejects dangling step and task links atomically',()=>{
 const db=new PlannerDatabase(':memory:');try{task(db);save(db,[session('a','2026-11-10'),session('b','2026-11-11')]);
 const before=db.snapshot();for(const fields of [{linkedTaskId:'missing'},{linkedStepId:'missing'},{linkedTaskId:null,linkedStepId:'slides'}]){
 assert.throws(()=>save(db,[{action:'update',entity:'event',id:'a',fields}]));assert.deepEqual(db.snapshot(),before);
 }
 save(db,[{action:'update',entity:'event',id:'a',fields:{linkedTaskId:null,linkedStepId:null}}]);assert.equal(db.snapshot().events[0].linkedTaskId,null);
 }finally{db.close();}
});

test('sleep semantic aliases survive rename, preview, delete and Undo without duplicate categories',()=>{
 const db=new PlannerDatabase(':memory:');try{
 const activity=(id:string,title:string,categoryTitle?:string):Change=>({action:'create',entity:'event',id,fields:{title,startDate:'2026-11-10',kind:'actual',...(categoryTitle?{categoryTitle}:{})}});
 save(db,[activity('night1','I slept last night')]);const original=db.snapshot().categories[0];assert.equal(original.title,'Sleep');assert.equal(original.semanticKey,'sleep');
 save(db,[{action:'update',entity:'category',id:original.id,fields:{title:'Rest and recovery'}}]);
 const before=db.snapshot(),preview=db.preview([activity('night2','Went to bed yesterday','Sleeping')],db.revision);assert.deepEqual(db.snapshot(),before);save(db,preview.changes);
 assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().events[1].categoryId,original.id);
 const event=db.snapshot().events[0];save(db,[{action:'delete',entity:'category',id:original.id}]);assert.deepEqual(db.snapshot().events[0],{...event,categoryId:null,colorOverride:event.color});
 db.undo();save(db,[activity('night3','Slept for eight hours','Sleep')]);assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().events[2].categoryId,original.id);
 }finally{db.close();}
});

test('v8 migration includes WAL backup, preserves records/deadline, normalizes Undo and materializes placement once',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bloom-v8-')),path=join(dir,'planner.sqlite');let db=new PlannerDatabase(path);let old:DatabaseSync|undefined;
 try{task(db);save(db,[session('legacy','2026-11-10')]);db.close();
 old=new DatabaseSync(path);old.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
 const stored=JSON.parse((old.prepare('SELECT body FROM tasks WHERE id=?').get('work') as {body:string}).body);stored.scheduledDate='2026-11-10';stored.dueDate='2026-11-13';old.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(stored),'work');
 const event=JSON.parse((old.prepare('SELECT body FROM events WHERE id=?').get('legacy') as {body:string}).body);delete event.kind;delete event.linkedStepId;event.completed=true;old.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(event),'legacy');
 const before={tasks:[{...stored,id:'unscheduled',scheduledDate:'2026-11-12'}],events:[],projects:[{id:'inbox',title:'Inbox',order:0}],sections:[],categories:[]};
 old.prepare('INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)').run('Legacy undo',JSON.stringify(before),'[]');old.exec('PRAGMA user_version=8');
 db=new PlannerDatabase(path);assert.ok(existsSync(path+'.v8-backup'));assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].id,'legacy');assert.equal(db.snapshot().events[0].kind,'planned');assert.deepEqual(JSON.parse((db.db.prepare('SELECT body FROM events WHERE id=?').get('legacy') as {body:string}).body),{...event,kind:'planned',linkedStepId:null});assert.equal(db.snapshot().tasks[0].dueDate,'2026-11-13');
 const backup=new DatabaseSync(path+'.v8-backup');assert.equal(JSON.parse((backup.prepare('SELECT body FROM tasks WHERE id=?').get('work') as {body:string}).body).dueDate,'2026-11-13');backup.close();old.close();old=undefined;
 db.undo();assert.equal(db.snapshot().tasks[0].dueDate,'2026-11-13');assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].linkedTaskId,'unscheduled');const saved=db.snapshot();
 db.close();db=new PlannerDatabase(path);assert.deepEqual(db.snapshot(),saved);
 }finally{old?.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy completion adapter applies multiple step toggles in one batch without dropping flags',()=>{
 const db=new PlannerDatabase(':memory:');try{task(db);save(db,[{action:'update',entity:'task',id:'work',fields:{steps:[{id:'slides',title:'Slides',completed:false},{id:'practice',title:'Practice',completed:false}]}},session('slides-block','2026-11-10',{linkedStepId:'slides'}),session('practice-block','2026-11-11',{linkedStepId:'practice'})]);
 save(db,[{action:'update',entity:'event',id:'slides-block',fields:{completed:true}},{action:'update',entity:'event',id:'practice-block',fields:{completed:true}}]);
 assert.deepEqual(db.snapshot().tasks[0].steps.map(step=>step.completed),[true,true]);assert.equal(db.snapshot().tasks[0].completed,false);
 }finally{db.close();}
});

test('equivalent explicit category creations reuse a renamed semantic identity and rewrite batch references',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep'}},{action:'update',entity:'category',id:'sleep',fields:{title:'Recovery'}}]);
 save(db,[{action:'create',entity:'category',id:'duplicate',fields:{title:'Sleeping'}},{action:'create',entity:'event',id:'night',fields:{title:'Night',startDate:'2026-11-10',categoryId:'duplicate'}}]);
 assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().events[0].categoryId,'sleep');assert.equal(db.snapshot().categories[0].title,'Recovery');
 }finally{db.close();}
});

test('repeated legacy scheduling changes materialize one session at the final requested placement',()=>{
 const db=new PlannerDatabase(':memory:');try{task(db);save(db,[{action:'update',entity:'task',id:'work',fields:{scheduledDate:'2026-11-10'}},{action:'update',entity:'task',id:'work',fields:{scheduledDate:'2026-11-11'}}]);
 assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].startDate,'2026-11-11');assert.equal(db.snapshot().tasks[0].dueDate,'2026-11-13');
 }finally{db.close();}
});

test('calendar checkbox preview can be corrected and replayed without a later stale update winning',()=>{
 const db=new PlannerDatabase(':memory:');try{task(db);save(db,[{action:'update',entity:'task',id:'work',fields:{steps:[{id:'slides',title:'Slides',completed:false},{id:'practice',title:'Practice',completed:false}]}},session('slides-block','2026-11-10',{linkedStepId:'slides'}),session('practice-block','2026-11-11',{linkedStepId:'practice'})]);
 const preview=db.preview([{action:'update',entity:'event',id:'slides-block',fields:{completed:true}},{action:'update',entity:'event',id:'practice-block',fields:{completed:true}}],db.revision);
 const corrected=prepareDraft(db.snapshot(),preview.changes,[{action:'update',entity:'task',id:'work',fields:{steps:[{id:'slides',title:'Slides',completed:false},{id:'practice',title:'Practice',completed:true}]}}]);
 save(db,corrected);assert.deepEqual(db.snapshot().tasks[0].steps.map(step=>step.completed),[false,true]);
 }finally{db.close();}
});


test('absorbed category update IDs normalize transitively through preview, replay and Undo',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep'}},{action:'create',entity:'event',id:'night',fields:{title:'Night',startDate:'2026-11-10',categoryId:'sleep'}}]);
 const before=db.snapshot(),preview=db.preview([{action:'create',entity:'category',id:'alias1',fields:{title:'Sleeping'}},{action:'create',entity:'category',id:'alias2',fields:{title:'Slept'}},{action:'update',entity:'category',id:'alias2',fields:{title:'Recovery',color:'rose'}}],db.revision);
 assert.deepEqual(db.snapshot(),before);assert.equal(preview.changes.some(change=>change.id==='alias1'||change.id==='alias2'),false);
 save(db,preview.changes);assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().categories[0].id,'sleep');assert.equal(db.snapshot().categories[0].title,'Recovery');assert.equal(db.snapshot().events[0].color,'rose');
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

test('deleting an absorbed category identity deletes the canonical category and preserves session content through Undo',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}},{action:'create',entity:'event',id:'night',fields:{title:'Night',notes:'Keep notes',textBox:'Keep text',startDate:'2026-11-10',categoryId:'sleep'}}]);
 const before=db.snapshot(),preview=db.preview([{action:'create',entity:'category',id:'alias',fields:{title:'Sleeping'}},{action:'delete',entity:'category',id:'alias'}],db.revision);
 assert.deepEqual(db.snapshot(),before);assert.ok(preview.changes.some(change=>change.action==='delete'&&change.entity==='category'&&change.id==='sleep'));
 save(db,preview.changes);assert.equal(db.snapshot().categories.length,0);assert.deepEqual(db.snapshot().events[0],{...before.events[0],categoryId:null,colorOverride:'lavender'});
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

for(const viaDraft of [false,true])test(`deleted absorbed category is excluded from inference and safely recreated through ${viaDraft?'draft':'database'} preview/replay and Undo`,()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}},{action:'create',entity:'event',id:'previous-night',fields:{title:'Earlier night',notes:'Keep history',startDate:'2026-11-09',categoryId:'sleep'}}]);
 const before=db.snapshot(),source:Change[]=[{action:'create',entity:'category',id:'alias',fields:{title:'Sleeping'}},{action:'delete',entity:'category',id:'alias'},{action:'create',entity:'event',id:'new-night',fields:{title:'Slept last night',startDate:'2026-11-10'}},{action:'create',entity:'event',id:'another-night',fields:{title:'Went to bed yesterday',startDate:'2026-11-11'}}];
 const preview=db.preview(source,db.revision);assert.deepEqual(db.snapshot(),before);
 const changes=viaDraft?prepareDraft(before,preview.changes,[]):preview.changes;
 const deletion=changes.findIndex(change=>change.entity==='category'&&change.action==='delete'&&change.id==='sleep'),creation=changes.findIndex(change=>change.entity==='category'&&change.action==='create');assert.ok(deletion>=0&&creation>deletion);
 const replay=db.preview(changes,db.revision);assert.deepEqual(db.snapshot(),before);save(db,replay.changes);
 const after=db.snapshot(),category=after.categories[0];assert.equal(after.categories.length,1);assert.notEqual(category.id,'sleep');assert.equal(category.title,'Sleep');assert.equal(category.semanticKey,'sleep');assert.equal(after.events.find(event=>event.id==='new-night')!.categoryId,category.id);assert.equal(after.events.find(event=>event.id==='another-night')!.categoryId,category.id);
 assert.deepEqual(after.events.find(event=>event.id==='previous-night'),{...before.events[0],categoryId:null,colorOverride:'lavender'});
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

test('inference reuses a surviving semantic category after an absorbed canonical deletion',()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}}]);
 // Legacy saved categories can share semantics while retaining distinct IDs/titles.
 db.db.prepare('INSERT INTO categories(id,body) VALUES (?,?)').run('rest',JSON.stringify({id:'rest',title:'Night rest',color:'sage',semanticKey:'sleep',aliases:['sleep','sleeping']}));
 const before=db.snapshot(),preview=db.preview([{action:'create',entity:'category',id:'alias',fields:{title:'Sleeping'}},{action:'delete',entity:'category',id:'alias'},{action:'create',entity:'event',id:'night',fields:{title:'Slept last night',startDate:'2026-11-10'}}],db.revision);
 assert.deepEqual(db.snapshot(),before);assert.equal(preview.changes.some(change=>change.entity==='category'&&change.action==='create'),false);
 save(db,prepareDraft(before,preview.changes,[]));assert.equal(db.snapshot().categories.length,1);assert.equal(db.snapshot().categories[0].id,'rest');assert.equal(db.snapshot().events[0].categoryId,'rest');assert.equal(db.snapshot().events[0].color,'sage');
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

for(const viaDraft of [false,true])for(const override of [null,'rose'] as const)test(`reassignment before category deletion preserves ${override?'genuine override':'category inheritance'} through ${viaDraft?'draft':'database'} preview/replay and Undo`,()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}},{action:'create',entity:'category',id:'work',fields:{title:'Work',color:'sage'}},{action:'create',entity:'event',id:'night',fields:{title:'Night',startDate:'2026-11-10',categoryId:'sleep',colorOverride:override}}]);
 const before=db.snapshot(),source:Change[]=[{action:'update',entity:'event',id:'night',fields:{categoryId:'work'}},{action:'delete',entity:'category',id:'sleep'},{action:'create',entity:'event',id:'new-night',fields:{title:'Slept last night',startDate:'2026-11-11'}}],changes=viaDraft?prepareDraft(before,[],source):source;
 const preview=db.preview(changes,db.revision);assert.deepEqual(db.snapshot(),before);save(db,preview.changes);
 assert.equal(db.snapshot().events[0].categoryId,'work');assert.equal(db.snapshot().events[0].colorOverride,override);assert.equal(db.snapshot().events[0].color,override??'sage');const recreated=db.snapshot().categories.find(category=>category.title==='Sleep')!;assert.notEqual(recreated.id,'sleep');assert.equal(db.snapshot().events.find(event=>event.id==='new-night')!.categoryId,recreated.id);
 save(db,[{action:'update',entity:'category',id:'work',fields:{color:'sky'}}]);assert.equal(db.snapshot().events[0].color,override??'sky');
 db.undo();db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

for(const path of ['mutate','preview','draft'] as const)test(`inferred consumers before a same-title deletion wait for their category through ${path}`,()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}},{action:'create',entity:'category',id:'work',fields:{title:'Work',color:'sage'}},
 ...['inherited','custom','history'].map(id=>({action:'create',entity:'event',id,fields:{title:id,notes:'Keep notes',startDate:'2026-11-09',categoryId:'sleep',colorOverride:id==='custom'?'rose':null}} as Change)),
 {action:'create',entity:'event',id:'recategorized',fields:{title:'Rest',startDate:'2026-11-09',categoryId:'work'}}]);
 const before=db.snapshot(),source:Change[]=[
 {action:'create',entity:'event',id:'new-night',fields:{title:'Slept last night',startDate:'2026-11-10'}},
 {action:'create',entity:'task',id:'rest-task',fields:{title:'Sleep routine'}},
 {action:'create',entity:'event',id:'linked',fields:{title:'Routine session',startDate:'2026-11-11',categoryId:'work',linkedTaskId:'rest-task'}},
 {action:'update',entity:'event',id:'recategorized',fields:{categoryTitle:'Sleeping'}},
 {action:'update',entity:'event',id:'new-night',fields:{notes:'Keep the later edit'}},
 {action:'update',entity:'event',id:'inherited',fields:{categoryId:'work'}},
 {action:'update',entity:'event',id:'custom',fields:{categoryId:'work'}},
 {action:'delete',entity:'category',id:'sleep'}];
 let changes=path==='draft'?prepareDraft(before,[],source):source;
 if(path!=='mutate'){
   const preview=db.preview(changes,db.revision);assert.deepEqual(db.snapshot(),before);
   const deletion=preview.changes.findIndex(c=>c.entity==='category'&&c.action==='delete'),creation=preview.changes.findIndex(c=>c.entity==='category'&&c.action==='create');
   assert.ok(deletion>=0&&creation>deletion);
   for(const id of ['new-night','rest-task','recategorized'])assert.ok(preview.changes.findIndex(c=>c.id===id)>creation);
   for(const id of ['inherited','custom'])assert.ok(preview.changes.findIndex(c=>c.id===id)<deletion);
   changes=db.preview(path==='draft'?prepareDraft(before,preview.changes,[]):preview.changes,db.revision).changes;
   assert.deepEqual(db.snapshot(),before);
 }
 save(db,changes);
 const after=db.snapshot(),category=after.categories.find(c=>c.title==='Sleep')!;
 assert.equal(after.categories.length,2);assert.notEqual(category.id,'sleep');assert.equal(category.semanticKey,'sleep');
 for(const id of ['new-night','recategorized'])assert.equal(after.events.find(e=>e.id===id)!.categoryId,category.id);
 assert.equal(after.tasks.find(t=>t.id==='rest-task')!.categoryId,category.id);
 assert.equal(after.events.find(e=>e.id==='linked')!.linkedTaskId,'rest-task');
 assert.equal(after.events.find(e=>e.id==='new-night')!.notes,'Keep the later edit');
 assert.deepEqual(after.events.find(e=>e.id==='history'),{...before.events.find(e=>e.id==='history')!,categoryId:null,colorOverride:'lavender'});
 for(const id of ['inherited','custom']){const event=after.events.find(e=>e.id===id)!;assert.equal(event.categoryId,'work');assert.equal(event.colorOverride,id==='custom'?'rose':null);assert.equal(event.color,id==='custom'?'rose':'sage');}
 save(db,[{action:'update',entity:'category',id:'work',fields:{color:'sky'}}]);
 assert.equal(db.snapshot().events.find(e=>e.id==='inherited')!.color,'sky');assert.equal(db.snapshot().events.find(e=>e.id==='custom')!.color,'rose');
 db.undo();db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);assert.deepEqual(db.snapshot().tasks,before.tasks);
 }finally{db.close();}
});

for(const viaDraft of [false,true])test(`forward category references and rename wait for same-title replacement through ${viaDraft?'draft':'database'}`,()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep',color:'lavender'}}]);
 const before=db.snapshot(),source:Change[]=[
 {action:'create',entity:'event',id:'night',fields:{title:'Night',startDate:'2026-11-10',categoryId:'replacement'}},
 {action:'create',entity:'category',id:'replacement',fields:{title:'Sleep',color:'lavender'}},
 {action:'update',entity:'category',id:'replacement',fields:{title:'Recovery',color:'sage'}},
 {action:'delete',entity:'category',id:'sleep'}];
 const preview=db.preview(viaDraft?prepareDraft(before,[],source):source,db.revision);assert.deepEqual(db.snapshot(),before);save(db,preview.changes);
 assert.equal(db.snapshot().categories[0].id,'replacement');assert.equal(db.snapshot().categories[0].title,'Recovery');assert.equal(db.snapshot().events[0].categoryId,'replacement');assert.equal(db.snapshot().events[0].color,'sage');
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);
 }finally{db.close();}
});

for(const viaDraft of [false,true])test(`a delayed linked session precedes deletion of its explicitly referenced category through ${viaDraft?'draft':'database'}`,()=>{
 const db=new PlannerDatabase(':memory:');try{
 save(db,[{action:'create',entity:'category',id:'sleep',fields:{title:'Sleep'}},{action:'create',entity:'category',id:'work',fields:{title:'Work',color:'sage'}}]);
 const before=db.snapshot(),source:Change[]=[
 {action:'create',entity:'task',id:'rest-task',fields:{title:'Sleep routine'}},
 {action:'create',entity:'event',id:'session',fields:{title:'Session',startDate:'2026-11-10',categoryId:'work',linkedTaskId:'rest-task'}},
 {action:'delete',entity:'category',id:'work'},
 {action:'delete',entity:'category',id:'sleep'}];
 const preview=db.preview(viaDraft?prepareDraft(before,[],source):source,db.revision);assert.deepEqual(db.snapshot(),before);save(db,preview.changes);
 const event=db.snapshot().events[0];assert.equal(event.linkedTaskId,'rest-task');assert.equal(event.categoryId,null);assert.equal(event.color,'sage');assert.equal(event.colorOverride,'sage');
 db.undo();assert.deepEqual(db.snapshot().categories,before.categories);assert.deepEqual(db.snapshot().events,before.events);assert.deepEqual(db.snapshot().tasks,before.tasks);
 }finally{db.close();}
});
