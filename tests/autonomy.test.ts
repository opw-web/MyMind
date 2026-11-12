import {chatAndApply} from './helpers/assistant';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';
import {authorizedActions} from '../src/main/capabilities';
import {todayIn} from '../src/shared/dates';

const answer=(content:string)=>({message:{role:'assistant',content}});
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
function setup(responses:any[]){
  const db=new PlannerDatabase(':memory:'),requests:any[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{requests.push(structuredClone(body));return responses.shift()??answer('No changes saved.');}} as unknown as OllamaRuntime;
  return {db,requests,assistant:new PlannerAssistant(db,runtime,()=>{})};
}

test('a planner request does not stop at an unnecessary confirmation',async()=>{
  const s=setup([answer('Would you like me to add those tasks?'),tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Read chapter 1'},{action:'create',entity:'task',title:'Review notes'}]}),answer('Does this sound good?'),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'Add tasks to read chapter 1 and review notes',requestId:'decisive'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,2);assert.ok(s.db.snapshot().tasks.every(t=>t.projectId==='inbox'&&t.dueDate===null));assert.equal(s.db.revision,1);s.db.undo();assert.equal(s.db.snapshot().tasks.length,0);}finally{s.db.close();}
});

test('unspecified task organization uses defaults instead of asking the user',async()=>{
  const s=setup([answer('Which project should I put these in?'),tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Call the dentist'},{action:'create',entity:'task',title:'Buy toothpaste'}]}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'I need to call the dentist and buy toothpaste',requestId:'natural-work'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,2);assert.ok(s.db.snapshot().tasks.every(t=>t.projectId==='inbox'));}finally{s.db.close();}
});

test('routine planning is actionable while hypothetical discussion stays read-only',()=>{
  for(const text of ['I need to finish my report','I have to call the dentist','Remember to buy notebooks','Help me break down my assignment into tasks','Can you plan my study tasks?'])assert.ok(authorizedActions(text).has('create'),text);
  assert.deepEqual([...authorizedActions('I need to complete my report')],['create']);
  assert.ok(authorizedActions('I want to take my car to the Hyundai Service Center. Add it to my task list, do not add it to the calendar yet.').has('create'));
  for(const text of ['I need to understand how to delete a task','Can I plan tasks here?','What if I need to finish my report?','Explain how to plan my study tasks','Do not add a task','Do I need to buy a printer?','Should I add a task to read this book?','Imagine I need to write a report.'])assert.equal(authorizedActions(text).size,0,text);
});


test('an unknown event date still asks a focused question and saves nothing',async()=>{
  const s=setup([answer('What date is your dentist appointment?')]);
  try{const result=await chatAndApply(s.assistant,{text:'Add a dentist appointment',requestId:'date-needed'});assert.equal(s.db.revision,0);assert.match(result.content,/What date/);assert.equal(s.requests.length,0);}finally{s.db.close();}
});

test('a dated event with no time does not require a time confirmation',async()=>{
  const s=setup([answer('I need to know the specific times for each exam to avoid conflicts. Could you tell me when the math exam and chemistry exam are scheduled?'),tool('stage_changes',{changes:[{action:'create',entity:'event',title:'Math exam',startDate:todayIn()},{action:'create',entity:'event',title:'Chemistry exam',startDate:todayIn()}]}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'Add a math exam and chemistry exam today',requestId:'untimed'});assert.ok(result.receipt);assert.equal(s.db.snapshot().events.length,2);assert.ok(s.db.snapshot().events.every(e=>e.startTime===null&&e.endTime===null));}finally{s.db.close();}
});

test('a genuinely missing requested project does not silently fall back to Inbox',async()=>{
  const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Revise chapter 1',projectTitle:'School'}]}),answer('Which project should I use? I cannot find School.')]);
  try{const result=await chatAndApply(s.assistant,{text:'Add a task to revise chapter 1 in my School project',requestId:'unknown-project'});assert.equal(s.db.revision,0);assert.match(result.content,/School/);}finally{s.db.close();}
});

test('Undo immediately restores the complete batch without another model decision',async()=>{
  const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',title:'First'},{action:'create',entity:'task',title:'Second'}]}),tool('preview_changes',{})]);
  try{await chatAndApply(s.assistant,{text:'Add First and Second to my tasks',requestId:'batch'});const calls=s.requests.length;const result=await chatAndApply(s.assistant,{text:'Undo that',requestId:'undo'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,0);assert.equal(s.requests.length,calls);assert.match(result.content,/Undo/i);}finally{s.db.close();}
});

test('Undo cannot overwrite a later manual planner edit',async()=>{
  const s=setup([]);
  try{await chatAndApply(s.assistant,{text:'Add a task called Buy notebooks',requestId:'create'});s.db.mutate({changes:[{action:'create',entity:'task',fields:{title:'Later manual task'}}],label:'Manual',expectedRevision:s.db.revision,requestId:'manual'});await assert.rejects(chatAndApply(s.assistant,{text:'Undo that',requestId:'stale-undo'}),/later change|revision|Refresh/i);assert.equal(s.db.snapshot().tasks.length,2);}finally{s.db.close();}
});

test('a model that keeps asking permission never invents a successful receipt',async()=>{
  const s=setup([answer('Should I add those tasks?'),answer('Would you like me to proceed?'),answer('Please confirm this change.')]);
  try{const result=await chatAndApply(s.assistant,{text:'Add a reading task and a writing task',requestId:'stubborn-model'});assert.equal(s.db.revision,0);assert.equal(result.receipt,undefined);assert.match(result.content,/No planner changes were saved/);assert.doesNotMatch(result.content,/confirm|clarify|\?/i);}finally{s.db.close();}
});

test('the model can add missing work to its draft before one atomic commit',async()=>{
  const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Connect LinkedIn to ChatGPT'},{action:'create',entity:'task',title:'Post on LinkedIn'}]}),tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Update LinkedIn profile'}]}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'I want to ensure LinkedIn is connected to ChatGPT. I want to post on LinkedIn. I also want to get my LinkedIn updated. Add those tasks without calendar dates.',requestId:'whole-workload'});assert.ok(result.receipt);assert.equal(s.db.revision,1);assert.equal(s.db.snapshot().tasks.length,3);assert.ok(s.requests.some(r=>r.messages.some((m:any)=>m.role==='tool'&&m.content.includes('draft'))));s.db.undo();assert.equal(s.db.snapshot().tasks.length,0);}finally{s.db.close();}
});



