const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const appRoot=process.env.MYMIND_APP_ROOT||path.resolve(__dirname,'..');
const {PlannerDatabase}=require(path.join(appRoot,'dist/main/database')),{PlannerAssistant}=require(path.join(appRoot,'dist/main/assistant')),{OllamaRuntime}=require(path.join(appRoot,'dist/main/ollama'));
const runtime=new OllamaRuntime(()=>{}),shared=process.env.MYMIND_MODEL_URL;
if(shared){
  const url=new URL(shared);assert.equal(url.hostname,'127.0.0.1');
  runtime.status={...runtime.status,state:'ready',port:Number(url.port),context:Number(process.env.MYMIND_MODEL_CONTEXT||32768)};
  runtime.modelOptions.num_ctx=runtime.status.context;
}
const cases=[
  {text:"so new project, this is about my career. i need to first make a detailed document about everything ive done in my career and what i want to do in the future. after making this document only ill be able to then go through google's career exploration tool. thaen ill update my linkedin profile accordingly. then ill make my first linkedin post.",project:/career/i,steps:[/document/i,/google.*career|career.*exploration/i,/linkedin.*profile/i,/linkedin.*post/i]},
  {text:'Start a new project called Learning Spanish. First choose a beginner course. Then complete the introductory lessons. Finally practice speaking with a language partner.',project:/spanish/i,steps:[/course/i,/lesson/i,/speaking|language partner/i]}
];
(async()=>{const report={passed:false,cases:[]};try{
  if(!shared)await runtime.start();assert.equal(runtime.status.state,'ready',runtime.status.message);
  for(const fixture of cases){
    const db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{});
    try{
      const result=await assistant.chat({text:fixture.text,requestId:crypto.randomUUID()}),state=db.snapshot();
      assert.ok(result.receipt,JSON.stringify(result));assert.equal(state.tasks.length,1);assert.equal(state.projects.length,2);
      const task=state.tasks[0],project=state.projects.find(p=>p.id===task.projectId);assert.match(project.title,fixture.project);
      assert.equal(task.steps.length,fixture.steps.length);fixture.steps.forEach((pattern,i)=>assert.match(task.steps[i].title,pattern));
      assert.deepEqual(task.dependsOnIds,[]);assert.equal(task.scheduledDate,null);assert.equal(state.events.length,0);
      const item={project:project.title,task:task.title,steps:task.steps.map(s=>s.title),reply:result.content};report.cases.push(item);console.log(JSON.stringify(item));
      db.undo();assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().projects.length,1);
    }finally{await assistant.reset();db.close();}
  }
  report.passed=true;
}finally{
  if(!shared)runtime.stop();fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/project-workflow-model-report.json',JSON.stringify(report,null,2));
}})().catch(error=>{console.error(error);process.exitCode=1;});
