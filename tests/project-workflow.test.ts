import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerAssistant} from '../src/main/assistant';
import {PlannerDatabase} from '../src/main/database';
import {OllamaRuntime} from '../src/main/ollama';
import {projectWorkflowChanges,requestsProjectWorkflow,requestsNewProject} from '../src/main/project-workflow';
import {authorizedActions} from '../src/main/capabilities';

export const communityPrompt="so new project, this is about my community newsletter. i need to first draft an editorial plan covering the intended audience and future topics. after making this plan only ill be able to then review the publishing platform content guide. thaen ill update the newsletter page accordingly. then ill make my first newsletter issue.";
const workflow={projectTitle:'Community Newsletter',taskTitle:'Plan the community newsletter launch',categoryTitle:'Community Newsletter',steps:[
  {title:'Draft an editorial plan covering the intended audience and future topics',source:'draft an editorial plan'},
  {title:"Review the publishing platform content guide using the editorial plan",source:"review the publishing platform content guide"},
  {title:'Update the newsletter page accordingly',source:'update the newsletter page accordingly'},
  {title:'Make my first newsletter issue',source:'make my first newsletter issue'}
]};
const answer=(value:unknown)=>({message:{role:'assistant',content:JSON.stringify(value)}});
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
function setup(responses:any[]){
  const db=new PlannerDatabase(':memory:'),calls:any[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{calls.push(structuredClone(body));return responses.shift()??{message:{role:'assistant',content:'Saved.'}};}} as unknown as OllamaRuntime;
  return {db,calls,assistant:new PlannerAssistant(db,runtime,()=>{})};
}

test('the original community newsletter prompt creates a project with one task and all four supplied steps',async()=>{
  const s=setup([answer(workflow)]);
  try{
    const before=s.db.snapshot(),result=await chatAndApply(s.assistant,{text:communityPrompt,requestId:'community newsletter'}),state=s.db.snapshot();
    const project=state.projects.find(p=>p.title==='Community Newsletter')!,task=state.tasks[0];
    assert.ok(result.receipt);assert.ok(project);assert.equal(state.projects.length,before.projects.length+1);assert.equal(state.tasks.length,1);
    assert.equal(task.projectId,project.id);assert.equal(task.title,workflow.taskTitle);assert.deepEqual(task.steps.map(step=>step.title),workflow.steps.map(step=>step.title));
    assert.deepEqual(task.dependsOnIds,[]);assert.equal(task.dueDate,null);assert.equal(task.scheduledDate,null);assert.equal(state.events.length,0);assert.equal(task.notes,communityPrompt);
    assert.equal(new Set(task.steps.map(step=>step.id)).size,4);assert.match(result.content,/Proposed “Community Newsletter”/);assert.match(result.content,/4 ordered steps/);
    assert.equal(s.calls.length,1);assert.ok(s.calls[0].format);
    const replay=await chatAndApply(s.assistant,{text:communityPrompt,requestId:'community newsletter'});assert.deepEqual(replay.receipt,result.receipt);assert.equal(s.db.revision,1);
    s.db.undo();assert.deepEqual(s.db.snapshot().tasks,before.tasks);assert.deepEqual(s.db.snapshot().projects,before.projects);
  }finally{s.db.close();}
});

test('new project sequences also retain their structure above the long-workload threshold',async()=>{
  const text=communityPrompt+' Background: '+'My community newsletter history includes several roles and accomplishments. '.repeat(20),s=setup([answer(workflow)]);
  try{assert.ok((await chatAndApply(s.assistant,{text,requestId:'long-project'})).receipt);assert.equal(s.db.snapshot().tasks.length,1);assert.equal(s.db.snapshot().tasks[0].steps.length,4);}finally{s.db.close();}
});

test('fabricated or reordered steps are repaired before any planner writes',async()=>{
  const s=setup([answer({...workflow,steps:[workflow.steps[1],workflow.steps[0]]}),answer(workflow)]);
  try{assert.ok((await chatAndApply(s.assistant,{text:communityPrompt,requestId:'repair'})).receipt);assert.equal(s.calls.length,2);assert.equal(s.db.revision,1);assert.equal(s.db.snapshot().tasks[0].steps.length,4);
    assert.throws(()=>projectWorkflowChanges({...workflow,steps:[workflow.steps[0],{title:'Invented action',source:'order event supplies'}]},communityPrompt),/verbatim/);
    assert.throws(()=>projectWorkflowChanges({...workflow,steps:workflow.steps.slice(0,3)},communityPrompt),/first newsletter issue/);
  }finally{s.db.close();}
});

test('explicit separate tasks keep their prerequisites and must belong to the requested project',async()=>{
  const s=setup([
    tool('stage_changes',{changes:[{action:'create',entity:'task',id:'document',title:'Write document'},{action:'create',entity:'task',id:'profile',title:'Update page',dependsOnIds:['document']}]}),
    tool('preview_changes',{}),
    tool('stage_changes',{changes:[{action:'create',entity:'project',id:'community newsletter',title:'Community Newsletter'},{action:'update',entity:'task',id:'document',projectId:'community newsletter'},{action:'update',entity:'task',id:'profile',projectId:'community newsletter'}]}),
    tool('preview_changes',{})
  ]);
  try{
    const text='Create a new project called Community Newsletter with two separate tasks: first write a document, then update my profile after the document.';
    assert.equal(requestsProjectWorkflow(text),false);assert.ok((await chatAndApply(s.assistant,{text,requestId:'separate'})).receipt);
    const state=s.db.snapshot();assert.equal(state.tasks.length,2);assert.ok(state.tasks.every(t=>t.projectId==='community newsletter'));assert.deepEqual(state.tasks.find(t=>t.id==='profile')!.dependsOnIds,['document']);
    assert.ok(s.calls.some(call=>call.messages.some((message:any)=>message.role==='tool'&&message.content.includes('requires a new project'))));
    assert.equal(s.db.revision,1);
  }finally{s.db.close();}
});

test('ordinary workloads, project questions and requests without steps do not opt into workflow extraction',()=>{
  assert.equal(requestsProjectWorkflow('First write a document, then update my profile.'),false);
  assert.equal(requestsProjectWorkflow('Create a new project. First write a document, then update my profile, without steps.'),false);
  assert.equal(requestsNewProject('Do not create a new project.'),false);
  assert.equal(requestsNewProject('Why did you create a new project?'),false);
  assert.equal(requestsNewProject('Update my new project notes.'),false);
  assert.equal(authorizedActions('Can I create a new project?').size,0);
  assert.equal(requestsNewProject('I need to make a project brief.'),false);
  assert.equal(requestsProjectWorkflow("Start a new project. First research courses then enroll, but don't add checklist steps."),false);
  assert.equal(authorizedActions('so new project, this is about my community newsletter.').has('create'),true);
});
