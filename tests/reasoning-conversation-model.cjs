const assert=require('node:assert/strict'),fs=require('node:fs');
const {PlannerDatabase}=require('../dist/main/database'),{PlannerAssistant}=require('../dist/main/assistant'),{OllamaRuntime}=require('../dist/main/ollama');
const fixture=require('./reasoning-conversation-fixture.cjs');
const check=require('./reasoning-conversation-assertions.cjs');
// Observe transport progress without logging internal reasoning text.
const nativeFetch=global.fetch;let inference=0;
global.fetch=async(...args)=>{const response=await nativeFetch(...args);if(!String(args[0]).endsWith('/api/chat')||!response.body)return response;const id=++inference,started=Date.now(),decoder=new TextDecoder();let pending='',thinkingCharacters=0,contentCharacters=0,chunks=0;return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){chunks++;pending+=decoder.decode(chunk,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line){const item=JSON.parse(line);thinkingCharacters+=item.message?.thinking?.length??0;contentCharacters+=item.message?.content?.length??0;}}if(chunks%64===0)fs.writeFileSync('test-results/model-progress.json',JSON.stringify({id,elapsedMs:Date.now()-started,thinkingCharacters,contentCharacters,chunks}));controller.enqueue(chunk);}})),{status:response.status,headers:response.headers});};
const runtime=new OllamaRuntime(s=>{if(['ready','error'].includes(s.state))console.log(JSON.stringify({stage:'runtime',state:s.state,port:s.port,message:s.message}));}),external=process.env.MYMIND_MODEL_BASE_URL,results=[];
if(external){const url=new URL(external);assert.equal(url.hostname,'127.0.0.1');runtime.status={state:'ready',context:8192,port:Number(url.port),model:runtime.model,gpu:'unknown'};}
const call=runtime.call.bind(runtime);let reasoningCharacters=0,systemCharacters=0;const traces=[];
runtime.call=async(...args)=>{if(args[0]==='chat'){assert.equal(args[1].think,!args[1].format);systemCharacters=String(args[1].messages[0].content).length;}const response=await call(...args);reasoningCharacters+=response.message?.thinking?.length??0;if(args[0]==='chat')console.log(JSON.stringify({stage:args[1].format?'extraction':'model',thinkingCharacters:response.message?.thinking?.length??0,calls:response.message?.tool_calls?.map(c=>c.function.name),tokens:response.eval_count}));if(args[0]==='chat'){traces.push({thinkingCharacters:response.message?.thinking?.length??0,...(!args[1].tools?{extraction:response.message?.content}:{}),calls:response.message?.tool_calls,errors:args[1].messages.filter(m=>m.role==='tool'&&/"error"/.test(m.content)).map(m=>m.content)});fs.writeFileSync('test-results/reasoning-conversation-live-trace.json',JSON.stringify(traces,null,2));}return response;};
(async()=>{try{
 if(!external)await runtime.start();assert.equal(runtime.status.state,'ready',runtime.status.message);
 for(let round=0;round<Number(process.env.MYMIND_MODEL_REPEATS||1);round++){
  const db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{}),started=performance.now();
  try{
   const failures=[],verify=check=>{try{check();}catch(error){failures.push(error.message);}};
   const ask=async text=>{const reply=await assistant.chat({text,requestId:crypto.randomUUID()});assert.equal(db.revision,0);assert.equal(db.snapshot().tasks.length,0);return reply;};
   const projected=()=>assistant.getDraft()?.projectedSnapshot??db.snapshot();
   const initial=await ask(fixture.prompt);let tasks=projected().tasks;
   console.log(JSON.stringify({stage:'initial',reply:initial.content,titles:tasks.map(t=>t.title),dates:tasks.map(t=>({title:t.title,due:t.dueDate}))}));
   verify(()=>assert.ok(initial.preview));
   const repair=check.initial(projected(),initial.content).repair;
   const corrected=await ask(fixture.correction);tasks=projected().tasks;
   console.log(JSON.stringify({stage:'correction',reply:corrected.content,repair:tasks.find(t=>t.id===repair.id)}));
   verify(()=>assert.ok(corrected.preview));
   verify(()=>check.corrected(projected(),repair.id,corrected.content));
   const final=await ask(fixture.clarification);tasks=projected().tasks;
   console.log(JSON.stringify({stage:'clarification',reply:final.content,repair:tasks.find(t=>t.id===repair.id)}));
   verify(()=>check.corrected(projected(),repair.id,final.content));
   const draft=assistant.getDraft();assert.ok(draft);assert.equal(draft.unresolved.length,0);assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:crypto.randomUUID()});assert.equal(db.revision,1);assert.equal(db.snapshot().tasks.length,10);
   assert.ok(traces.length>0);results.push({round:round+1,passed:failures.length===0,failures,ms:Math.round(performance.now()-started),reasoningUsed:reasoningCharacters>0,structuredInferenceUsed:true,systemCharacters,initial,corrected,final,tasks});
  }catch(error){results.push({round:round+1,passed:false,error:error.message,ms:Math.round(performance.now()-started),tasks:db.snapshot().tasks});console.log(JSON.stringify({stage:'failed',error:error.message}));}
  finally{await assistant.reset();db.close();}
  fs.writeFileSync('test-results/reasoning-conversation-model-report.json',JSON.stringify({model:runtime.model,fixture,results,traces},null,2));
  console.log(JSON.stringify({stage:'round',round:round+1,passed:results.at(-1).passed}));
  if(!results.at(-1).passed)break;
 }
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/reasoning-conversation-model-report.json',JSON.stringify({model:runtime.model,fixture,results,traces},null,2));assert.ok(results.every(r=>r.passed),'Inspect reasoning conversation report.');
}finally{if(!external)runtime.stop();}})().catch(error=>{console.error(error);process.exitCode=1;});
