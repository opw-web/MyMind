import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkload,workloadChanges} from '../src/main/workload';
const task=(key:string,title:string,source=title)=>({key,title,source,dueDate:null,sessions:[],dependsOnKeys:[],notes:'',steps:[]});
test('structured workloads retain shared preparation links and independent task IDs',()=>{
 const text='I need to collect receipts. From those receipts I need to file expenses and I need to prepare taxes.';
 const draft=validateWorkload({tasks:[task('receipts','Collect receipts','collect receipts'),{...task('expenses','File expenses','file expenses'),dependsOnKeys:['receipts']},{...task('taxes','Prepare taxes','prepare taxes'),dependsOnKeys:['receipts']}],unresolved:[]},text);
 const {changes}=workloadChanges(draft);assert.equal(new Set(changes.map(c=>c.id)).size,3);assert.deepEqual(changes[1].fields?.dependsOnIds,[changes[0].id]);assert.deepEqual(changes[2].fields?.dependsOnIds,[changes[0].id]);
});
test('unrepresented commitments require repair before the whole batch can save',()=>{
 assert.throws(()=>validateWorkload({tasks:[task('receipts','Collect receipts')],unresolved:[]},'I need to collect receipts. I also need to renew my passport.'),/passport/);
});
test('missing references, self links, cycles and fabricated evidence fail validation',()=>{
 const tasks=[task('a','First task'),task('b','Second task')],base={tasks,unresolved:[]},text='First task. Second task.';
 for(const links of [[['missing'],[]],[['a'],[]],[['b'],['a']]])assert.throws(()=>validateWorkload({...base,tasks:tasks.map((t,i)=>({...t,dependsOnKeys:links[i]}))},text),/Prerequisites/);
 assert.throws(()=>validateWorkload({...base,tasks:[{...tasks[0],source:'Invented statement'}]},text),/actually present/);
});
test('uncertain additional work is accounted for without creating a filler task',()=>{
 const draft=validateWorkload({tasks:[task('receipts','Collect receipts')],unresolved:[{taskKey:null,field:'newTask',source:'renew my widget',question:'What does widget refer to?'}]},'I need to collect receipts. I need to renew my widget.');
 const converted=workloadChanges(draft);assert.equal(converted.changes.length,1);assert.equal(converted.questions[0].taskId,null);
});
test('shortened quotations resolve to original text, while filler and invented questions do not block clear work',()=>{
 const text='What I want to do is, well, first things first. I need to collect my parcel from the mailroom. I need to do more of them if any of them are clearly.';
 const draft=validateWorkload({tasks:[task('parcel','Collect parcel','collect my parcel ... from the mailroom')],unresolved:[{taskKey:null,field:'newTask',source:'unspecified details not provided',question:'Which planner do you want?'},{taskKey:null,field:'newTask',source:'first things first',question:'What tasks are hidden in this filler?'}]},text);
 assert.equal(draft.tasks[0].source,'collect my parcel from the mailroom');assert.deepEqual(draft.unresolved,[]);
});
test('a conflicting weekday and numeric deadline stays unresolved',()=>{
 const draft=validateWorkload({tasks:[{...task('call','Call supplier','call my supplier'),dueDate:'2026-10-13',notes:'Due 2026-10-13',steps:['Dial number']}],unresolved:[]},'I need to call my supplier by coming Tuesday, the 24th Tuesday.');
 assert.equal(draft.tasks[0].dueDate,null);assert.equal(draft.tasks[0].steps.length,0);assert.doesNotMatch(draft.tasks[0].notes,/2026-10-13/);assert.equal(draft.unresolved[0].field,'dueDate');assert.equal(draft.unresolved[0].taskKey,'call');
});
test('generic determiners before profile do not turn into extra-work questions',()=>{
 const draft=validateWorkload({tasks:[task('profile','Create personal profile','make a profile')],unresolved:[]},'I need to make a profile.');
 assert.deepEqual(draft.unresolved,[]);
});
test('mentioning preparation in an output does not account for the requested preparation task',()=>{
 const text='I need to prepare a project brief. From that brief, I need to update the website.';
 assert.throws(()=>validateWorkload({tasks:[task('site','Update website from project brief','update the website')],unresolved:[]},text),/separately requested preparation/);
 const draft=validateWorkload({tasks:[task('brief','Prepare project brief','prepare a project brief'),{...task('site','Update website from project brief','update the website'),dependsOnKeys:['brief']}],unresolved:[]},text);
 assert.equal(draft.tasks.length,2);
});
test('date questions identify the saved task and avoid model-invented calendar assumptions',()=>{
 const text='I need to call my supplier by coming Sunday or the 10th Sunday.';
 const draft=validateWorkload({tasks:[{...task('call','Call supplier','call my supplier'),dueDate:'2026-10-18'}],unresolved:[{taskKey:null,field:'sessions',source:'coming Sunday or the 10th Sunday',question:'Clarify dueDate and scheduledDate; perhaps next year?'}]},text);
 assert.equal(draft.tasks[0].dueDate,null);assert.equal(draft.unresolved.length,1);assert.match(draft.unresolved[0].question,/Date.*Call supplier/);assert.doesNotMatch(draft.unresolved[0].question,/sessions|dueDate|next year/);
});
