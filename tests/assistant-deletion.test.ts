import assert from 'node:assert/strict';
import {test, TestContext} from 'node:test';
import {PlannerAssistant} from '../src/main/assistant';
import {PlannerDatabase} from '../src/main/database';
import {OllamaRuntime} from '../src/main/ollama';
import {Change, ChatEvent, PendingDraft} from '../src/shared/model';

const task=(id:string,title:string):Change=>({action:'create',entity:'task',id,fields:{title}});
const event=(id:string,title:string,linkedTaskId?:string):Change=>({action:'create',entity:'event',id,fields:{title,startDate:'2026-11-10',...(linkedTaskId?{linkedTaskId}:{})}});
const del=(entity:'task'|'event',id:string):Change=>({action:'delete',entity,id});
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const finish=()=>tool('finish_request',{outcome:'no_change',message:'I could not finish the request.'});
const mutationKeys=(changes:Change[])=>changes.map(({action,entity,id})=>`${action}:${entity}:${id}`).sort();

function fixture(t:TestContext,changes:Change[],responses:unknown[]=[]) {
  const db=new PlannerDatabase(':memory:');
  t.after(()=>db.close());
  db.mutate({changes,label:'Fixture',expectedRevision:0,requestId:'fixture'});
  const events:ChatEvent[]=[];
  const requests:unknown[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async(_route:string,body:unknown)=>{
    requests.push(body);
    return responses.shift()??finish();
  }} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{},event=>events.push(event));
  const apply=(draft:PendingDraft,requestId:string)=>assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId});
  return {db,assistant,events,requests,apply};
}

test('dictated deletion resolves the correction, plural tasks, and every linked event before preview',async t=>{
  const {assistant,db,apply,requests}=fixture(t,[
    task('application','Apply for Community Garden Plan'),task('hall-a','Library fundraiser'),task('hall-b','Library fundraiser'),task('new-age','The Mosaic Workshop'),
    event('application-session','Draft application','application'),event('hall-session-a','Find the room','hall-a'),event('hall-session-b','Make the agenda','hall-b'),
    event('hall-actual','Town hall rehearsal','hall-b'),event('age-session','Read The Mosaic Workshop','new-age'),event('unrelated','Library fundraiser')
  ].map(change=>change.id==='hall-actual'?{...change,fields:{...change.fields,kind:'actual'}}:change));
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'dictation',text:'You can completely remove the, Apply for Community Garden Plan, And, The Library fundraiser tasks, And also the mosaic workshop, Actually you know what, Keep the mosaic workshop one, Yeah remove the community garden plan, And the Library fundraiser tasks, And every event associated with them,'});
  assert.ok(result.preview);
  const {draft}=result.preview;
  const keys=['delete:event:application-session','delete:event:hall-actual','delete:event:hall-session-a','delete:event:hall-session-b','delete:task:application','delete:task:hall-a','delete:task:hall-b'];
  assert.deepEqual(mutationKeys(draft.changes),keys);
  assert.deepEqual(db.snapshot(),before);
  assert.equal(requests.length,0);
  assert.deepEqual(mutationKeys(apply(draft,'apply').items??[]),keys);
  assert.deepEqual(db.snapshot().tasks,before.tasks.filter(item=>item.id==='new-age'));
  assert.deepEqual(db.snapshot().events,before.events.filter(item=>['age-session','unrelated'].includes(item.id)));
  const undo=await assistant.chat({requestId:'undo',text:'Undo that'});
  assert.ok(undo.preview);
  apply(undo.preview.draft,'apply-undo');
  assert.deepEqual(db.snapshot().tasks,before.tasks);
  assert.deepEqual(db.snapshot().events,before.events);
});

