const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const fs=require('node:fs');
const {PlannerDatabase}=require('../dist/main/database');const {OllamaRuntime}=require('../dist/main/ollama');const {PlannerAssistant}=require('../dist/main/assistant');
const db=new PlannerDatabase(':memory:'),runtime=new OllamaRuntime(status=>console.log(JSON.stringify({runtime:status}))),assistant=new PlannerAssistant(db,runtime,()=>{}),results=[];
async function ask(text){const result=await assistant.chat({text,requestId:randomUUID()});results.push({text,result});console.log(JSON.stringify({text,result}));return result;}
(async()=>{try{await runtime.start();assert.equal(runtime.status.state,'ready');
  await ask('Add an event called Dentist appointment for tomorrow');assert.equal(db.snapshot().events.length,1);
  await ask('Delete the Dentist appointment event');assert.equal(db.snapshot().events.length,0);db.undo();assert.equal(db.snapshot().events.length,1);
  await ask('Add a task called Buy notebooks to my to-do list, due tomorrow');assert.equal(db.snapshot().tasks.length,1);assert.equal(db.snapshot().tasks[0].title.toLowerCase(),'buy notebooks');
  await ask('Delete the Buy notebooks task from my to-do list');assert.equal(db.snapshot().tasks.length,0);db.undo();assert.equal(db.snapshot().tasks.length,1);
  await ask('Mark Buy notebooks done');assert.equal(db.snapshot().tasks[0].completed,true);
  await ask('Reopen Buy notebooks, I have not done it yet');assert.equal(db.snapshot().tasks[0].completed,false);
  fs.writeFileSync('test-results/model-crud-report.json',JSON.stringify({passed:true,results},null,2));console.log('Real model event/task create, delete, Undo, complete and reopen passed.');
}finally{assistant.cancel();runtime.stop();db.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
