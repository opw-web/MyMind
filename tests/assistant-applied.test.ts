import assert from 'node:assert/strict';
import {test,TestContext} from 'node:test';
import {PlannerAssistant} from '../src/main/assistant';
import {PlannerDatabase} from '../src/main/database';
import {OllamaRuntime} from '../src/main/ollama';
import {ChatEvent,ChatInput} from '../src/shared/model';

const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const stage=tool('stage_changes',{changes:[
  {action:'create',entity:'task',title:'Verify packaging'},
  {action:'create',entity:'event',title:'Packaging review',startDate:'2026-12-05'}
]});
const request:ChatInput={text:'Add a task to verify packaging and schedule a packaging review on 2026-12-05',requestId:'rant'};
const finish=(outcome:string,message:string)=>tool('finish_request',{outcome,message});

function setup(t:TestContext,call:()=>Promise<unknown>){
  const db=new PlannerDatabase(':memory:');
  t.after(()=>db.close());
  const events:ChatEvent[]=[];
  const runtime={status:{state:'ready',context:8192},model:'test',call} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{},event=>events.push(event));
  const send=(input=request)=>{
    db.beginChat(input);
    return assistant.chatApplied(input);
  };
  return {db,assistant,events,send};
}

test('one completed rant saves a single receipt and undo entry',async t=>{
  const responses=[stage,finish('apply','The complete plan is ready.')];
  const {db,events,send}=setup(t,async()=>responses.shift());
  const result=await send();
  assert.ok(result.receipt);
  assert.equal(db.snapshot().tasks.length,1);
  assert.equal(db.snapshot().events.length,1);
  assert.equal(events.filter(event=>event.type==='receipt').length,1);
  assert.equal(events.some(event=>event.type==='preview'||event.type==='draftchange'),false);
  assert.equal(db.chatResult(request.requestId)?.content,result.content);
  db.undo();
  assert.equal(db.snapshot().tasks.length,0);
  assert.equal(db.snapshot().events.length,0);
});

test('a dictated task list saves only after Ollama stages and applies the batch',async t=>{
  const titles=['Class participation email','WOCO card email','Art case 7elements worksheet',
    'Job negotiations 7elements worksheet','layerling first design'];
  let modelCalls=0;
  const {db,send}=setup(t,async()=>{
    assert.equal(db.revision,0);
    return ++modelCalls===1?tool('stage_changes',{changes:titles.map(title=>({action:'create',entity:'task',title}))}):finish('apply','The list is ready.');
  });
  const result=await send({requestId:'dictated-list',text:`I have these tasks- ${titles.join(', ')}`});
  assert.equal(modelCalls,2);
  assert.equal(db.revision,1);
  assert.deepEqual(db.snapshot().tasks.map(task=>task.title),titles);
  assert.ok(db.snapshot().tasks.every(task=>task.projectId==='inbox'&&task.dueDate===null));
  assert.equal(db.snapshot().events.length,0);
  assert.equal(result.receipt?.actions?.length,titles.length);
});

test('a question about a supplied task list stays read-only',async t=>{
  const {db,send}=setup(t,async()=>finish('no_change','Start with the email.'));
  const result=await send({requestId:'list-advice',text:'I have these tasks: Class participation email, WOCO card email. Which should I do first?'});
  assert.equal(result.receipt,undefined);
  assert.equal(db.revision,0);
});

test('an explicit no-change outcome discards a staged batch',async t=>{
  const responses=[stage,finish('no_change','I left your planner as it was.')];
  const {db,assistant,events,send}=setup(t,async()=>responses.shift());
  const result=await send();
  assert.equal(result.receipt,undefined);
  assert.equal(result.preview,undefined);
  assert.equal(db.revision,0);
  assert.equal(assistant.drafts.getDraft(),null);
  assert.equal(events.some(event=>event.type==='progress'&&event.stage==='saving'),false);
});

test('the model must finish staged work itself instead of asking for approval',async t=>{
  const responses=[stage,finish('clarification','Would you like me to save these tasks now?'),finish('apply','The batch is ready.')];
  const {db,send}=setup(t,async()=>{assert.equal(db.revision,0);return responses.shift();});
  const result=await send();
  assert.equal(responses.length,0);
  assert.ok(result.receipt);
  assert.equal(db.revision,1);
});

test('an invalid action prevents the complete batch from saving',async t=>{
  const responses=[
    tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Verify packaging'},
      {action:'create',entity:'event',title:'Packaging review',startDate:'not-a-date'}]}),
    finish('apply','The complete plan is ready.')
  ];
  const {db,send}=setup(t,async()=>responses.shift()??finish('no_change','No changes saved.'));
  const result=await send({...request,text:'Add a task called Verify packaging and add an event called Packaging review on 2026-12-05'});
  assert.equal(result.receipt,undefined);
  assert.equal(db.revision,0);
});

test('stop after staging prevents late terminal success from saving',async t=>{
  let release:((value:unknown)=>void)|undefined,waiting:()=>void=()=>{};
  const secondRequest=new Promise<void>(resolve=>{waiting=resolve;});
  let modelCalls=0;
  const {db,assistant,events,send}=setup(t,async()=>{
    if(++modelCalls===1)return stage;
    return new Promise(resolve=>{release=resolve;waiting();});
  });
  const pending=send();
  await secondRequest;
  assistant.cancel();
  release?.(finish('apply','The plan is ready.'));
  await assert.rejects(pending,/stopped/i);
  assert.equal(db.revision,0);
  assert.equal(assistant.drafts.getDraft(),null);
  assert.equal(events.some(event=>event.type==='receipt'),false);
});