test('unpunctuated dictation resolves the saved spellings and the repeated task and event deletion',async t=>{
  const {assistant,db,apply,requests}=fixture(t,[
    task('application','Apply for Community Garden Plan'),task('hall','Library fundraiser'),task('age','Mosaic Workshop planning exercise'),
    event('application-session','Draft application','application'),event('hall-session','Library fundraiser','hall'),
    event('hall-prep','Prepare agenda','hall'),event('standalone-hall','Community fundraiser'),event('age-session','Mosaic Workshop session','age')
  ]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'dictated-repeat',text:'Remove the apply for community garden plan task and all its associated calendar event just delete them and do the same with the Library fundraiser task remove the calendar events for that as well just delete'});
  assert.ok(result.preview,result.content);
  const {draft}=result.preview;
  assert.deepEqual(mutationKeys(draft.changes),['delete:event:application-session','delete:event:hall-prep','delete:event:hall-session','delete:task:application','delete:task:hall']);
  assert.deepEqual(db.snapshot(),before);
  assert.equal(requests.length,0);
  apply(draft,'apply-repeat');
  assert.deepEqual(db.snapshot().tasks.map(item=>item.id),['age']);
  assert.deepEqual(db.snapshot().events.map(item=>item.id).sort(),['age-session','standalone-hall']);
  db.undo(db.revision);
  assert.deepEqual(db.snapshot().tasks,before.tasks);
  assert.deepEqual(db.snapshot().events,before.events);
});

const inference=(matches:unknown)=>({message:{role:'assistant',content:JSON.stringify({matches})}});
const permit=(clause:number,source:string,target:string)=>({clause,source,target});

test('grounded model matches resolve all paraphrased targets and exclusions before one deletion preview',async t=>{
  const paper='the task about turning in the scholarship paperwork';
  const hall='the task for organizing the quarterly planning discussion';
  const protectedEvent='the event about reviewing the quarterly planning packet';
  const {assistant,db,apply,requests}=fixture(t,[
    task('paper','Turn in scholarship application'),task('planning','Organize quarterly planning meeting'),
    event('packet','Review quarterly planning materials','planning'),event('other-planning','Find meeting room','planning'),
    event('standalone','Organize quarterly planning meeting')
  ],[inference([permit(1,paper,'task:paper'),permit(2,hall,'task:planning'),permit(3,protectedEvent,'event:packet')])]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'grounded',text:`Delete ${paper} and ${hall} and their linked calendar events, but keep ${protectedEvent}.`});
  assert.ok(result.preview,result.content);
  const {draft}=result.preview;
  assert.deepEqual(mutationKeys(draft.changes),['delete:event:other-planning','delete:task:paper','delete:task:planning','update:event:packet']);
  assert.equal(requests.length,1);
  assert.ok((requests[0] as {format?:unknown}).format);
  assert.deepEqual(db.snapshot(),before);
  apply(draft,'apply-grounded');
  assert.deepEqual(db.snapshot().events.map(item=>[item.id,item.linkedTaskId]).sort(),[['packet',null],['standalone',null]]);
  db.undo(db.revision);
  assert.deepEqual(db.snapshot().tasks,before.tasks);
  assert.deepEqual(db.snapshot().events,before.events);
});

test('incomplete, invented, or misassigned model evidence prevents a partial deletion preview',async t=>{
  const paper='the task about turning in the scholarship paperwork';
  const hall='the task for organizing the quarterly planning discussion';
  for(const [index,response] of [
    inference([permit(1,paper,'task:paper')]),
    inference([permit(1,'invented evidence','task:paper'),permit(2,hall,'task:planning')]),
    inference([permit(1,paper,'task:planning'),permit(2,hall,'task:paper')]),
    inference([permit(1,paper,'task:paper'),permit(2,hall,'event:standalone')]),
  ].entries()){
    const {assistant,db,requests}=fixture(t,[task('paper','Turn in scholarship application'),task('planning','Organize quarterly planning meeting'),event('standalone','Organize quarterly planning meeting')],[response]);
    const before=db.snapshot();
    const result=await assistant.chat({requestId:`bad-evidence-${index}`,text:`Delete ${paper} and ${hall}.`});
    assert.equal(result.preview,undefined);
    assert.equal(requests.length,1);
    assert.deepEqual(db.snapshot(),before);
  }
});

