import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';
function call(name:string,args:unknown){return {message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}};}
function setup(responses:any[]){const db=new PlannerDatabase(':memory:');let changed=0;const runtime={status:{state:'ready',context:4096},model:'test',call:async()=>responses.shift()??{message:{role:'assistant',content:'No changes saved.'}}} as unknown as OllamaRuntime;const assistant=new PlannerAssistant(db,runtime,()=>changed++);return {db,assistant,changed:()=>changed};}
test('assistant stages and commits a mixed request once, with a single Undo',async()=>{
  const {db,assistant,changed}=setup([call('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Exam',startDate:'2026-10-16'}},{action:'create',entity:'task',fields:{title:'Packaging',dueDate:'2026-10-10'}}]}),call('finish_request',{outcome:'apply',message:'Done'})]);try{
    const result=await assistant.chat({text:'Exam Friday and packaging tomorrow',requestId:'request-1'});assert.equal(result.receipt?.descriptions.length,2);assert.equal(changed(),1);assert.equal(db.snapshot().events.length,1);
    await assistant.chat({text:'Retry',requestId:'request-1'});assert.equal(db.snapshot().tasks.length,1);db.undo();assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().events.length,0);
  }finally{db.close();}
});
test('clarification discards a draft, and invalid arguments cannot save data',async()=>{
  const {db,assistant}=setup([call('stage_changes',{changes:[{action:'create',entity:'task',fields:{title:'Draft'}}]}),call('finish_request',{outcome:'clarify',message:'Which exam do you mean?'})]);try{const result=await assistant.chat({text:'Move it',requestId:'ambiguous'});assert.match(result.content,/Which exam/);assert.equal(db.snapshot().tasks.length,0);}finally{db.close();}
  const invalid=setup([call('stage_changes',{changes:[{action:'create',entity:'task',fields:{title:'Bad',dueDate:'tomorrow'}}]}),call('finish_request',{outcome:'clarify',message:'What date?'})]);try{await invalid.assistant.chat({text:'Add bad date',requestId:'invalid'});assert.equal(invalid.db.snapshot().tasks.length,0);}finally{invalid.db.close();}
});
test('assistant cancellation prevents committing a draft',async()=>{
  const db=new PlannerDatabase(':memory:');let release:(value:any)=>void=()=>{};const runtime={status:{state:'ready',context:4096},model:'test',call:()=>new Promise(resolve=>{release=resolve;})} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{});const pending=assistant.chat({text:'Add task',requestId:'cancel'});assistant.cancel();release(call('stage_changes',{changes:[{action:'create',entity:'task',fields:{title:'Should not exist'}}]}));await assert.rejects(pending,/cancelled/);assert.equal(db.snapshot().tasks.length,0);db.close();
});
test('duplicate titles require a qualifier even if the model chooses an ID',async()=>{
  const {db,assistant}=setup([call('find_items',{entity:'task',query:'Walls'}),call('stage_changes',{changes:[{action:'update',entity:'task',id:'walls-inbox',fields:{completed:true}}]})]);
  db.mutate({changes:[{action:'create',entity:'task',id:'walls-inbox',fields:{title:'Walls'}},{action:'create',entity:'project',id:'vip',fields:{title:'VIP'}},{action:'create',entity:'task',id:'walls-vip',fields:{title:'Walls',projectId:'vip'}}],label:'Fixture',requestId:'fixture',expectedRevision:0});
  try{const revision=db.revision;const result=await assistant.chat({text:'Mark Walls done',requestId:'ambiguous-id'});assert.match(result.content,/Which one/);assert.equal(db.revision,revision);assert.equal(db.snapshot().tasks.every(task=>!task.completed),true);}finally{db.close();}
});
