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

function fixture(t:TestContext,changes:Change[],responses:ReturnType<typeof tool>[]=[]) {
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
    task('application','Apply for Community Garden Plan'),task('town-a','Library Board meeting'),task('town-b','Library Board meeting'),task('new-age','The Mosaic Workshop'),
    event('application-session','Draft application','application'),event('town-session-a','Find the room','town-a'),event('town-session-b','Make the agenda','town-b'),
    event('town-actual','Library Board rehearsal','town-b'),event('age-session','Read The Mosaic Workshop','new-age'),event('unrelated','Library Board meeting')
  ].map(change=>change.id==='town-actual'?{...change,fields:{...change.fields,kind:'actual'}}:change));
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'dictation',text:'You can remove Apply for Community Garden Plan and the Library Board meeting tasks and the Mosaic Workshop. Actually, keep the Mosaic Workshop. Remove Apply for Community Garden Plan and the Library Board meeting tasks and every event linked to them.'});
  assert.ok(result.preview);
  const {draft}=result.preview;
  const keys=['delete:event:application-session','delete:event:town-actual','delete:event:town-session-a','delete:event:town-session-b','delete:task:application','delete:task:town-a','delete:task:town-b'];
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
  const {assistant}=fixture(t,[task('age','Mosaic Workshop'),event('age-session','Mosaic Workshop session','age'),task('hall','Library Board meeting tasks'),event('hall-session','Library Board session','hall'),event('hall-standalone','Library Board meeting'),task('application','Apply for Community Garden Plan'),event('application-session','Project session','application')]);
  const examples:[string,string[]][]=[
    ['Keep the Mosaic Workshop task and its session. Delete the Library Board meeting tasks and every session linked to those tasks; keep the standalone Library Board meeting.',['delete:event:hall-session','delete:task:hall']],
    ['Do not delete the Mosaic Workshop task or its calendar session. Keep both. Delete only the Library Board meeting tasks and its linked session.',['delete:event:hall-session','delete:task:hall']],
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

test('mixed requests publish only after the complete authorized batch and strip echoed delete fields',async t=>{
  const remove=del('task','report'),removeSession=del('event','session');
  const create={action:'create',entity:'task',id:'new-item',title:'Write agenda'};
  const {assistant,db,events}=fixture(t,[task('report','Report'),event('session','Work session','report'),event('unrelated','Unrelated')],[
    tool('stage_changes',{changes:[{...remove,title:'Report',scheduledDate:'2026-11-10',fields:{dueDate:'2026-11-12'}},removeSession]}),
    tool('preview_changes',{}),
    tool('stage_changes',{changes:[create]}),
    tool('preview_changes',{}),
    finish()
  ]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'mixed',text:'Delete the Report task and every event associated with it, then add a task called Write agenda'});
  assert.ok(result.preview);
  assert.deepEqual(mutationKeys(result.preview.draft.changes.filter(change=>change.entity!=='category')),['create:task:new-item','delete:event:session','delete:task:report']);
  assert.deepEqual(result.preview.draft.changes.filter(change=>change.action==='delete').map(change=>change.fields??{}),[{},{}]);
  assert.equal(events.filter(event=>event.type==='preview').length,1);
  assert.deepEqual(db.snapshot(),before);
});

test('mixed requests reject malformed or unauthorized model delete identities and leave no partial preview',async t=>{
  const create={action:'create',entity:'task',id:'new-item',title:'Write agenda'};
  const {assistant,db,events}=fixture(t,[task('report','Report'),event('unrelated','Report')],[
    tool('stage_changes',{changes:[create,del('event','unrelated')]}),
    tool('stage_changes',{changes:[create,{...del('task','report'),id:7}]}),
    tool('preview_changes',{}),
    finish()
  ]);
  const before=db.snapshot();
  const result=await assistant.chat({requestId:'mixed',text:'Delete the Report task and add a task called Write agenda'});
  assert.equal(result.preview,undefined);
  assert.equal(events.some(event=>event.type==='preview'),false);
  assert.deepEqual(db.snapshot(),before);
});