test('a model guess cannot break a tie or bypass an unfulfilled keep clause',async t=>{
  const paper='the task about turning in the scholarship paperwork';
  const {assistant,db,requests}=fixture(t,[task('paper','Turn in scholarship application'),task('other-paper','Turn in scholarship renewal'),task('known','Known')],[inference([permit(1,paper,'task:paper')])]);
  const before=db.snapshot();
  for(const [index,text] of [`Delete ${paper}.`,`Delete the Known task but keep ${paper}.`].entries()){
    const result=await assistant.chat({requestId:`tie-${index}`,text});
    assert.equal(result.preview,undefined);
    assert.deepEqual(db.snapshot(),before);
  }
  assert.equal(requests.length,0);
});

test('the model cannot reinterpret an unpunctuated correction or alternative as a target description',async t=>{
  for(const [index,source] of [
    'the task about turning in the scholarship paperwork wait actually keep it',
    'the task about requesting the campus grant rather than turning in the scholarship paperwork',
  ].entries()){
    const {assistant,db,requests}=fixture(t,[task('paper','Turn in scholarship application')],[inference([permit(1,source,'task:paper')])]);
    const before=db.snapshot();
    const result=await assistant.chat({requestId:`embedded-correction-${index}`,text:`Delete ${source}`});
    assert.equal(result.preview,undefined);
    assert.equal(requests.length,0);
    assert.deepEqual(db.snapshot(),before);
  }
});

test('a repeated task deletion inherits linked events only from the immediately preceding task deletion',async t=>{
  const {assistant}=fixture(t,[task('report','Report'),task('notes','Notes'),event('report-session','Review Report','report'),event('notes-session','Review Notes','notes')]);
  const result=await assistant.chat({requestId:'repeat-task-only',text:'Delete the calendar events for the Report task. Delete the Report task only and do the same with the Notes task.'});
  assert.ok(result.preview,result.content);
  assert.deepEqual(mutationKeys(result.preview.draft.changes),['delete:event:report-session','delete:task:notes','delete:task:report','update:event:notes-session']);
  assistant.dismissDraft({draftId:result.preview.draft.id,version:result.preview.draft.version});
  const unclear=await assistant.chat({requestId:'repeat-events-only',text:'Delete the Report task. Remove its linked events. Do the same with the Notes task.'});
  assert.equal(unclear.preview,undefined);
});

test('the requested type and selected card resolve collisions while task and event links retain their normal semantics',async t=>{
  const {assistant,db,apply}=fixture(t,[task('report','Report'),event('linked','Report','report'),event('unrelated','Report')]);
  const revision=db.revision;
  const removeEvent=await assistant.chat({requestId:'event-only',text:'Delete this event only',selection:{entity:'event',id:'linked',revision}});
  assert.ok(removeEvent.preview);
  assert.deepEqual(mutationKeys(removeEvent.preview.draft.changes),['delete:event:linked']);
  assert.equal(removeEvent.preview.draft.projectedSnapshot.tasks[0].id,'report');
  assistant.dismissDraft({draftId:removeEvent.preview.draft.id,version:removeEvent.preview.draft.version});
  const removeTask=await assistant.chat({requestId:'task-only',text:'Delete the Report task only'});
  assert.ok(removeTask.preview);
  assert.deepEqual(mutationKeys(removeTask.preview.draft.changes),['delete:task:report','update:event:linked']);
  apply(removeTask.preview.draft,'apply');
  assert.deepEqual(db.snapshot().events.map(item=>[item.id,item.linkedTaskId]).sort(),[['linked',null],['unrelated',null]]);
});

test('a missing or ambiguous deletion target prevents any partial preview',async t=>{
  const {assistant,db,events}=fixture(t,[task('known','Known'),task('twin-one','Twin'),task('twin-two','Twin'),task('similar','Known extended'),event('other-kind','Known')]);
  const before=db.snapshot();
  for(const [index,text] of ['Remove the Known task and the Missing task','Remove the Known task and the Twin task','Remove Known','Remove the Known task and keep the Missing task','Remove Known ext','Remove the Known task or the Known extended task','Delete the Known task, but do not delete','Delete the Known task and remove the','Delete the Known task, keep the, and delete the Known extended task'].entries()){
    const result=await assistant.chat({requestId:`ambiguous-${index}`,text});
    assert.equal(result.preview,undefined,text);
    assert.match(result.content,/which|find|match/i,text);
  }
  assert.equal(events.some(event=>event.type==='preview'),false);
  assert.deepEqual(db.snapshot(),before);
});

