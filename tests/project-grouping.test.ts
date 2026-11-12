import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerAssistant} from '../src/main/assistant';
import {PlannerDatabase} from '../src/main/database';
import {OllamaRuntime} from '../src/main/ollama';
import {Change,Snapshot} from '../src/shared/model';
import {authorizedActions} from '../src/main/capabilities';
import {groupingChanges,projectGroupingIntent,resolveGroupingTasks,validateGrouping} from '../src/main/project-grouping';
import {todayIn} from '../src/shared/dates';

const exact='I want the 3 tasks in a project and I want to name the project VIP project.';
const calendarExact='the 3 events for today on the calendar are connected to 3 tasks, and i want the 3 tasks in a project and i want to name the project to be VIP project';
const mixedCalendar="There's a hackathon, Fetchathon 3.0 that's on 24th so add that to my calendar. i also have the Pre-seed Final Pitch on 24th so add that event as well. i have to submit my Pre-seed Final Pitch Deck by 24th, that's the deadline, put it in the VIP project, and i also have Submission Of Pitch Deck due on 20th which will also go in the VIP project";
const answer=(content:string)=>({message:{role:'assistant',content}});
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
function setup(responses:any[]=[]){
  const db=new PlannerDatabase(':memory:'),calls:any[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{calls.push(structuredClone(body));return responses.shift()??answer('Here are the requested items.');}} as unknown as OllamaRuntime;
  return {db,calls,assistant:new PlannerAssistant(db,runtime,()=>{})};
}
function save(db:PlannerDatabase,changes:Change[]){return db.mutate({changes,label:'Fixture',expectedRevision:db.revision,requestId:`fixture-${db.revision}`});}
function fixture(db:PlannerDatabase,n=3){
  save(db,[{action:'create',entity:'project',id:'old',fields:{title:'Original'}},{action:'create',entity:'section',id:'section',fields:{title:'Work',projectId:'old'}},
    ...Array.from({length:n},(_,i):Change=>({action:'create',entity:'task',id:`task-${i}`,fields:{title:`Work item ${i}`,notes:`Private notes ${i}`,textBox:'Free text',projectId:'old',sectionId:'section',scheduledDate:todayIn(),dueDate:todayIn(),steps:[{id:`step-${i}`,title:'Check outcome',completed:true}],dependsOnIds:i?['task-0']:[],completed:i===2}}))]);
}
function preserved(before:Snapshot,after:Snapshot,projectId:string){
  assert.deepEqual(after.events,before.events);
  assert.deepEqual(after.tasks,before.tasks.map(t=>({...t,projectId,sectionId:null})));
}

test('natural assignment wording authorizes writes without enabling questions or hypothetical changes',()=>{
  for(const text of [exact,'I want these tasks in a project.','Put those 3 tasks in a project called VIP project.','Move those events into VIP project.','Can you group these tasks into a project named Research?']){
    assert.ok(projectGroupingIntent(text),text);assert.ok(authorizedActions(text).has('update'),text);
  }
  for(const text of ['Why are these tasks in a project?','How do I put those tasks in a project called VIP project?','Do not put those tasks in a project called VIP project.','Can I move those tasks into VIP project?','What if I want these tasks in a project?','Imagine I want these tasks in a project.','I need to understand how to put those tasks in a project.']){
    assert.equal(projectGroupingIntent(text),undefined,text);assert.equal(authorizedActions(text).size,0,text);
  }
  assert.equal(projectGroupingIntent('Create a new project called Career with two separate tasks: first write a document, then update my profile.'),undefined);
  assert.equal(projectGroupingIntent(exact)?.title,'VIP project');
  assert.equal(projectGroupingIntent('Put those tasks into a project called Research and Development.')?.title,'Research and Development');
  assert.equal(projectGroupingIntent('Put those tasks into a project called Research and mark them complete.')?.requiresTools,true);
});

test('the exact request moves three linked tasks in one batch and preserves their events and fields',async()=>{
  const s=setup();try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show my events today',requestId:'lookup'});
    const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:exact,requestId:'group'}),after=s.db.snapshot();
    const project=after.projects.find(p=>p.title==='VIP project')!;
    assert.ok(result.receipt);assert.equal(after.revision,before.revision+1);assert.equal(after.tasks.length,3);assert.equal(after.events.length,3);
    preserved(before,after,project.id);assert.match(result.content,/Proposed moving 3 tasks into “VIP project”/);assert.equal(s.calls.length,1);
    assert.deepEqual((await chatAndApply(s.assistant,{text:exact,requestId:'group'})).receipt,result.receipt);assert.equal(s.db.revision,after.revision);
    await chatAndApply(s.assistant,{text:'Undo that',requestId:'undo'});assert.deepEqual(s.db.snapshot().tasks,before.tasks);assert.deepEqual(s.db.snapshot().events,before.events);assert.deepEqual(s.db.snapshot().projects,before.projects);
  }finally{s.db.close();}
});

