import {chatAndApply} from './helpers/assistant';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';

test('messages above 4000 characters fit, remain complete, and preflight is read-only',async()=>{
  const db=new PlannerDatabase(':memory:'),requests:any[]=[],events:any[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{requests.push(body);return {message:{role:'assistant',content:'Here are some ideas.'}};}} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{},event=>events.push(event));
  try{
    const text='Please discuss these ideas. '+ 'Thoughts about time and attention. '.repeat(140);
    assert.ok(text.length>4000);
    const before=db.snapshot();
    assert.deepEqual(assistant.checkInput({text}),{fits:true});
    assert.deepEqual(db.snapshot(),before);assert.equal(events.length,0);assert.equal(requests.length,0);
    await chatAndApply(assistant,{text,requestId:'long-message'});
    assert.equal(requests[0].messages.find((message:any)=>message.role==='user').content,text.trim());
    assert.deepEqual(db.snapshot(),before);
  }finally{db.close();}
});

test('oversized actions fail in preflight and authoritative processing before any mutation',async()=>{
  const db=new PlannerDatabase(':memory:'),requests:any[]=[];
  const runtime={model:'test',status:{state:'ready',context:8192},call:async()=>{requests.push(true);throw new Error('Unexpected model call');}} as unknown as OllamaRuntime;
  const assistant=new PlannerAssistant(db,runtime,()=>{});
  try{
    const text='Add a task called Homework. '+ 'Please consider all of these details. '.repeat(1500);
    const before=db.snapshot(),check=assistant.checkInput({text});
    assert.equal(check.fits,false);assert.match(check.message!,/split/i);
    await assert.rejects(chatAndApply(assistant,{text,requestId:'oversized-action'}),/split/i);
    assert.deepEqual(db.snapshot(),before);assert.equal(requests.length,0);
    assert.deepEqual(assistant.checkInput({text:'Hello'}),{fits:true});
  }finally{db.close();}
});