test('an unresolved deletion scope blocks an existing preview until the full request is clarified',async t=>{
  const {assistant,db,apply}=fixture(t,[task('known','Known'),task('twin-one','Twin'),task('twin-two','Twin'),task('other','Other'),event('twin-session','Twin work','twin-one')]);
  const before=db.snapshot();
  await assistant.chat({requestId:'delete-known',text:'Delete the Known task'});
  const ambiguous=await assistant.chat({requestId:'ambiguous-twin',text:'Delete the Twin task and its linked calendar events'});
  assert.match(ambiguous.content,/which one/i);
  const blocked=assistant.getDraft()!;
  assert.deepEqual(mutationKeys(blocked.changes),['delete:task:known']);
  assert.throws(()=>apply(blocked,'blocked-apply'),/questions/);
  assert.deepEqual(db.snapshot(),before);
  await assistant.chat({requestId:'independent-other',text:'Also delete the Other task'});
  const independent=assistant.getDraft()!;
  assert.equal(independent.unresolved[0]?.id,blocked.unresolved[0].id);
  assert.throws(()=>apply(independent,'still-blocked'),/questions/);
  await assistant.chat({requestId:'resolved-twin',text:'Delete this task',selection:{entity:'task',id:'twin-one',revision:before.revision}});
  const resolved=assistant.getDraft()!;
  assert.equal(resolved.unresolved.length,0);
  assert.deepEqual(mutationKeys(apply(resolved,'confirmed').items??[]),['delete:event:twin-session','delete:task:known','delete:task:other','delete:task:twin-one']);
  assert.deepEqual(db.snapshot().tasks.map(item=>item.id),['twin-two']);
});

test('negation protects its own item and a later explicit delete can reverse a keep',async t=>{
  const {assistant}=fixture(t,[task('report','Report'),task('notes','Notes'),event('session','Work session','report')]);
  const result=await assistant.chat({requestId:'negation',text:'Delete the Report task and the Notes task, but don’t delete the Notes task, and keep the Report task. Actually, delete the Report task.'});
  assert.ok(result.preview);
  assert.deepEqual(mutationKeys(result.preview.draft.changes),['delete:task:report','update:event:session']);
});

test('explicit keep clauses resolve nearby task and event references by stored links',async t=>{
  const {assistant}=fixture(t,[task('age','Mosaic Workshop'),event('age-session','Mosaic Workshop session','age'),task('hall','Library fundraiser tasks'),event('hall-session','Town hall session','hall'),event('hall-standalone','Community fundraiser'),task('application','Apply for Community Garden Plan'),event('application-session','Project session','application')]);
  const examples:[string,string[]][]=[
    ['Keep the Mosaic Workshop task and its session. Delete the Library fundraiser tasks and every session linked to those tasks; keep the standalone community fundraiser.',['delete:event:hall-session','delete:task:hall']],
    ['Do not delete the Mosaic Workshop task or its calendar session. Keep both. Delete only the Library fundraiser tasks and its linked session.',['delete:event:hall-session','delete:task:hall']],
    ['Delete the Mosaic Workshop task only. Keep its calendar session as an independent event.',['delete:task:age']],
    ['Delete the Mosaic Workshop session only. Keep the task.',['delete:event:age-session']],
    ['Delete the Community Garden Plan calendar session only. Keep the task.',['delete:event:application-session']],
  ];
  for(const [index,[text,expected]] of examples.entries()){
    const result=await assistant.chat({requestId:`scope-${index}`,text});
    assert.ok(result.preview,result.content);
    assert.deepEqual(mutationKeys(result.preview.draft.changes.filter(change=>change.action==='delete')),expected,text);
    assistant.dismissDraft({draftId:result.preview.draft.id,version:result.preview.draft.version});
  }
});

