const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PlannerDatabase}=require('../dist/main/database');
const {PlannerAssistant}=require('../dist/main/assistant');
const {OllamaRuntime}=require('../dist/main/ollama');
const {todayIn,shiftDate}=require('../dist/shared/dates');
const fs=require('node:fs');
const db=new PlannerDatabase(':memory:');const runtime=new OllamaRuntime(()=>{});const assistant=new PlannerAssistant(db,runtime,()=>{});const report={requests:[]};
const original=runtime.call.bind(runtime);runtime.call=async function(endpoint,...args){const response=await original(endpoint,...args);if(endpoint==='chat')console.log(JSON.stringify({tools:response.message?.tool_calls,answer:response.message?.content}));return response;};
async function chat(text){const result=await assistant.chat({text,requestId:randomUUID()});console.log(JSON.stringify({text,result}));report.requests.push({text,result});return result;}
(async()=>{try{
  db.mutate({changes:[{action:'create',entity:'project',id:'vip',fields:{title:'VIP'}},{action:'create',entity:'task',id:'walls-inbox',fields:{title:'Walls'}},{action:'create',entity:'task',id:'walls-vip',fields:{title:'Walls',projectId:'vip'}}],label:'Fixtures',expectedRevision:0,requestId:'fixtures'});
  await runtime.start();assert.equal(runtime.status.state,'ready');const clarification=await chat('Mark Walls done');assert.match(clarification.content,/Which one/i);assert.equal(db.revision,1);await chat('The one in VIP');assert.equal(db.snapshot().tasks.find(task=>task.id==='walls-vip').completed,true);assert.equal(db.snapshot().tasks.find(task=>task.id==='walls-inbox').completed,false);
  const before=db.snapshot();await chat('Create a project called School, a section called Homework in School, and a task called Math worksheet in Homework due tomorrow.');let snapshot=db.snapshot();const school=snapshot.projects.find(project=>project.title.toLowerCase()==='school');assert.ok(school);const homework=snapshot.sections.find(section=>section.title.toLowerCase()==='homework');assert.equal(homework.projectId,school.id);const math=snapshot.tasks.find(task=>task.title.toLowerCase()==='math worksheet');assert.equal(math.projectId,school.id);assert.equal(math.sectionId,homework.id);assert.equal(math.dueDate,shiftDate(todayIn(),1));assert.equal(math.completed,false);assert.equal(db.revision,before.revision+1);
  const answer=await chat('What tasks are due tomorrow?');assert.match(answer.content,/Math worksheet/i);assert.equal(answer.receipt,undefined);
  db.undo();assert.deepEqual(db.snapshot().projects,before.projects);assert.deepEqual(db.snapshot().tasks,before.tasks);report.passed=true;
}finally{assistant.cancel();runtime.stop();db.close();fs.writeFileSync('test-results/model-organization-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed}));}})().catch(error=>{console.error(error);process.exitCode=1;});
