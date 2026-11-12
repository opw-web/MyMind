const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const appRoot=process.env.MYMIND_APP_ROOT||path.resolve(__dirname,'..');
const {PlannerDatabase}=require(path.join(appRoot,'dist/main/database')),{PlannerAssistant}=require(path.join(appRoot,'dist/main/assistant')),{OllamaRuntime}=require(path.join(appRoot,'dist/main/ollama'));
const runtime=new OllamaRuntime(()=>{}),shared=process.env.MYMIND_MODEL_URL;
if(shared){const url=new URL(shared);assert.equal(url.hostname,'127.0.0.1');runtime.status={...runtime.status,state:'ready',port:Number(url.port),context:Number(process.env.MYMIND_MODEL_CONTEXT||65536)};runtime.modelOptions.num_ctx=runtime.status.context;}
const report={passed:false,model:runtime.model,cases:[]};
(async()=>{try{
  if(!shared)await runtime.start();assert.equal(runtime.status.state,'ready',runtime.status.message);
  for(const existing of [false,true]){
    const db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{},event=>{if(event.type==='progress')console.log(JSON.stringify(event));});
    try{
      db.mutate({label:'Fixture',expectedRevision:0,requestId:'fixture',changes:[
        ...(existing?[{action:'create',entity:'project',id:'vip',fields:{title:'VIP project'}}]:[]),
        ...Array.from({length:3},(_,i)=>({action:'create',entity:'task',id:`sample-${i}`,fields:{title:`Grouping sample ${i}`,scheduledDate:'2026-10-14',dueDate:'2026-11-01',notes:`Notes ${i}`,steps:[{id:`step-${i}`,title:'Review outcome',completed:false}]}})),
        {action:'create',entity:'event',id:'unrelated',fields:{title:'Unrelated meeting',startDate:'2026-10-15'}}
      ]});
      const before=db.snapshot(),lookup=await assistant.chat({text:'Find and show every calendar event whose title contains Grouping sample. Retrieve all matching records with find_items.',requestId:'lookup'});
      assert.equal(lookup.receipt,undefined);
      assert.doesNotMatch(lookup.content,/could not complete|no planner changes were saved/i);
      await assistant.reset(); // The actual request must also work as a first turn.
      const result=await assistant.chat({text:'the 3 events for today on the calendar are connected to 3 tasks, and i want the 3 tasks in a project and i want to name the project to be VIP project',requestId:'group'}),after=db.snapshot(),project=after.projects.find(p=>p.title==='VIP project');
      assert.ok(result.receipt,JSON.stringify(result));assert.ok(project);assert.equal(after.revision,before.revision+1);
      assert.equal(after.projects.filter(p=>p.title==='VIP project').length,1);assert.deepEqual(after.events,before.events);
      assert.deepEqual(after.tasks,before.tasks.map(t=>({...t,projectId:project.id})));assert.match(result.content,/Moved 3 tasks/);
      const replay=await assistant.chat({text:'Repeat request',requestId:'group'});assert.deepEqual(replay,result);assert.equal(db.revision,after.revision);
      await assistant.chat({text:'Undo that',requestId:'undo'});assert.deepEqual(db.snapshot().tasks,before.tasks);assert.deepEqual(db.snapshot().projects,before.projects);assert.deepEqual(db.snapshot().events,before.events);
      report.cases.push({existingProject:existing,lookup:lookup.content,reply:result.content,passed:true});console.log(JSON.stringify(report.cases.at(-1)));
    }finally{await assistant.reset();db.close();}
  }
  const db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{});
  try{
    const result=await assistant.chat({text:'Create a project called Receipt acknowledgement test.',requestId:'create-project'});
    assert.ok(result.receipt);assert.ok(db.snapshot().projects.some(p=>p.title==='Receipt acknowledgement test'));assert.match(result.content,/Receipt acknowledgement test/);assert.doesNotMatch(result.content,/could not finish|cannot|confirm/);
    report.cases.push({ordinaryProjectCreation:true,reply:result.content,passed:true});console.log(JSON.stringify(report.cases.at(-1)));
  }finally{await assistant.reset();db.close();}
  report.passed=true;
}finally{if(!shared)runtime.stop();fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync(path.join('test-results','project-grouping-model-report.json'),JSON.stringify(report,null,2));}
})().catch(error=>{console.error(error);process.exitCode=1;});