test('a saved batch retains a group with both events and tasks without double-counting',async()=>{
  const s=setup([tool('stage_changes',{changes:Array.from({length:3},(_,i)=>[{action:'create',entity:'task',id:`saved-${i}`,title:`Saved work ${i}`},{action:'create',entity:'event',id:`session-${i}`,title:`Saved work ${i}`,startDate:todayIn(),kind:'planned',linkedTaskId:`saved-${i}`}]).flat()}),tool('preview_changes',{})]);
  try{
    await chatAndApply(s.assistant,{text:'Add three tasks Saved work 0, Saved work 1 and Saved work 2 to the calendar today.',requestId:'create'});
    const result=await chatAndApply(s.assistant,{text:'Put those three events into a project called Summer work.',requestId:'group'});
    assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,3);assert.equal(s.db.snapshot().events.length,3);assert.ok(s.db.snapshot().tasks.every(t=>t.projectId!=='inbox'));
  }finally{s.db.close();}
});

test('groups survive text history trimming and include records beyond catalog and search page limits',async()=>{
  const s=setup([tool('find_items',{entity:'event',query:'',limit:1}),answer('Found your events.')]);try{
    fixture(s.db,31);await chatAndApply(s.assistant,{text:'Show all events',requestId:'lookup'});
    // Force the same budget compaction used by long conversations; reference groups are separate.
    const internal=s.assistant as any;internal.turns=[];
    const result=await chatAndApply(s.assistant,{text:'Put those 31 tasks in a project called Large project.',requestId:'group'});
    assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.filter(t=>t.projectId!=='old').length,31);assert.equal(s.db.snapshot().events.length,31);
  }finally{s.db.close();}
});

test('direct named tasks outside the catalog can be grouped and a unique destination is reused',async()=>{
  const s=setup();try{
    fixture(s.db,25);save(s.db,[{action:'create',entity:'project',id:'vip',fields:{title:'VIP project'}}]);
    const result=await chatAndApply(s.assistant,{text:'Move Work item 23 and Work item 24 into VIP project.',requestId:'named'});
    assert.ok(result.receipt);assert.equal(s.db.snapshot().projects.filter(p=>p.title==='VIP project').length,1);
    assert.equal(s.db.snapshot().tasks.find(t=>t.id==='task-23')!.projectId,'vip');assert.equal(s.db.snapshot().tasks.find(t=>t.id==='task-24')!.projectId,'vip');
    assert.equal(s.db.snapshot().tasks.filter(t=>t.projectId==='old').length,23);
    const revision=s.db.revision;const again=await chatAndApply(s.assistant,{text:'Move Work item 23 and Work item 24 into VIP project.',requestId:'already'});
    assert.equal(again.receipt,undefined);assert.equal(s.db.revision,revision);assert.match(again.content,/already in/);
  }finally{s.db.close();}
});

test('unresolved references, count mismatches and unlinked events save nothing',async()=>{
  for(const kind of ['no-group','count','unlinked','deleted']){
    const s=setup();try{
      fixture(s.db);
      if(kind==='unlinked')save(s.db,[{action:'create',entity:'event',id:'standalone',fields:{title:'Meeting',startDate:todayIn()}}]);
      if(kind!=='no-group')await chatAndApply(s.assistant,{text:'Show my events today',requestId:'lookup'});
      if(kind==='deleted')save(s.db,[{action:'delete',entity:'task',id:'task-2'}]);
      const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:kind==='count'?'Put those 2 tasks into a project called VIP project.':exact,requestId:'group'});
      assert.equal(result.receipt,undefined,kind);assert.deepEqual(s.db.snapshot(),before,kind);assert.match(result.content,/Which|which/);
      if(kind==='unlinked')assert.match(result.content,/no linked task/);
    }finally{s.db.close();}
  }
});

