const assert=require('node:assert/strict'),fs=require('node:fs');
const {PlannerDatabase}=require('../dist/main/database'),{PlannerAssistant}=require('../dist/main/assistant'),{OllamaRuntime}=require('../dist/main/ollama');
const runtime=new OllamaRuntime(()=>{}),db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{});
(async()=>{try{
 await runtime.start();assert.equal(runtime.status.state,'ready',runtime.status.message);
 db.mutate({changes:[{action:'create',entity:'task',id:'prep',fields:{title:'Prepare career profile'}},{action:'create',entity:'task',id:'output',fields:{title:'Update LinkedIn profile'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});
 const ask=text=>assistant.chat({text,requestId:crypto.randomUUID(),selection:{entity:'task',id:'output',revision:db.revision}});
 let result=await ask('Add these two checklist steps to Update LinkedIn profile: update the headline; update experience. Keep them inside this task.');assert.ok(result.receipt,JSON.stringify(result));let output=db.snapshot().tasks.find(t=>t.id==='output');assert.equal(output.steps.length,2);assert.equal(db.snapshot().tasks.length,2);
 const steps=output.steps;
 result=await ask('Make Update LinkedIn profile depend on Prepare career profile.');assert.ok(result.receipt,JSON.stringify(result));output=db.snapshot().tasks.find(t=>t.id==='output');assert.deepEqual(output.dependsOnIds,['prep']);assert.deepEqual(output.steps,steps);
 const revision=db.revision;await ask('Does Update LinkedIn profile depend on Prepare career profile?');assert.equal(db.revision,revision);
 const report={passed:true,stepsAdded:2,prerequisiteAdded:true,stepIdsPreserved:true,questionReadOnly:true};fs.writeFileSync('test-results/task-structure-model-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await assistant.reset();runtime.stop();db.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