test('large tool chatter is compacted without losing the original request or saved notes',async()=>{
  const notes='n'.repeat(4000),text='Add tasks called First, Second, Third and Fourth with the supplied notes.';
  const s=setup([tool('stage_changes',{changes:['First','Second','Third','Fourth'].map(title=>({action:'create',entity:'task',title,notes}))}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text,requestId:'compact-draft'});assert.ok(result.receipt);assert.ok(s.db.snapshot().tasks.every(t=>t.notes===notes));assert.equal(s.db.snapshot().tasks.length,4);assert.ok(s.requests[1].messages.some((m:any)=>m.role==='user'&&m.content===text));assert.ok(s.requests[1].messages.some((m:any)=>m.content?.includes('Working planner state')));}finally{s.db.close();}
});

test('a prose claim of staging followed by Ready to commit must execute real tools',async()=>{
  const s=setup([answer('I have staged the tasks. Ready to commit these changes?'),tool('stage_changes',{changes:[{action:'create',entity:'task',title:'Read chapter 1'},{action:'create',entity:'task',title:'Review notes'}]}),tool('preview_changes',{})]);
  try{const result=await chatAndApply(s.assistant,{text:'Add reading chapter 1 and reviewing notes to my tasks',requestId:'ready-to-commit'});assert.ok(result.receipt);assert.equal(s.db.snapshot().tasks.length,2);assert.equal(s.db.revision,1);}finally{s.db.close();}
});