test('two verified groups require clarification and an ordinal answer resumes the original request',async()=>{
  const s=setup([tool('find_items',{entity:'task',query:'Work item 0'}),tool('find_items',{entity:'task',query:'Work item 1'}),answer('Here are two groups.')]);
  try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show Work item 0 and Work item 1',requestId:'lookup'});
    const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:'Put those tasks in a project called VIP project.',requestId:'group'});
    assert.equal(result.receipt,undefined);assert.deepEqual(s.db.snapshot(),before);assert.match(result.content,/Which group/);
    assert.ok((await chatAndApply(s.assistant,{text:'the second group',requestId:'answer'})).receipt);
    assert.equal(s.db.snapshot().tasks.find(t=>t.id==='task-0')!.projectId,'old');assert.notEqual(s.db.snapshot().tasks.find(t=>t.id==='task-1')!.projectId,'old');
  }finally{s.db.close();}
});

test('duplicate destinations ask before saving and permit choosing a project by ordinal',async()=>{
  const s=setup();try{
    fixture(s.db);save(s.db,[{action:'create',entity:'project',id:'vip-one',fields:{title:'VIP project'}},{action:'create',entity:'project',id:'vip-two',fields:{title:'VIP project'}}]);
    await chatAndApply(s.assistant,{text:'Show my events today',requestId:'lookup'});const before=s.db.snapshot();
    const result=await chatAndApply(s.assistant,{text:exact,requestId:'duplicate'});assert.equal(result.receipt,undefined);assert.deepEqual(s.db.snapshot(),before);assert.match(result.content,/2 projects/);
    assert.ok((await chatAndApply(s.assistant,{text:'the second project',requestId:'choose'})).receipt);assert.ok(s.db.snapshot().tasks.every(t=>t.projectId==='vip-two'));
  }finally{s.db.close();}
});

test('missing destination name asks once and accepts a name without repeating the request',async()=>{
  const s=setup();try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show my tasks today',requestId:'lookup'});const before=s.db.snapshot();
    assert.match((await chatAndApply(s.assistant,{text:'I want these tasks in a project.',requestId:'no-title'})).content,/What should I name/);assert.deepEqual(s.db.snapshot(),before);
    const result=await chatAndApply(s.assistant,{text:'VIP project',requestId:'title'});assert.ok(result.receipt);assert.equal(s.db.snapshot().projects.at(-1)!.title,'VIP project');
  }finally{s.db.close();}
});

test('selected linked event resolves its task and New chat clears stored reference groups',async()=>{
  const s=setup();try{
    fixture(s.db);const before=s.db.snapshot(),event=before.events[0];
    assert.ok((await chatAndApply(s.assistant,{text:'Put it into a project called Selected project.',requestId:'selected',selection:{entity:'event',id:event.id,revision:before.revision}})).receipt);
    assert.equal(s.db.snapshot().tasks.filter(t=>t.projectId!=='old').length,1);
    await s.assistant.reset();const revision=s.db.revision;assert.equal((await chatAndApply(s.assistant,{text:exact,requestId:'after-reset'})).receipt,undefined);assert.equal(s.db.revision,revision);
  }finally{s.db.close();}
});

test('grouping validation rejects an incomplete or incorrect move before writing',()=>{
  const s=setup();try{
    fixture(s.db);const snapshot=s.db.snapshot(),batch=groupingChanges(snapshot,'VIP project',snapshot.tasks);assert.ok('changes'in batch);
    assert.throws(()=>validateGrouping(batch.changes.filter(c=>c.id!=='task-2'),snapshot.tasks,batch.projectId),/every referenced/);
    assert.throws(()=>validateGrouping([{action:'delete',entity:'task',id:'task-0'}],snapshot.tasks,batch.projectId),/every referenced/);
    const resolved=resolveGroupingTasks(projectGroupingIntent(exact)!,snapshot,[{turn:1,key:'mixed',records:[...snapshot.events.map(e=>({entity:'event' as const,id:e.id,linkedTaskId:e.linkedTaskId})),...snapshot.tasks.map(t=>({entity:'task' as const,id:t.id}))]}]);
    assert.ok('tasks'in resolved);assert.equal(resolved.tasks.length,3);assert.equal(s.db.revision,snapshot.revision);
  }finally{s.db.close();}
});

