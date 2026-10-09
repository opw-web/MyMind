import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';
test('separate model stages accumulate and repeated stages do not duplicate creates',async()=>{
  const db=new PlannerDatabase(':memory:');db.mutate({changes:[{action:'create',entity:'task',id:'cornhole',fields:{title:'Cornhole'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});
  const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
  const create={changes:[{action:'create',entity:'task',fields:{title:'Packaging',dueDate:'2026-10-10'}}]};
  const responses=[tool('find_items',{entity:'task',query:'Cornhole'}),tool('stage_changes',{changes:[{action:'update',entity:'task',id:'cornhole',fields:{completed:true}}]}),tool('stage_changes',create),tool('stage_changes',create),tool('finish_request',{outcome:'apply',message:'Done'})];
  const runtime={model:'test',status:{state:'ready',context:4096},call:async()=>responses.shift()} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{});
  try{await assistant.chat({text:'Complete Cornhole and add packaging',requestId:'mixed'});const snapshot=db.snapshot();assert.equal(snapshot.tasks.length,2);assert.equal(snapshot.tasks.find(t=>t.id==='cornhole')!.completed,true);db.undo();assert.equal(db.snapshot().tasks.length,1);assert.equal(db.snapshot().tasks[0].completed,false);}finally{db.close();}
});
