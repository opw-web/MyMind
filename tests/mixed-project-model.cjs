const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const appRoot=process.env.MYMIND_APP_ROOT||path.resolve(__dirname,'..');
const {PlannerDatabase}=require(path.join(appRoot,'dist/main/database')),{PlannerAssistant}=require(path.join(appRoot,'dist/main/assistant')),{OllamaRuntime}=require(path.join(appRoot,'dist/main/ollama'));
const runtime=new OllamaRuntime(()=>{}),shared=process.env.MYMIND_MODEL_URL;
if(shared){const url=new URL(shared);assert.equal(url.hostname,'127.0.0.1');runtime.status={...runtime.status,state:'ready',port:Number(url.port),context:Number(process.env.MYMIND_MODEL_CONTEXT||32768)};runtime.modelOptions.num_ctx=runtime.status.context;}
const text="There's a hackathon, Fetchathon 3.0 that's on 24th so add that to my calendar. i also have the Pre-seed Final Pitch on 24th so add that event as well. i have to submit my Pre-seed Final Pitch Deck by 24th, that's the deadline, put it in the VIP project, and i also have Submission Of Pitch Deck due on 20th which will also go in the VIP project";
(async()=>{const db=new PlannerDatabase(':memory:'),report={passed:false,model:runtime.model};try{
  if(!shared)await runtime.start();assert.equal(runtime.status.state,'ready');
  db.mutate({changes:[{action:'create',entity:'project',id:'vip',fields:{title:'VIP project'}}],expectedRevision:0,requestId:'fixture',label:'Fixture'});
  const assistant=new PlannerAssistant(db,runtime,()=>{},event=>{if(event.type==='progress')console.log(JSON.stringify(event));});
  const result=await assistant.chat({text,requestId:'mixed-project'}),state=db.snapshot();assert.ok(result.receipt,JSON.stringify(result));
  assert.equal(state.events.length,2);assert.equal(state.tasks.length,2);assert.equal(state.projects.length,2);
  assert.ok(state.events.some(e=>/fetchathon/i.test(e.title)));assert.ok(state.events.some(e=>/pre.?seed.*pitch/i.test(e.title)));
  assert.ok(state.events.every(e=>e.startDate==='2026-10-24'&&e.endDate==='2026-10-24'&&e.linkedTaskId===null));
  assert.ok(state.tasks.every(t=>t.projectId==='vip'&&t.scheduledDate===null));assert.deepEqual(state.tasks.map(t=>t.dueDate).sort(),['2026-10-20','2026-10-24']);
  assert.doesNotMatch(result.content,/Which tasks or linked events|first ask me to show the group/i);
  report.passed=true;report.reply=result.content;report.events=state.events.map(({title,startDate})=>({title,startDate}));report.tasks=state.tasks.map(({title,dueDate,scheduledDate,projectId})=>({title,dueDate,scheduledDate,projectId}));
  db.undo();assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().events.length,0);assert.equal(db.snapshot().projects.length,2);
}catch(error){report.error=error.message;throw error;}finally{db.close();if(!shared)runtime.stop();fs.writeFileSync('test-results/mixed-project-model-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}})().catch(error=>{console.error(error);process.exitCode=1;});
