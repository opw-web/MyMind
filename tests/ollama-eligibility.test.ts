import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OllamaRuntime} from '../src/main/ollama';

test('only installed local library weights with completion and tools are listed or configurable',async()=>{
 const names=['qwen3.5:9b','hf.co/me/tools:latest','ordinary-name:latest','embed:latest','broken:latest','missing-weights:latest','tools-only:latest','tag-remote:latest'];
 const server=createServer((req,res)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{const model=raw?JSON.parse(raw).model:'';res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/tags'?{models:names.map(name=>({name,size:name.startsWith('missing')?0:5000,details:{format:'gguf'},...(name==='tag-remote:latest'?{remote_model:'remote-weights',remote_host:'https://ollama.com'}:{})}))}:model==='broken:latest'?{error:'Cannot read model metadata'}:{capabilities:model==='embed:latest'?['embedding']:model==='tools-only:latest'?['tools']:['completion','tools'],details:{format:'gguf'},...(model==='ordinary-name:latest'?{remote_host:'https://ollama.com',remote_model:'remote'}:{})}));});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const runtime=new OllamaRuntime(()=>{},{model:'qwen3.5:9b',context:16384});runtime.status={...runtime.status,state:'error',port:(server.address() as any).port};
 try{assert.deepEqual((await runtime.settings()).models,['qwen3.5:9b']);for(const model of [...names.slice(1),'not-installed:latest'])await assert.rejects(runtime.configure({model,context:4096}),/local|installed|metadata|completion|library/i);assert.equal(runtime.model,'qwen3.5:9b');}finally{runtime.stop();await new Promise<void>(r=>server.close(()=>r()));}
});

test('refresh distinguishes a loaded model from an empty runner list and reports the runner context',async()=>{
 let running:{name:string;context_length:number}[]=[{name:'local:latest',context_length:8192}];
 const runtime=new OllamaRuntime(()=>{},{model:'local:latest',context:16384});
 runtime.status={...runtime.status,state:'ready'};
 runtime.call=async route=>route==='ps'?{models:running}:route==='tags'?{models:[{name:'local:latest',size:1}]}:{capabilities:['tools','completion'],details:{format:'gguf'}};
 assert.equal((await runtime.settings()).activeContext,8192);
 running=[];
 assert.equal((await runtime.settings()).activeContext,null);
});