test('a count distinguishes a unique matching group and an empty lookup does not reuse an older group',async()=>{
  const s=setup([tool('find_items',{entity:'task',query:'Work item',limit:1}),tool('find_items',{entity:'task',query:'Work item 0'}),answer('Found both groups.')]);try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show my work groups',requestId:'lookup'});
    assert.ok((await chatAndApply(s.assistant,{text:exact,requestId:'count'})).receipt);
    await chatAndApply(s.assistant,{text:'Show my events tomorrow',requestId:'empty'});
    const revision=s.db.revision,result=await chatAndApply(s.assistant,{text:'Put those tasks in a project called Wrong project.',requestId:'empty-group'});
    assert.equal(result.receipt,undefined);assert.equal(s.db.revision,revision);assert.match(result.content,/Which existing tasks/);
  }finally{s.db.close();}
});

test('duplicate task names require a qualifier and can resolve a selected event or source project',async()=>{
  const s=setup();try{
    fixture(s.db);save(s.db,[{action:'create',entity:'task',id:'duplicate',fields:{title:'Work item 0'}}]);
    const before=s.db.snapshot();assert.equal((await chatAndApply(s.assistant,{text:'Move Work item 0 into VIP project.',requestId:'ambiguous'})).receipt,undefined);assert.deepEqual(s.db.snapshot(),before);
    const event=before.events.find(e=>e.linkedTaskId==='task-0')!;
    assert.ok((await chatAndApply(s.assistant,{text:'Move Work item 0 into VIP project.',requestId:'selected-name',selection:{entity:'event',id:event.id,revision:before.revision}})).receipt);
    assert.equal(s.db.snapshot().tasks.find(t=>t.id==='duplicate')!.projectId,'inbox');
    s.db.undo();
    assert.ok((await chatAndApply(s.assistant,{text:'Move Work item 0 from Original into VIP project.',requestId:'source-project'})).receipt);
    assert.equal(s.db.snapshot().tasks.find(t=>t.id==='duplicate')!.projectId,'inbox');
  }finally{s.db.close();}
});

test('unknown names never substitute a recent group or silently save only the matching subset',async()=>{
  const s=setup();try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show my events today',requestId:'lookup'});const before=s.db.snapshot();
    for(const text of ['Move Missing work into VIP project.','Move Work item 0 and Missing work into VIP project.']){
      const result=await chatAndApply(s.assistant,{text,requestId:text});assert.equal(result.receipt,undefined);assert.deepEqual(s.db.snapshot(),before);assert.match(result.content,/Which|which/);
    }
  }finally{s.db.close();}
});

test('a new read request is not mistaken for an answer to a pending grouping question',async()=>{
  const s=setup();try{
    fixture(s.db);await chatAndApply(s.assistant,{text:'Show my events today',requestId:'lookup'});
    await chatAndApply(s.assistant,{text:'I want these tasks in a project.',requestId:'name-needed'});
    const before=s.db.snapshot(),reply=await chatAndApply(s.assistant,{text:'Show my tasks today',requestId:'new-query'});
    assert.equal(reply.receipt,undefined);assert.deepEqual(s.db.snapshot(),before);assert.equal(s.calls.length,2);
    assert.ok((await chatAndApply(s.assistant,{text:exact,requestId:'new-group'})).receipt);
  }finally{s.db.close();}
});

test('moving a legacy scheduled task without a linked event does not create calendar work',async()=>{
  const s=setup();try{
    fixture(s.db);(s.db as any).db.prepare('DELETE FROM events').run();
    const before=s.db.snapshot();assert.ok((await chatAndApply(s.assistant,{text:'Move Work item 0 into VIP project.',requestId:'legacy'})).receipt);
    const after=s.db.snapshot();assert.deepEqual(after.events,before.events);assert.equal(after.tasks.find(t=>t.id==='task-0')!.scheduledDate,before.tasks[0].scheduledDate);
  }finally{s.db.close();}
});

test('the actual calendar request resolves today on the first turn and treats to be as naming grammar',async()=>{
  const s=setup();try{
    fixture(s.db);save(s.db,[{action:'create',entity:'task',id:'due-only',fields:{title:'Unscheduled work',dueDate:todayIn()}}]);
    assert.equal(projectGroupingIntent(calendarExact)!.title,'VIP project');
    const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:calendarExact,requestId:'first-turn'}),after=s.db.snapshot(),project=after.projects.find(p=>p.title==='VIP project')!;
    assert.ok(result.receipt);assert.equal(s.calls.length,0);assert.ok(project);assert.equal(after.tasks.filter(t=>t.projectId===project.id).length,3);
    assert.deepEqual(after.events,before.events);assert.equal(after.tasks.find(t=>t.id==='due-only')!.projectId,'inbox');assert.match(result.content,/Proposed moving 3 tasks/);
    const revision=s.db.revision,again=await chatAndApply(s.assistant,{text:calendarExact,requestId:'repeat-new-id'});assert.equal(again.receipt,undefined);assert.equal(s.db.revision,revision);assert.match(again.content,/already/);
  }finally{s.db.close();}
});