test('a required date holds the entire rant until the answer completes it',async t=>{
  const responses=[
    tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Verify packaging'}]}),
    finish('clarification','What date should I use for the packaging review?'),
    stage,
    finish('apply','The complete plan is ready.')
  ];
  const {db,assistant,send}=setup(t,async()=>responses.shift());
  const clarification=await send({...request,text:'Add a task to verify packaging and schedule a packaging review'});
  assert.match(clarification.content,/what date/i);
  assert.equal(clarification.receipt,undefined);
  assert.equal(assistant.getDraft(),null);
  assert.equal(db.revision,0);
  const result=await send({requestId:'answer',text:'2026-12-05'});
  assert.ok(result.receipt);
  assert.equal(db.snapshot().events.length,1);
  assert.equal(db.snapshot().tasks.length,1);
  assert.equal(db.revision,1);
});

test('a failed inference after staging leaves no partial edits',async t=>{
  let calls=0;
  const {db,assistant,send}=setup(t,async()=>{
    if(++calls===1)return stage;
    throw new Error('Model service disconnected');
  });
  await assert.rejects(send(),/disconnected/);
  assert.equal(db.revision,0);
  assert.equal(assistant.drafts.getDraft(),null);
});

test('a saved change during inference prevents applying a staged rant',async t=>{
  let calls=0;
  const {db,assistant,send}=setup(t,async()=>{
    if(++calls===1)return stage;
    if(calls===2){
      db.mutate({requestId:'manual',label:'Manual edit',expectedRevision:0,changes:[{action:'create',entity:'task',fields:{title:'Manual task'}}]});
      return finish('apply','The complete plan is ready.');
    }
    throw new Error('Planner changed');
  });
  await assert.rejects(send(),/changed/);
  assert.equal(db.revision,1);
  assert.deepEqual(db.snapshot().tasks.map(task=>task.title),['Manual task']);
  assert.equal(assistant.drafts.getDraft(),null);
});

test('navigation comes from an Ollama tool call',async t=>{
  let calls=0;
  const {db,send}=setup(t,async()=>{calls++;return tool('finish_request',{
    outcome:'no_change',message:'Opened the date.',viewActions:[{type:'date',date:'2026-12-05'}],
  });});
  const result=await send({text:'Jump to 2026-12-05',requestId:'show-date'});
  assert.equal(calls,1);
  assert.deepEqual(result.viewActions,[{type:'date',date:'2026-12-05'}]);
  assert.equal(db.revision,0);
});

test('a mixed Ollama batch saves the exact schedule, deadlines and relationships it staged',async t=>{
  const responses=[tool('stage_changes',{changes:[
    {action:'create',entity:'project',id:'launch',title:'Release planning'},
    {action:'create',entity:'task',title:'Prepare the release notes',projectId:'launch'},
    {action:'create',entity:'task',title:'Buy groceries',dueDate:'2026-12-10'},
    {action:'create',entity:'event',title:'Release review',startDate:'2026-12-09',startTime:'10:00',endTime:'11:00'},
  ]}),finish('apply','The complete plan is ready.')];
  const {db,send}=setup(t,async()=>responses.shift()??finish('no_change','No changes saved.'));
  db.seedBloomCategories();
  const result=await send({...request,text:'Create a project called Release planning. In that project add a task called Prepare the release notes. Also add a standalone task called Buy groceries due 2026-12-10. Schedule a block called Release review on December 9th from 10am to 11am.'});
  const saved=db.snapshot();
  assert.equal(saved.events.length,1);
  assert.equal(saved.categories.length,6);
  assert.equal(saved.tasks.find(task=>task.title==='Prepare the release notes')?.dueDate,null);
  assert.equal(saved.tasks.find(task=>task.title==='Buy groceries')?.projectId,'inbox');
  assert.equal(result.receipt?.actions?.length,4);
});

test('familiar action wording cannot mutate the planner without a model tool call',async t=>{
  const {db,send}=setup(t,async()=>finish('no_change','No planner changes.'));
  for(const [index,text] of ['Add a task called Buy paper.','I spent the last 45 minutes replying to emails.',
    'Delete the task called Buy paper.','Jump to tomorrow'].entries()){
    const result=await send({text,requestId:`no-tool-${index}`});
    assert.equal(result.receipt,undefined);
    assert.equal(result.viewActions,undefined);
    assert.equal(db.revision,0);
  }
});

test('a verified deletion only applies after Ollama requests it',async t=>{
  const responses=[tool('find_items',{entity:'task',query:'Buy paper'}),
    tool('stage_changes',{changes:[{action:'delete',entity:'task',id:'paper'}]}),finish('apply','Removed Buy paper.')];
  const {db,send}=setup(t,async()=>responses.shift());
  db.mutate({requestId:'seed',label:'Seed',expectedRevision:0,changes:[{entity:'task',action:'create',id:'paper',fields:{title:'Buy paper'}}]});
  const result=await send({text:'Delete the task called Buy paper.',requestId:'delete'});
  assert.equal(responses.length,0);
  assert.equal(result.receipt?.actions?.[0].action,'delete');
  assert.equal(db.snapshot().tasks.length,0);
});
