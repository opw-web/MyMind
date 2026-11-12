const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PlannerDatabase}=require('../dist/main/database'),{PlannerAssistant}=require('../dist/main/assistant'),{OllamaRuntime}=require('../dist/main/ollama'),{todayIn,shiftDate}=require('../dist/shared/dates');
const runtime=new OllamaRuntime(s=>console.log(JSON.stringify({runtime:s}))),results=[];let db,assistant;
const repeats=Number(process.env.MYMIND_MODEL_REPEATS||3);
async function ask(text,check,selection){const events=[],started=performance.now();assistant.onEvent=e=>events.push({...e,atMs:Math.round(performance.now()-started)});const before=db.revision;let result;try{result=await assistant.chat({text,requestId:crypto.randomUUID(),selection});check(result,before);results.push({text,passed:true,ms:Math.round(performance.now()-started),firstTextMs:events.find(e=>e.type==='text')?.atMs,result});console.log(JSON.stringify(results.at(-1)));}catch(error){results.push({text,passed:false,ms:Math.round(performance.now()-started),error:error.message,result});console.log(JSON.stringify(results.at(-1)));}}
function unchanged(_r,rev){assert.equal(db.revision,rev);}
(async()=>{try{await runtime.start();assert.equal(runtime.status.state,'ready');for(let round=0;round<repeats;round++){
 db=new PlannerDatabase(':memory:');assistant=new PlannerAssistant(db,runtime,()=>{});const today=todayIn();
 db.mutate({changes:[{action:'create',entity:'event',id:'cornhole-original',fields:{title:'3D print the remaining bags for cornhole prototype',notes:'Preserve these original notes',startDate:today,color:'amber'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const original=db.snapshot().events[0];
 await ask('What events do I have today?',r=>{assert.match(r.content,/cornhole/i);assert.equal(db.snapshot().events.length,1);});
 await ask('You can delete this event for today, yeah.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().events.length,0);});
 await ask('Delete it.',(r,rev)=>{unchanged(r,rev);assert.match(r.content,/already|removed/i);});
 await ask('Bring it back.',r=>{assert.ok(r.receipt);assert.deepEqual(db.snapshot().events[0],original);});
 for(const text of ['Walk me through how the to-do list works.','Explain how the 2DLest works.','How would I add an exam next Friday?','Do not delete this event.','What if I create a task called Homework?'])await ask(text,unchanged);
 await ask('Delete this event and explain how the to-do list works.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().events.length,0);assert.match(r.content,/task|project|due date|checkbox/i);assert.ok(r.content.length>100);},{entity:'event',id:original.id,revision:db.revision});
 await ask('Add a task called Submit college assignment, due tomorrow.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().tasks.length,1);assert.equal(db.snapshot().tasks[0].dueDate,shiftDate(today,1));assert.ok(db.snapshot().tasks[0].categoryId);});
 await ask('Add a chemistry exam event for tomorrow.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().events.length,1);assert.notEqual(db.snapshot().events[0].color,db.snapshot().tasks[0].color);});
 await ask('What tasks are due tomorrow?',(r,rev)=>{unchanged(r,rev);assert.match(r.content,/assignment/i);});
 await ask('Mark Submit college assignment done.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().tasks[0].completed,true);});
 await ask('Reopen Submit college assignment. I have not done it yet.',r=>{assert.ok(r.receipt);assert.equal(db.snapshot().tasks[0].completed,false);});
 await assistant.reset();await ask('How can I break a large project into manageable steps?',unchanged);
 db.close();db=undefined;
 }const passed=results.filter(r=>r.passed).length;fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/v2-model-report.json',JSON.stringify({model:runtime.model,context:runtime.status.context,gpu:runtime.status.gpu,total:results.length,passed,accuracy:passed/results.length,results},null,2));assert.equal(passed,results.length,'Inspect test-results/v2-model-report.json');console.log(`V2 live model: ${passed}/${results.length} passed.`);
}finally{assistant?.cancel();runtime.stop();db?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