test('today calendar grouping does not ignore an unlinked event or a count mismatch',async()=>{
  for(const extra of [true,false]){
    const s=setup();try{
      fixture(s.db,extra?3:2);
      if(extra)save(s.db,[{action:'create',entity:'event',id:'meeting-today',fields:{title:'Meeting today',startDate:todayIn()}}]);
      const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:calendarExact,requestId:'ambiguous-day'});assert.equal(result.receipt,undefined);assert.deepEqual(s.db.snapshot(),before);assert.match(result.content,/Which|which/);
    }finally{s.db.close();}
  }
});

test('ordinary project saves acknowledge the receipt without another model request',async()=>{
  const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'project',title:'VIP project'}]}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'create a project called VIP project. you CAN do it',requestId:'project-create'});assert.ok(result.receipt);assert.equal(s.calls.length,2);assert.match(result.content,/VIP project/);assert.doesNotMatch(result.content,/could not finish|cannot|confirm/);}finally{s.db.close();}
});

test('a response failure after a saved edit reports the actual successful receipt',async()=>{
  const db=new PlannerDatabase(':memory:');let calls=0;
  const runtime={model:'test',status:{state:'ready',context:8192},call:async()=>{
    calls++;if(calls===1)return tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Read report'},{action:'create',entity:'task',title:'Review notes'}]});
    if(calls===2)return tool('preview_changes',{});throw new Error('Reply transport failed');
  }} as unknown as OllamaRuntime;
  try{const assistant=new PlannerAssistant(db,runtime,()=>{}),result=await chatAndApply(assistant,{text:'Add Read report and Review notes to my tasks.',requestId:'reply-failure'});assert.ok(result.receipt);assert.equal(db.snapshot().tasks.length,2);assert.match(result.content,/2 proposed changes/);assert.doesNotMatch(result.content,/could not finish/);}finally{db.close();}
});

test('new events and task deadlines with a project assignment reach the model instead of the grouping shortcut',async()=>{
  const s=setup([tool('stage_changes',{changes:[
    {action:'create',entity:'event',title:'Fetchathon 3.0',startDate:'2026-10-24'},
    {action:'create',entity:'event',title:'Pre-seed Final Pitch',startDate:'2026-10-24'},
    {action:'create',entity:'task',title:'Submit Pre-seed Final Pitch Deck',dueDate:'2026-10-24',projectTitle:'VIP project'},
    {action:'create',entity:'task',title:'Submission Of Pitch Deck',dueDate:'2026-10-20',projectTitle:'VIP project'}
  ]}),tool('preview_changes',{}),answer('Saved your two events and two task deadlines in VIP project.')]);
  try{
    save(s.db,[{action:'create',entity:'project',id:'vip',fields:{title:'VIP project'}}]);
    assert.equal(projectGroupingIntent(mixedCalendar)?.requiresTools,true);
    const result=await chatAndApply(s.assistant,{text:mixedCalendar,requestId:'mixed-new-work'}),state=s.db.snapshot();
    assert.ok(result.receipt);assert.ok(s.calls[0].tools.some((t:any)=>t.function.name==='stage_changes'));assert.equal(state.events.length,2);assert.equal(state.tasks.length,2);
    assert.ok(state.events.every(e=>e.startDate==='2026-10-24'&&e.linkedTaskId===null));
    assert.ok(state.tasks.every(t=>t.projectId==='vip'&&t.scheduledDate===null));assert.deepEqual(state.tasks.map(t=>t.dueDate),['2026-10-24','2026-10-20']);
  }finally{s.db.close();}
});

test('project references inside new work do not turn that work into a move of old records',()=>{
  for(const text of ['I need to submit my report by Friday, put it in the VIP project.','Add a meeting tomorrow and put these tasks in a project called Work.','Change the deadline on those tasks and move them into VIP project.','Finish my pitch deck by Friday, put it in the VIP project.'])assert.equal(projectGroupingIntent(text)?.requiresTools,true,text);
  assert.equal(projectGroupingIntent(calendarExact)?.requiresTools,undefined);
});
