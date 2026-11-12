const assert=require('node:assert/strict'),fs=require('node:fs');
const {PlannerDatabase}=require('../dist/main/database'),{PlannerAssistant}=require('../dist/main/assistant'),{OllamaRuntime}=require('../dist/main/ollama'),{todayIn,shiftDate}=require('../dist/shared/dates');
const runtime=new OllamaRuntime(()=>{}),results=[];
const external=process.env.MYMIND_MODEL_BASE_URL;
const exactRequest=require('./autonomy-example.cjs');
if(external){const url=new URL(external);assert.equal(url.hostname,'127.0.0.1');runtime.status={state:'ready',context:8192,port:Number(url.port),model:runtime.model,gpu:'unknown'};}
async function scenario(name,run){const db=new PlannerDatabase(':memory:'),assistant=new PlannerAssistant(db,runtime,()=>{});const started=performance.now();try{const ask=async text=>{
  const before=db.snapshot();
  const result=await assistant.chat({text,requestId:crypto.randomUUID()});
  assert.deepEqual(db.snapshot(),before);
  const draft=result.preview?.draft;
  if(!draft||draft.unresolved.some(issue=>issue.required))return result;
  const receipt=assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:crypto.randomUUID()});
  return {...result,receipt};
 };await run(db,ask);results.push({name,passed:true,ms:Math.round(performance.now()-started)});}catch(error){results.push({name,passed:false,error:error.message,ms:Math.round(performance.now()-started)});}finally{await assistant.reset();db.close();}console.log(JSON.stringify(results.at(-1)));}
(async()=>{try{
 if(!external)await runtime.start();assert.equal(runtime.status.state,'ready');
 for(let round=0;round<Number(process.env.MYMIND_MODEL_REPEATS||3);round++){
  await scenario('dictated workload saves five distinct deadline-only tasks',async(db,ask)=>{
   const result=await ask(exactRequest);
   assert.ok(result.receipt,JSON.stringify(result));
   const {tasks,events}=db.snapshot();
   assert.equal(tasks.length,5,JSON.stringify(tasks.map(t=>t.title)));
   assert.equal(events.length,0);
   assert.ok(tasks.every(t=>t.scheduledDate===null&&t.dueDate===shiftDate(todayIn(),7)));
   const topics=[
    /appliance.*repair|repair.*appliance/i,
    /(?=.*(?:portfolio|site))(?=.*(?:newsletter))(?=.*(?:connect|integrat|link))/i,
    /(?=.*newsletter)(?=.*(?:publish|post|send))/i,
    /(?=.*portfolio)(?=.*(?:refresh|update|revise))/i,
    /workshop.*class|class.*workshop|spring.*class/i
   ];
   const distinctTasks=topics.map(pattern=>{
    const matches=tasks.filter(t=>pattern.test(t.title));
    assert.equal(matches.length,1,String(pattern));
    return matches[0].id;
   });
   assert.equal(new Set(distinctTasks).size,5);
   assert.doesNotMatch(result.content,/would you like|before committing|should i (?:add|proceed)/i);
   await ask('Undo that');
   assert.equal(db.snapshot().tasks.length,0);
  });
  if(process.env.MYMIND_EXACT_REQUEST_ONLY==='1')continue;
  await scenario('natural workload executes with defaults and Undo',async(db,ask)=>{const result=await ask('I need to call the dentist and buy toothpaste. Put those on my to-do list.');assert.ok(result.receipt,JSON.stringify(result));const tasks=db.snapshot().tasks;assert.equal(tasks.length,2);assert.ok(tasks.every(t=>t.projectId==='inbox'&&t.dueDate===null));assert.match(tasks.map(t=>t.title).join(' '),/dentist/i);assert.match(tasks.map(t=>t.title).join(' '),/toothpaste/i);const undo=await ask('Undo that');assert.ok(undo.receipt);assert.equal(db.snapshot().tasks.length,0);});
  await scenario('break down work and save the useful structure',async(db,ask)=>{const result=await ask('Help me break down my history assignment into three practical tasks and add them to my to-do list. The assignment is to research the Industrial Revolution and write a short essay.');assert.ok(result.receipt,JSON.stringify(result));assert.equal(db.snapshot().tasks.length,3);assert.ok(db.snapshot().tasks.every(t=>t.dueDate===null));});
  await scenario('dated events use untimed defaults',async(db,ask)=>{const result=await ask('Add a math exam and a chemistry exam today.');assert.ok(result.receipt,JSON.stringify(result));assert.equal(db.snapshot().events.length,2);assert.ok(db.snapshot().events.every(e=>e.startDate===todayIn()&&e.startTime===null&&e.endTime===null));});
  await scenario('missing event date asks only for the date then completes',async(db,ask)=>{const result=await ask('Add my dentist appointment.');assert.equal(db.revision,0);assert.match(result.content,/date|day|when/i);assert.doesNotMatch(result.content,/would you like|should i (?:add|proceed|create)|confirm.*(?:change|plan)|notes|what time/i);const completed=await ask('Tomorrow');assert.ok(completed.receipt,JSON.stringify(completed));assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().events[0].startTime,null);});
  await scenario('duplicate targets still require identity',async(db,ask)=>{db.mutate({changes:[{action:'create',entity:'project',id:'school',fields:{title:'School'}},{action:'create',entity:'task',id:'a',fields:{title:'Report'}},{action:'create',entity:'task',id:'b',fields:{title:'Report',projectId:'school'}}],expectedRevision:0,requestId:'fixture',label:'Fixture'});const result=await ask('Mark Report done');assert.equal(db.revision,1);assert.ok(db.snapshot().tasks.every(t=>!t.completed));assert.match(result.content,/which|two|2|multiple/i);});
  await scenario('discussion creates no tasks',async(db,ask)=>{await ask('How would I plan an assignment in this app?');assert.equal(db.revision,0);assert.equal(db.snapshot().tasks.length,0);});
 }
 fs.mkdirSync('test-results',{recursive:true});const report={model:runtime.model,context:8192,total:results.length,passed:results.filter(r=>r.passed).length,results},reportFile=process.env.MYMIND_EXACT_REQUEST_ONLY==='1'?'test-results/autonomy-exact-model-report.json':'test-results/autonomy-model-report.json';fs.writeFileSync(reportFile,JSON.stringify(report,null,2));assert.equal(report.passed,report.total,`Inspect ${reportFile}`);
}finally{if(!external)runtime.stop();}})().catch(error=>{console.error(error);process.exitCode=1;});
