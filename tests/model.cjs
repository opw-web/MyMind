const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {PlannerDatabase}=require('../dist/main/database');
const {OllamaRuntime}=require('../dist/main/ollama');
const {PlannerAssistant}=require('../dist/main/assistant');
const {todayIn,shiftDate,weekday}=require('../dist/shared/dates');
const db=new PlannerDatabase(':memory:');
const runtime=new OllamaRuntime(status=>console.log(JSON.stringify({state:status.state,message:status.message,context:status.context,gpu:status.gpu,pid:status.pid,port:status.port})));
const assistant=new PlannerAssistant(db,runtime,()=>{});
const originalCall=runtime.call.bind(runtime);
runtime.call=async function(endpoint,...args){const result=await originalCall(endpoint,...args);if(endpoint==='chat')console.log(JSON.stringify({toolCalls:result.message?.tool_calls,answer:result.message?.content}));return result;};
const report={requests:[],gpu:null,shutdown:null};
async function request(text){const start=Date.now();const result=await assistant.chat({text,requestId:randomUUID()});console.log(JSON.stringify({request:text,result,seconds:(Date.now()-start)/1000}));report.requests.push({text,result,seconds:(Date.now()-start)/1000});return result;}
(async()=>{try{
  await runtime.start();assert.equal(runtime.status.state,'ready',runtime.status.message);
  const cli=spawnSync(path.join(process.env.LOCALAPPDATA,'Programs','Ollama','ollama.exe'),['ps'],{env:{...process.env,OLLAMA_HOST:`127.0.0.1:${runtime.status.port}`},encoding:'utf8'});console.log(cli.stdout);report.gpu={...runtime.status,cli:cli.stdout};
  const today=todayIn();let friday=shiftDate(today,1);while(weekday(friday)!=='Fri')friday=shiftDate(friday,1);
  await request('Add an exam next Friday');assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].startDate,friday);
  let monday=shiftDate(today,1);while(weekday(monday)!=='Mon')monday=shiftDate(monday,1);
  await request('Move it to Monday');assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].startDate,monday);assert.equal(db.snapshot().events[0].endDate,monday);
  db.mutate({changes:[{action:'create',entity:'task',id:'cornhole',fields:{title:'Cornhole'}}],label:'Fixture',expectedRevision:db.revision,requestId:randomUUID()});
  const before=db.snapshot();await request('Mark Cornhole done and add a packaging task for tomorrow');assert.equal(db.snapshot().tasks.find(t=>t.id==='cornhole').completed,true);assert.equal(db.snapshot().tasks.find(t=>t.title.toLowerCase().includes('packaging')).dueDate,shiftDate(today,1));
  db.undo();assert.deepEqual(db.snapshot().tasks,before.tasks);
  db.mutate({changes:[{action:'create',entity:'task',fields:{title:'Walls'}},{action:'create',entity:'project',id:'vip',fields:{title:'VIP'}},{action:'create',entity:'task',fields:{title:'Walls',projectId:'vip'}}],label:'Ambiguous fixture',expectedRevision:db.revision,requestId:randomUUID()});
  const revision=db.revision;const ambiguous=await request('Mark Walls done');assert.equal(db.revision,revision);assert.equal(ambiguous.receipt,undefined);
  const cancellation=assistant.chat({text:'Add 10 tasks for my project next week',requestId:randomUUID()});setTimeout(()=>assistant.cancel(),150);await assert.rejects(cancellation,/cancelled/);assert.equal(db.revision,revision);
  report.passed=true;
}finally{
  const start=Date.now(),port=runtime.status.port,pid=runtime.status.pid;assistant.cancel();runtime.stop();db.close();
  await new Promise(resolve=>setTimeout(resolve,700));let portClosed=false;try{await fetch(`http://127.0.0.1:${port}/api/version`,{signal:AbortSignal.timeout(1000)});}catch{portClosed=true;}
  let alive=false;try{process.kill(pid,0);alive=true;}catch{}
  report.shutdown={pid,port,portClosed,processExited:!alive,milliseconds:Date.now()-start};fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/model-report.json',JSON.stringify(report,null,2));assert.equal(portClosed,true);assert.equal(alive,false);console.log(JSON.stringify({shutdown:report.shutdown,passed:report.passed}));
}})().catch(error=>{console.error(error);process.exitCode=1;});