test('a fully specified mixed request previews its exact addition and deletions atomically without inference',async t=>{
  const {assistant,db,events,requests,apply}=fixture(t,[task('report','Report'),event('session','Work session','report'),event('unrelated','Report')]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'mixed',text:'Delete the Report task and every event associated with it, then add a task called Write agenda due 2026-11-12'});
  assert.ok(result.preview,result.content);
  const {draft}=result.preview;
  assert.deepEqual(mutationKeys(draft.changes.filter(change=>change.action==='delete')),['delete:event:session','delete:task:report']);
  assert.deepEqual(draft.projectedSnapshot.tasks.map(({title,dueDate})=>({title,dueDate})),[{title:'Write agenda',dueDate:'2026-11-12'}]);
  assert.deepEqual(draft.projectedSnapshot.events.map(item=>item.id),['unrelated']);
  assert.equal(events.filter(event=>event.type==='preview').length,1);
  assert.equal(requests.length,0);
  assert.deepEqual(db.snapshot(),before);
  apply(draft,'apply-mixed');
  assert.deepEqual(db.snapshot().events.map(item=>item.id),['unrelated']);
  db.undo(db.revision);
  assert.deepEqual(db.snapshot().tasks,before.tasks);
  assert.deepEqual(db.snapshot().events,before.events);
});

test('an unresolved addition prevents either half of a mixed deletion preview',async t=>{
  const {assistant,db,events,requests}=fixture(t,[task('report','Report')]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'missing-date',text:'Delete the Report task and add an event called Board meeting'});
  assert.equal(result.preview,undefined);
  assert.equal(events.some(event=>event.type==='preview'),false);
  assert.equal(requests.length,0);
  assert.deepEqual(db.snapshot(),before);
});

test('a model cannot introduce an unauthorized or malformed deletion into a creation request',async t=>{
  const create={action:'create',entity:'task',id:'new-item',title:'Write agenda'};
  const {assistant,db,events}=fixture(t,[task('report','Report'),event('unrelated','Report')],[
    tool('stage_changes',{changes:[create,del('event','unrelated')]}),
    tool('stage_changes',{changes:[create,{...del('task','report'),id:7}]}),
    tool('preview_changes',{}),
    finish()
  ]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'create-only',text:'Add a task called Write agenda with notes to bring the draft'});
  assert.equal(result.preview,undefined);
  assert.equal(events.some(event=>event.type==='preview'),false);
  assert.deepEqual(db.snapshot(),before);
});

test('including linked sessions for each task applies only to the two named tasks',async t=>{
  const {assistant,db,apply,requests}=fixture(t,[
    task('application','Apply for Community Garden Plan'),task('hall','Library fundraiser'),task('keep','Keep this'),
    event('application-session','Draft application','application'),event('hall-session','Prepare agenda','hall'),
    event('unrelated-hall','Community fundraiser'),event('keep-session','Other work','keep')
  ]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'including-each',text:'Delete both Apply for Community Garden Plan and Library fundraiser, including every calendar session linked to each task.'});
  assert.ok(result.preview,result.content);
  assert.equal(requests.length,0);
  assert.deepEqual(db.snapshot(),before);
  assert.deepEqual(mutationKeys(result.preview.draft.changes),['delete:event:application-session','delete:event:hall-session','delete:task:application','delete:task:hall']);
  apply(result.preview.draft,'apply-including-each');
  assert.deepEqual(db.snapshot().tasks.map(item=>item.id),['keep']);
  assert.deepEqual(db.snapshot().events.map(item=>item.id).sort(),['keep-session','unrelated-hall']);
});

test('both named tasks does not authorize all duplicate matches for one name',async t=>{
  const {assistant,db,requests}=fixture(t,[task('report-one','Report'),task('report-two','Report'),task('agenda','Agenda')]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'both-duplicate',text:'Delete both Report and Agenda, including every session linked to each task.'});
  assert.match(result.content,/several planner items matching/i);
  assert.equal(result.preview,undefined);
  assert.equal(requests.length,0);
  assert.deepEqual(db.snapshot(),before);
});
