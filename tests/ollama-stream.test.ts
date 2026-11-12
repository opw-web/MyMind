import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OllamaRuntime} from '../src/main/ollama';

test('fresh settings use the installed Qwen 4B profile with a 32K context',()=>{
  const runtime=new OllamaRuntime(()=>{});
  try{
    assert.equal(runtime.model,process.env.MYMIND_MODEL||'qwen3.5:4b');
    assert.equal(runtime.modelOptions.num_ctx,32768);
    assert.equal(runtime.status.context,32768);
  }finally{runtime.stop();}
});

test('Ollama streams reasoning internally while retaining complete tool calls and exposing only answer text',async()=>{
  let request:any;
  const server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{request=JSON.parse(body);res.writeHead(200,{'content-type':'application/x-ndjson'});for(const item of [{message:{role:'assistant',thinking:'Internal reasoning fragment.'}},{message:{role:'assistant',content:'A concise answer.'}},{message:{role:'assistant',tool_calls:[{function:{name:'stage_tasks',arguments:{tasks:[]}}}]}},{done:true,eval_count:12}])res.write(JSON.stringify(item)+'\n');res.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,runtime=new OllamaRuntime(()=>{}),visible:string[]=[];
  runtime.status={...runtime.status,state:'ready',port};
  try{const result=await runtime.streamChat({model:runtime.model,messages:[{role:'user',content:'Test'}],think:true,stream:false},new AbortController().signal,text=>visible.push(text));assert.equal(request.stream,true);assert.equal(request.think,true);assert.deepEqual(visible,['A concise answer.']);assert.equal(result.message.thinking,'Internal reasoning fragment.');assert.equal(result.message.tool_calls[0].function.name,'stage_tasks');assert.equal(result.eval_count,12);}finally{runtime.stop();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});


test('settings refresh reports installed models and actual loaded context rather than requested context',async()=>{
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/tags'?{models:[{name:'qwen3.5:9b',size:5000},{name:'other:latest',size:5000}]}:req.url==='/api/show'?{capabilities:['completion','tools'],details:{format:'gguf'}}:{models:[{name:'other:latest',context_length:32768,size:100,size_vram:100}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime=new OllamaRuntime(()=>{},{model:'other:latest',context:65536});
  runtime.status={...runtime.status,state:'ready',port:(server.address() as {port:number}).port};
  try{const settings=await runtime.settings();assert.equal(settings.model,'other:latest');assert.equal(settings.context,65536);assert.equal(settings.activeContext,32768);assert.equal(runtime.status.context,32768);assert.deepEqual(settings.models,['qwen3.5:9b','other:latest']);}
  finally{runtime.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('saved settings configure the model and request context consistently',()=>{
  const runtime=new OllamaRuntime(()=>{},{model:'custom:latest',context:131072});
  assert.equal(runtime.model,'custom:latest');assert.equal(runtime.modelOptions.num_ctx,131072);assert.equal(runtime.status.context,131072);assert.equal(runtime.status.model,'custom:latest');runtime.stop();
});
