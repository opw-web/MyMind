// Real Qwen 4B acceptance against isolated in-memory planner databases.
// No production database is opened and no record is saved before explicit Apply.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const appDir=path.resolve(process.argv.find(arg=>arg.startsWith('--app-dir='))?.slice(10)??path.join(__dirname,'..'));
const mainDir=path.join(appDir,'dist','main');
const {PlannerDatabase}=require(path.join(mainDir,'database'));
const {PlannerAssistant}=require(path.join(mainDir,'assistant'));
const {OllamaRuntime}=require(path.join(mainDir,'ollama'));

const MODEL='qwen3.5:4b',CONTEXT=16384,CLOCK='2026-11-06T06:30:00Z';
const profiles={baseline:{temperature:.6,think:true,num_predict:4096},short:{temperature:.2,think:false,num_predict:2048}};
const originalDate=global.Date;
global.Date=class extends originalDate{constructor(...args){super(...(args.length?args:[CLOCK]));}};
const selected=new Set(process.argv.filter(a=>a.startsWith('--case=')).flatMap(a=>a.slice(7).split(',').filter(Boolean)));
const profileName=process.argv.find(a=>a.startsWith('--profile='))?.slice(10)||'baseline';
const repeatsArg=Number(process.argv.find(a=>a.startsWith('--repeats='))?.slice(10));
const list=process.argv.includes('--list'),gate=process.argv.includes('--release-gate');
const out=process.env.MYMIND_QWEN4_EVIDENCE||fs.mkdtempSync(path.join(os.tmpdir(),'mymind-qwen4-'));
const report={model:MODEL,context:CONTEXT,fixtureClock:CLOCK,profile:profileName,profileOptions:profiles[profileName],out,cases:[],startedAt:new originalDate().toISOString()};
const linked=(taskId,title,date='2026-11-08')=>({action:'create',entity:'event',id:`ev-${taskId}`,fields:{title,startDate:date,endDate:date,kind:'planned',linkedTaskId:taskId}});
const task=(id,title)=>({action:'create',entity:'task',id,fields:{title}});
const authorityText='You can remove Apply for Community Garden Plan and the Library Board meeting tasks and the Mosaic Workshop. Actually, keep the Mosaic Workshop. Remove Apply for Community Garden Plan and the Library Board meeting tasks and every event linked to them.';
const cases=[
 {name:'verbatim-authority',repeats:5,text:authorityText,seed:[task('p9','Apply for Community Garden Plan'),linked('p9','Community Garden Plan session'),{action:'create',entity:'event',id:'ev-p9-review',fields:{title:'Community Garden Plan review',startDate:'2026-11-09',endDate:'2026-11-09',kind:'planned',linkedTaskId:'p9'}},task('hall','Library Board meeting'),linked('hall','Library Board meeting session'),task('age','Mosaic Workshop'),linked('age','Mosaic Workshop session'),{action:'create',entity:'event',id:'unrelated-hall',fields:{title:'Library Board meeting',startDate:'2026-11-09',endDate:'2026-11-09',kind:'planned'}}],check(s){assert.deepEqual(s.tasks.map(t=>t.id),['age']);assert.deepEqual(s.events.map(e=>e.id).sort(),['ev-age','unrelated-hall'].sort());}},
 {name:'keep-age-delete-hall',text:'Keep the Mosaic Workshop task and its session. Delete the Library Board meeting tasks and every session linked to those tasks; keep the standalone Library Board meeting.',seed:[task('age','Mosaic Workshop'),linked('age','Mosaic Workshop session'),task('hall','Library Board meeting tasks'),linked('hall','Library Board task session'),{action:'create',entity:'event',id:'standalone',fields:{title:'Library Board meeting',startDate:'2026-11-09',endDate:'2026-11-09',kind:'planned'}}],check(s){assert.deepEqual(s.tasks.map(t=>t.id),['age']);assert.deepEqual(s.events.map(e=>e.id),['ev-age','standalone']);}},
 {name:'negation',text:'Do not delete the Mosaic Workshop task or its calendar session. Keep both. Delete only the Community Garden Plan task and its linked session.',seed:[task('age','Mosaic Workshop'),linked('age','Mosaic Workshop session'),task('p9','Community Garden Plan'),linked('p9','Community Garden Plan session')],check(s){assert.deepEqual(s.tasks.map(t=>t.id),['age']);assert.deepEqual(s.events.map(e=>e.id),['ev-age']);}},
 {name:'task-only-detach',text:'Delete the Community Garden Plan task only. Keep its calendar session as an independent event.',seed:[task('p9','Community Garden Plan'),linked('p9','Project session')],check(s){assert.equal(s.tasks.length,0);assert.equal(s.events.length,1);assert.equal(s.events[0].linkedTaskId,null);}},
 {name:'event-only-retain-task',text:'Delete the Community Garden Plan session only. Keep the task.',seed:[task('p9','Apply for Community Garden Plan'),linked('p9','Community Garden Plan session')],check(s){assert.deepEqual(s.tasks.map(t=>t.id),['p9']);assert.equal(s.events.length,0);}},
 {name:'missing-duplicate-ask',text:'Delete the Community Garden Plan task and the missing invoice task.',seed:[task('p9-a','Community Garden Plan'),task('p9-b','Community Garden Plan')],check(s,d){assert.equal(s.tasks.length,2);assert.ok(d?.unresolved?.length||/which|not sure|multiple|more than one|missing|couldn.t|not find/i.test(this.reply||''));}},
 {name:'mixed-add-delete',realRequired:true,text:'Delete the Library Board meeting task and its linked calendar events, and add a task called Buy notebooks due tomorrow.',seed:[task('hall','Library Board meeting'),linked('hall','Library Board session'),task('age','Mosaic Workshop'),linked('age','Mosaic Workshop session'),{action:'create',entity:'event',id:'standalone-hall',fields:{title:'Library Board meeting',startDate:'2026-11-09',endDate:'2026-11-09',kind:'planned'}}],check(s){assert.deepEqual(s.tasks.map(t=>t.title).sort(),['Buy notebooks','Mosaic Workshop'].sort());const added=s.tasks.find(t=>/buy notebooks/i.test(t.title));assert.equal(added.dueDate,'2026-11-07');assert.deepEqual(s.events.map(e=>e.id).sort(),['ev-age','standalone-hall'].sort());}},
 {name:'create-and-link',realRequired:true,text:'Create exactly one task called Prepare proposal due 2026-11-10, with one checklist step named Draft outline. Also create two planned calendar sessions: Draft session on 2026-11-07 from 10:00 to 11:00 linked to the task and its Draft outline step; Review session on 2026-11-08 from 14:00 to 15:00 linked to the task. Keep session notes independent of task notes. Prepare all three records together for review.',seed:[],check(s){assert.equal(s.tasks.length,1);assert.equal(s.events.length,2);const t=s.tasks[0];assert.match(t.title,/prepare proposal/i);assert.equal(t.dueDate,'2026-11-10');assert.equal(t.steps.length,1);assert.match(t.steps[0].title,/draft outline/i);for(const [title,date,start,end,step] of [['Draft session','2026-11-07','10:00','11:00',t.steps[0].id],['Review session','2026-11-08','14:00','15:00',null]]){const e=s.events.find(x=>x.title===title);assert.ok(e);assert.deepEqual([e.kind,e.startDate,e.endDate,e.startTime,e.endTime,e.linkedTaskId,e.linkedStepId],['planned',date,date,start,end,t.id,step]);}}},
 {name:'reschedule',text:'Move my Community Garden Plan session to 2026-11-10 from 10:00 to 11:00. Keep its linked task unchanged.',seed:[task('p9','Community Garden Plan'),{action:'create',entity:'event',id:'ev-p9',fields:{title:'Community Garden Plan session',startDate:'2026-11-08',endDate:'2026-11-08',startTime:'09:00',endTime:'10:00',kind:'planned',linkedTaskId:'p9'}}],check(s){assert.equal(s.tasks.length,1);assert.deepEqual([s.events[0].startDate,s.events[0].startTime,s.events[0].endTime,s.events[0].linkedTaskId],['2026-11-10','10:00','11:00','p9']);}},
 {name:'completion',text:'Mark the Community Garden Plan task complete. Do not delete it or change its calendar session.',seed:[task('p9','Community Garden Plan'),linked('p9','Project session')],check(s){assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].completed,true);assert.equal(s.events.length,1);}},
 {name:'multi-night-compound',text:'On 2026-11-03 I slept from 11 PM to 6 AM, and on 2026-11-04 I slept from 11 PM to 6 AM. Record both as separate actual Sleep activities in the same Sleep category, each ending the following morning. Do not add tasks or planned sessions.',seed:[],check(s){assert.equal(s.tasks.length,0);assert.equal(s.events.length,2);const e=[...s.events].sort((a,b)=>a.startDate.localeCompare(b.startDate));assert.deepEqual(e.map(v=>[v.kind,v.startDate,v.endDate,v.startTime,v.endTime]),[['actual','2026-11-03','2026-11-04','23:00','06:00'],['actual','2026-11-04','2026-11-05','23:00','06:00']]);assert.equal(e[0].categoryId,e[1].categoryId);}},
 {name:'clarify-then-answer',realRequired:true,text:'Create a planned calendar event called Jazz Night, but I have not picked its date or time. Ask me what date and time to use.',followup:'Schedule Jazz Night on 2026-11-10 from 19:00 to 21:00.',seed:[],check(s){assert.equal(s.tasks.length,0);assert.equal(s.events.length,1);const e=s.events[0];assert.deepEqual([e.title,e.kind,e.startDate,e.endDate,e.startTime,e.endTime],['Jazz Night','planned','2026-11-10','2026-11-10','19:00','21:00']);}},
];
function journal(db){return {history:db.db.prepare('SELECT * FROM history ORDER BY id').all(),requests:db.db.prepare('SELECT * FROM requests ORDER BY id').all()};}
function assertUnchanged(db,before,j){assert.deepEqual(db.snapshot(),before,'No planner record changes before Apply');assert.deepEqual(journal(db),j,'No history or request receipts before Apply');}
function savedRecords(s){return {tasks:s.tasks,events:s.events,projects:s.projects,sections:s.sections,categories:s.categories};}
function save(){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
if(list){for(const c of cases.filter(c=>selected.size===0||selected.has(c.name)))console.log(`${c.name}\t${c.repeats||3} repeats${c.realRequired?'\treal model required':''}`);process.exit(0);}
assert.ok(profiles[profileName]||profileName==='deployed',`Unknown profile ${profileName}`);
assert.ok(Number.isInteger(repeatsArg)||!process.argv.some(a=>a.startsWith('--repeats=')),'--repeats must be a positive integer');
const chosen=cases.filter(c=>selected.size===0||selected.has(c.name));assert.ok(chosen.length,'No matching case selected');
if(gate){assert.equal(chosen.length,cases.length,'--release-gate requires the full case set');assert.ok(!process.argv.some(a=>a.startsWith('--repeats=')),'--release-gate uses the defined repeat counts');}
let activeCase,activeTrial,profile;
const runtime=new OllamaRuntime(()=>{},{model:MODEL,context:CONTEXT});
const nativeStream=runtime.streamChat.bind(runtime);
runtime.streamChat=async(body,...args)=>{
 const copy={...body};
 if(process.env.MYMIND_QWEN4_BASE_URL)copy.keep_alive='1m';
 if(copy.tools&&profile){copy.think=profile.think;copy.options={...(copy.options||{}),temperature:profile.temperature,presence_penalty:0,num_predict:profile.num_predict,num_ctx:CONTEXT};}
 const started=performance.now(),res=await nativeStream(copy,...args);
 if(activeTrial){activeTrial.calls.push({ms:Math.round(performance.now()-started),tools:res.message?.tool_calls?.map(t=>({name:t.function.name,args:t.function.arguments}))||[],options:copy.options,think:copy.think,format:!!copy.format,toolErrors:(copy.messages||[]).filter(m=>m.role==='tool'&&/"error"/i.test(m.content)).map(m=>m.content)});activeTrial.realCalls++;save();}
 return res;
};
async function run(c,round){
 const db=new PlannerDatabase(':memory:',()=>new originalDate(CLOCK)),assistant=new PlannerAssistant(db,runtime,()=>{});
 const trial={name:c.name,round,passed:false,calls:[],realCalls:0};report.cases.push(trial);activeCase=c;activeTrial=trial;
 try{
  if(c.seed.length)db.mutate({changes:c.seed,label:'Acceptance fixture',expectedRevision:0,requestId:`fixture-${randomUUID()}`});
  const before=db.snapshot(),beforeJournal=journal(db);
  let result=await assistant.chat({text:c.text,requestId:randomUUID()});
  trial.reply=result.content;assertUnchanged(db,before,beforeJournal);
  let draft=assistant.getDraft();c.reply=result.content;
  if(c.followup){assert.ok(draft,'Clarification flow must stage a blocked proposal');assert.ok(draft.unresolved.some(x=>x.required),'First turn must ask for required details and block Apply');assert.throws(()=>assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:`blocked-${randomUUID()}`}),/questions|Resolve/);result=await assistant.chat({text:c.followup,requestId:randomUUID()});trial.followupReply=result.content;assertUnchanged(db,before,beforeJournal);draft=assistant.getDraft();}
  if(draft){assert.equal(draft.baseRevision,before.revision);if(c.realRequired)assert.ok(trial.realCalls>0,'Case must exercise real model inference');if(c.followup)assert.equal(draft.unresolved.length,0,'Answer should resolve the clarification');if(c.name!=='missing-duplicate-ask')assert.equal(draft.unresolved.filter(x=>x.required).length,0,'Positive case must be ready to Apply');c.check(draft.projectedSnapshot,draft);}
  else {assert.equal(c.name,'missing-duplicate-ask','Positive acceptance case must stage a draft');c.check(before,null);trial.passed=true;return;}
  const projected=savedRecords(draft.projectedSnapshot);
  if(draft.unresolved.length===0){assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:`apply-${randomUUID()}`});assert.deepEqual(savedRecords(db.snapshot()),projected,'Apply must save exactly the reviewed proposal');
   db.undo(db.revision,`undo-request-${randomUUID()}`);
   assert.deepEqual(savedRecords(db.snapshot()),savedRecords(before),'Undo restores the original seeded records');
  }else{assert.ok(!c.realRequired,'Real workflow case remained unresolved');}
  trial.passed=true;
 }catch(e){trial.error=e.stack||String(e);console.error(`${c.name} #${round+1}: ${e.message}`);}
 finally{trial.ms=Math.round((trial.calls||[]).reduce((n,x)=>n+x.ms,0));assistant.cancel();db.close();save();activeTrial=undefined;activeCase=undefined;}
}
(async()=>{try{
 const external=process.env.MYMIND_QWEN4_BASE_URL;
 if(external){const url=new URL(external);assert.equal(url.hostname,'127.0.0.1','External Ollama reuse must stay loopback');assert.equal(url.pathname,'/','External Ollama URL must be an origin');runtime.status={state:'ready',context:CONTEXT,port:Number(url.port),model:MODEL,gpu:'unknown'};}
 else await runtime.start();
 assert.equal(runtime.model,MODEL);assert.equal(runtime.status.state,'ready',runtime.status.message);assert.equal(runtime.status.context,CONTEXT);
 const tags=await runtime.call('tags');const installed=tags.models.find(m=>m.name===MODEL||m.model===MODEL);assert.ok(installed?.size>0,`${MODEL} must be installed locally`);report.modelDigest=installed.digest;
 if(external)await runtime.call('generate',{model:MODEL,prompt:'',stream:false,think:false,options:{num_ctx:CONTEXT},keep_alive:'1m'},undefined,180000);
 const running=(await runtime.call('ps')).models.find(m=>m.name===MODEL||m.model===MODEL);
 assert.equal(running?.context_length,CONTEXT,'Verify the active model context from Ollama');
 report.runtime={state:runtime.status.state,context:running.context_length,port:runtime.status.port,gpu:runtime.status.gpu};
 report.appDir=appDir;
 report.sourceHashes=Object.fromEntries(['assistant','capabilities','ollama','database'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(mainDir,name+'.js'))).digest('hex')]));
 for(const c of chosen){profile=profiles[profileName];const n=repeatsArg||c.repeats||3;assert.ok(Number.isInteger(n)&&n>0);for(let i=0;i<n;i++)await run(c,i);}
 report.passed=report.cases.length>0&&report.cases.every(x=>x.passed)&&report.cases.filter(x=>chosen.some(c=>c.name===x.name&&c.realRequired)).every(x=>x.realCalls>0);
 save();if(!report.passed||gate&&!report.passed)process.exitCode=1;
}catch(e){report.error=e.stack||String(e);save();console.error(e);process.exitCode=1;}finally{runtime.stop();global.Date=originalDate;save();console.log(`Evidence: ${out}`);}})();
