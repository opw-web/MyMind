import {chatAndApply} from './helpers/assistant';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {OllamaRuntime} from '../src/main/ollama';
import {authorizedActions} from '../src/main/capabilities';
import {conversationContext} from '../src/main/context';
import {todayIn} from '../src/shared/dates';
import {simpleCreate} from '../src/main/simple-request';
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
const answer=(content:string)=>({message:{role:'assistant',content}});
function setup(responses:any[]){const db=new PlannerDatabase(':memory:'),events:any[]=[],requests:any[]=[];const runtime={model:'test',status:{state:'ready',context:8192},call:async(_path:string,body:any)=>{requests.push(structuredClone(body));return responses.shift()??answer('Please clarify.');}} as unknown as OllamaRuntime;const assistant=new PlannerAssistant(db,runtime,()=>{},event=>events.push(event));return {db,assistant,events,requests};}
test('questions, explanations, negations and hypothetical examples never expose write tools',async()=>{
  for(const text of ['Walk me through how the to-do list works','Explain how the 2DLest works','How would I add an exam?','Why does it delete events?','Do not delete this event','What if I create an assignment?','Explain assignments']){
    assert.equal(authorizedActions(text).size,0,text);
    const s=setup([tool('stage_changes',{changes:[{action:'create',entity:'event',title:'Bad',startDate:todayIn()}]}),answer('Here is an explanation.')]);
    try{const before=s.db.revision;const result=await chatAndApply(s.assistant,{text,requestId:text});assert.equal(s.db.revision,before);assert.match(result.content,/explanation|tasks/i);if(s.requests.length)assert.deepEqual(s.requests[0].tools.map((t:any)=>t.function.name),['find_items','finish_request']);}finally{s.db.close();}
  }
});
test('delete and explain returns a committed receipt AND the answer, then handles repeat and exact restore',async()=>{
  const s=setup([tool('find_items',{entity:'event',query:'today'}),tool('stage_changes',{changes:[{action:'delete',entity:'event',id:'original'}]}),tool('preview_changes',{}),answer('Tasks live in projects. Dated tasks also appear on the calendar.'),tool('restore_item',{id:'original'}),answer('I restored the original event.')]);
  try{s.db.mutate({changes:[{action:'create',entity:'event',id:'original',fields:{title:'3D print the remaining bags for cornhole prototype',notes:'Keep all details',startDate:todayIn(),startTime:'11:00',color:'amber'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const original=s.db.snapshot().events[0];
    const result=await chatAndApply(s.assistant,{text:'Delete this event for today and explain how this to-do list works',requestId:'mixed'});assert.ok(result.receipt);assert.match(result.content,/Date|calendar placement/i);assert.equal(s.db.snapshot().events.length,0);assert.ok(s.events.some(e=>e.type==='receipt'));
    const revision=s.db.revision;const repeated=await chatAndApply(s.assistant,{text:'Delete it',requestId:'repeat'});assert.match(repeated.content,/already removed/);assert.equal(s.db.revision,revision);
    await chatAndApply(s.assistant,{text:'Bring it back',requestId:'restore'});assert.deepEqual(s.db.snapshot().events[0],original);
  }finally{s.db.close();}
});
test('a single event today can be deleted on the first turn without a prior query',async()=>{
  const s=setup([]);try{s.db.mutate({changes:[{action:'create',entity:'event',id:'only-today',fields:{title:'Today appointment',startDate:todayIn()}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const result=await chatAndApply(s.assistant,{text:'You can delete this event for today, yeah.',requestId:'first-turn'});assert.ok(result.receipt);assert.equal(s.db.snapshot().events.length,0);assert.equal(s.requests.length,0);}finally{s.db.close();}
});
test('declining or greeting after a clarification never inherits write authority',async()=>{
  for(const reply of ['No.','Hi','Thanks']){const s=setup([answer('Which task do you mean?'),answer('No changes were made.')]);try{await chatAndApply(s.assistant,{text:'Mark it done',requestId:'ambiguous'});await chatAndApply(s.assistant,{text:reply,requestId:'reply'});assert.deepEqual(s.requests.at(-1).tools.map((t:any)=>t.function.name),['find_items','finish_request']);assert.equal(s.db.revision,0);}finally{s.db.close();}}
});
test('unrelated conversation clears old planner pronouns instead of deleting a stale item',async()=>{
  const s=setup([answer('One event today.'),answer('A fractal repeats patterns at different scales.')]);try{s.db.mutate({changes:[{action:'create',entity:'event',id:'old-ref',fields:{title:'Old reference',startDate:todayIn()}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});await chatAndApply(s.assistant,{text:'What events do I have today?',requestId:'query'});await chatAndApply(s.assistant,{text:'Tell me what a fractal is',requestId:'topic'});const result=await chatAndApply(s.assistant,{text:'Delete it',requestId:'unclear'});assert.match(result.content,/Which planner item/);assert.equal(s.db.snapshot().events.length,1);}finally{s.db.close();}
});
test('a comma-separated deletion and explanation still performs both parts',async()=>{
  const s=setup([]);try{s.db.mutate({changes:[{action:'create',entity:'event',fields:{title:'Only event',startDate:todayIn()}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const result=await chatAndApply(s.assistant,{text:'Delete this event for today, explain how the to-do list works',requestId:'comma'});assert.ok(result.receipt);assert.match(result.content,/optional independent deadlines/i);assert.equal(s.db.snapshot().events.length,0);}finally{s.db.close();}
});
test('category reuse, color overrides, edits, rollback and Undo remain consistent',()=>{
  const db=new PlannerDatabase(':memory:');try{db.mutate({changes:[{action:'create',entity:'task',fields:{title:'Submit assignment by Friday'}},{action:'create',entity:'task',fields:{title:'Submit lab report'}},{action:'create',entity:'event',fields:{title:'Math exam',startDate:todayIn()}}],label:'Categorized batch',expectedRevision:0,requestId:'cats'});
    const state=db.snapshot();assert.equal(state.categories.filter(c=>c.title==='Submissions').length,1);assert.equal(state.tasks[0].categoryId,state.tasks[1].categoryId);assert.notEqual(state.tasks[0].color,state.events[0].color);
    db.mutate({changes:[{action:'update',entity:'task',id:state.tasks[0].id,fields:{color:'sky',colorOverride:'sky'}}],label:'Override',expectedRevision:1,requestId:'override'});
    const category=state.categories.find(c=>c.title==='Submissions')!;db.mutate({changes:[{action:'update',entity:'category',id:category.id,fields:{color:'coral'}}],label:'Category color',expectedRevision:2,requestId:'color'});
    assert.equal(db.snapshot().tasks[0].color,'sky');assert.equal(db.snapshot().tasks[1].color,'coral');db.undo();assert.equal(db.snapshot().tasks[1].color,'amber');db.undo();db.undo();assert.equal(db.snapshot().categories.length,0);assert.equal(db.snapshot().tasks.length,0);
  }finally{db.close();}
});
test('reset clears conversation and referents without removing planner data',async()=>{
  const s=setup([answer('A uniquely private conversation.'),answer('Fresh start.')]);try{await chatAndApply(s.assistant,{text:'My private phrase is aardvark',requestId:'before'});await s.assistant.reset();await chatAndApply(s.assistant,{text:'Hello',requestId:'after'});assert.ok(!JSON.stringify(s.requests[1].messages).includes('aardvark'));assert.equal(s.db.snapshot().projects[0].id,'inbox');}finally{s.db.close();}
});
test('large planner catalog stays bounded without blocking an ordinary conversation',async()=>{
  const s=setup([answer('Hello!')]);try{
    s.db.mutate({changes:Array.from({length:100},(_,i)=>({action:'create',entity:'project',fields:{title:`Project ${i} ${'x'.repeat(120)}`}})),label:'Many projects',expectedRevision:0,requestId:'many-projects'});
    const result=await chatAndApply(s.assistant,{text:'Hello',requestId:'short-message'});assert.equal(result.content,'Hello!');assert.ok(JSON.stringify(s.requests[0].messages).length<15000);
  }finally{s.db.close();}
});
test('cancellation after preview preserves proposals without claiming saved changes',async()=>{
 const s=setup([]);try{const assistant=new PlannerAssistant(s.db,(s.assistant as any).runtime,()=>{},e=>{if(e.type==='preview')assistant.cancel();});const result=await assistant.chat({text:'Add a task called Read',requestId:'preview-before-stop'});assert.ok(result.preview);assert.equal(result.receipt,undefined);assert.match(result.content,/preview/i);assert.equal(s.db.snapshot().tasks.length,0);assert.equal(assistant.getDraft()?.projectedSnapshot.tasks.length,1);}finally{s.db.close();}
});

test('context trimming preserves complete exchanges and the latest input',()=>{const turns=Array.from({length:20},(_,i)=>[{role:'user',content:`Turn ${i} ${'x'.repeat(200)}`},{role:'assistant',content:'y'.repeat(200)}]);const result=conversationContext('System',turns,{role:'user',content:'latest'},4096,[]);assert.equal(result.trimmed,true);assert.equal(result.messages.at(-1)?.content,'latest');assert.equal((result.messages.length-2)%2,0);});
test('simple dates do not invent missing times or discard invalid deadlines',()=>{
  assert.equal(simpleCreate('Add a task called Buy notebooks due 2026-02-30','2026-10-10'),undefined);
  assert.equal(simpleCreate('Add an event','2026-10-10'),undefined);
  assert.equal(simpleCreate('Add an exam at 10 AM tomorrow','2026-10-10'),undefined);
  assert.deepEqual(simpleCreate('Add an exam next Friday','2026-10-10')?.fields,{title:'Exam',startDate:'2026-10-16',endDate:'2026-10-16'});
  assert.equal(simpleCreate('Add Study for the math exam tomorrow','2026-10-10')?.entity,'task');
  assert.equal(simpleCreate('Add a chemistry lecture tomorrow','2026-10-10')?.entity,'event');
  assert.equal(simpleCreate('Add a mysterious activity tomorrow','2026-10-10'),undefined);
});
test('organizing more than 100 existing items remains one reviewable undoable batch',()=>{
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:Array.from({length:150},(_,i)=>({action:'create',entity:'task',fields:{title:`Task ${i}`,categoryId:null}})),label:'Existing items',expectedRevision:0,requestId:'existing'});
    const before=db.snapshot(),preview=db.organizePreview();assert.equal(db.revision,before.revision);assert.ok(preview.changes.length>150);
    db.mutate({changes:preview.changes,label:'Organize',expectedRevision:preview.revision,requestId:'organize-many'});assert.ok(db.snapshot().tasks.every(t=>t.categoryId));db.undo();assert.deepEqual(db.snapshot().tasks,before.tasks);
  }finally{db.close();}
});
test('v1 upgrade makes a WAL-safe backup and preserves existing color/data',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'mymind-v2-')),'planner.sqlite'),old=new DatabaseSync(path);
  old.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE sections(id TEXT PRIMARY KEY,project_id TEXT,body TEXT); CREATE TABLE events(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,section_id TEXT,body TEXT); CREATE TABLE history(id INTEGER PRIMARY KEY,label TEXT,before_state TEXT,descriptions TEXT); CREATE TABLE requests(id TEXT PRIMARY KEY,receipt TEXT); PRAGMA user_version=1;");
  old.prepare('INSERT INTO meta VALUES (?,?)').run('revision','7');old.prepare('INSERT INTO meta VALUES (?,?)').run('preferences',JSON.stringify({timezone:'Asia/Kolkata',dayWidth:132,year:2026,chatOpen:true}));const event={id:'old',title:'Original',notes:'All notes',color:'amber',startDate:'2026-10-10',endDate:'2026-10-10',startTime:null,endTime:null};old.prepare('INSERT INTO events VALUES (?,?)').run('old',JSON.stringify(event));old.close();
  const db=new PlannerDatabase(path);try{assert.ok(existsSync(path+'.v1-backup'));assert.ok(readFileSync(path+'.v1-backup').length);assert.deepEqual(db.snapshot().events[0],{...event,kind:'planned',linkedStepId:null,textBox:'',completed:false,linkedTaskId:null,categoryId:null,colorOverride:'amber'});assert.equal(db.revision,7);const preview=db.organizePreview();assert.equal(db.revision,7);db.mutate({changes:preview.changes,label:'Organize',expectedRevision:7,requestId:'organize'});assert.ok(db.snapshot().events[0].categoryId);db.undo();assert.equal(db.snapshot().events[0].color,'amber');assert.equal(db.snapshot().events[0].categoryId,null);}finally{db.close();}
});
