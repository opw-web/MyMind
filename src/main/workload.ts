import {requestedStepTargets} from './step-intent';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {OllamaRuntime} from './ollama';
import {Change} from '../shared/model';
import {dateSchema} from '../shared/validation';
import {endOfWeek} from '../shared/dates';
import {applyCalendarIntent} from './calendar-intent';

const task=z.object({key:z.string().min(1),title:z.string().min(1).max(240),source:z.string().min(1).max(400),notes:z.string().max(2000),dueDate:dateSchema.nullable(),sessions:z.array(z.object({startDate:dateSchema,endDate:dateSchema.optional(),startTime:z.string().nullable().optional(),endTime:z.string().nullable().optional()}).strict()).max(30),steps:z.array(z.string().min(1).max(240)).max(5),dependsOnKeys:z.array(z.string())}).strict();
export const workloadSchema=z.object({
  tasks:z.array(task).min(1).max(60),
  unresolved:z.array(z.object({taskKey:z.string().nullable(),field:z.enum(['dueDate','sessions','title','newTask']),source:z.string().min(1).max(400),question:z.string().min(1).max(400)}).strict()).max(20)
}).strict();
export type Workload=z.infer<typeof workloadSchema>;
// Keep grammar generation small. The service enforces all size limits after
// decoding; expanding bounded strings/arrays in llama.cpp can exceed its rules.
const modelSchema=JSON.parse(JSON.stringify(z.toJSONSchema(workloadSchema),(key,value)=>['minLength','maxLength','minItems','maxItems'].includes(key)?undefined:value));
const common=new Set('i a an my the me is it this that these those things something really more less few any some are was were if clearly maybe just now them and also then so okay well to do list want need have must make get take look at into for of in from on by with you your research update write send email profile go buy done first all definitely coming today tomorrow day sunday monday tuesday wednesday thursday friday saturday deadline put down'.split(' '));
const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function originalFragment(fragment:string,text:string):string|undefined{
  const tokenize=(s:string)=>[...s.matchAll(/[\p{L}\p{N}]+/gu)],wanted=tokenize(fragment).map(m=>m[0].toLowerCase()),actual=tokenize(text);
  let bestStart=0,bestLength=0;
  for(let start=0;start<actual.length;start++)for(let offset=0;offset<wanted.length;offset++){
    let length=0;while(start+length<actual.length&&offset+length<wanted.length&&actual[start+length][0].toLowerCase()===wanted[offset+length]&&actual[start+length].index!-actual[start].index!<600)length++;
    if(length>bestLength){bestStart=start;bestLength=length;}
  }
  if(bestLength&&(bestLength===wanted.length||bestLength>=Math.max(3,Math.ceil(wanted.length*.6)))){
    const last=actual[bestStart+bestLength-1];return text.slice(actual[bestStart].index,last.index!+last[0].length);
  }
}
export function validateWorkload(value:unknown,text:string):Workload{
  const draft=workloadSchema.parse(value),keys=new Set(draft.tasks.map(t=>t.key)),source=normalize(text),errors:string[]=[];
  if(keys.size!==draft.tasks.length)errors.push('Use a different key for each distinct task.');
  if(new Set(draft.tasks.map(t=>normalize(t.title))).size!==draft.tasks.length)errors.push('Merge duplicate tasks.');
  const quote=(fragment:string,label:string)=>{if(!source.includes(normalize(fragment)))errors.push(`${label}: quote a short phrase actually present in the transcript, without rewriting words.`);};
  for(const task of draft.tasks){
    task.source=originalFragment(task.source,text)??task.source;
    quote(task.source,task.title);
    if(task.dependsOnKeys.some(key=>!keys.has(key)||key===task.key))errors.push('Prerequisites must connect two different keys in the draft.');

  }
  const stepTargets=requestedStepTargets(text,draft.tasks.map(t=>({title:t.title,sourceFragments:[t.source]})));
  draft.tasks.forEach((task,index)=>{if(!stepTargets.has(index))task.steps=[];});
  const edges=new Map(draft.tasks.map(t=>[t.key,t.dependsOnKeys]));
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(key:string)=>{if(visiting.has(key))throw new Error('Prerequisites form a cycle.');if(visited.has(key))return;visiting.add(key);for(const parent of edges.get(key)??[])visit(parent);visiting.delete(key);visited.add(key);};
  for(const key of keys)visit(key);
  const sourcePosition=(fragment:string)=>source.indexOf(normalize(fragment));
  const primaryTitle=(title:string)=>normalize(title.split(/\b(?:with|from|using|based on)\b/i)[0]);
  for(const request of text.matchAll(/\bi\s+(?:(?:also|definitely|really)\s+)*(?:(?:need|want|have) to|must)\s+(?:make|create|build|prepare|draft|write)\s+(?:my|the|a|an)\s+((?:[\p{L}\p{N}]+\s+){0,2}(?:profile|report|brief|plan|outline|dataset|inventory|budget))\b/giu)){
    const artifact=normalize(request[1]);
    if(!draft.tasks.some(t=>primaryTitle(t.title).includes(artifact)||(/^(?:create|compile|gather|make|build|prepare|draft|write|assemble|collect|produce|develop)\b/i.test(t.title)&&normalize(t.source).includes(artifact))))errors.push(`Account for the separately requested preparation as its own task: ${request[0]}. Referencing it in another task's notes or steps is not enough.`);
  }
  // Only transcript-supported uncertainties become questions. Unsupported
  // model speculation is not a missing user detail and must not block clear work.
  draft.unresolved=draft.unresolved.flatMap(detail=>{const original=originalFragment(detail.source,text);return original&&(detail.field!=='newTask'||normalize(original).split(' ').some(word=>!common.has(word)))?[{...detail,source:original}]:[];});
  for(const detail of draft.unresolved){
    quote(detail.source,'Unresolved detail');
    if(detail.taskKey===null&&detail.field!=='newTask')detail.taskKey=draft.tasks.filter(t=>sourcePosition(t.source)<=sourcePosition(detail.source)).sort((a,b)=>sourcePosition(b.source)-sourcePosition(a.source))[0]?.key??null;
    if(detail.taskKey!==null&&!keys.has(detail.taskKey))errors.push('Unresolved detail must reference a task key, or null for possible additional work.');
    const target=draft.tasks.find(t=>t.key===detail.taskKey);
    if(detail.field==='sessions'&&!/\b(?:calendar|schedule|scheduled|scheduling)\b/i.test(detail.source))detail.field='dueDate';
    if(target&&(detail.field==='dueDate'||detail.field==='sessions')){
      if(detail.field==='sessions')target.sessions=[];else target.dueDate=null;
      detail.question=`What Date should I use for “${target.title}”? You said “${detail.source}”.`;
    }
  }
  for(const task of draft.tasks){
    const start=sourcePosition(task.source),next=draft.tasks.map(t=>sourcePosition(t.source)).filter(p=>p>start).sort((a,b)=>a-b)[0]??source.length,scope=source.slice(start,next);
    const numbered=/\b(\d{1,2})(?:st|nd|rd|th)?\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(scope);
    if(numbered&&task.dueDate&&Number(task.dueDate.slice(8))!==Number(numbered[1])){
      task.dueDate=null;
      if(!draft.unresolved.some(d=>d.taskKey===task.key&&d.field==='dueDate'))draft.unresolved.push({taskKey:task.key,field:'dueDate',source:numbered[0],question:`What Date should I use for “${task.title}”? The weekday and “${numbered[0]}” conflict.`});
    }
    if(task.sessions.length&&!/\b(?:calendar|schedule|scheduled|scheduling)\b/i.test(scope))task.sessions=[];
    if(draft.unresolved.some(d=>d.taskKey===task.key&&d.field==='dueDate'))task.notes=task.notes.replace(/\b\d{4}-\d{2}-\d{2}\b/g,'unconfirmed date');
  }
  // Named profile destinations can be fragmented corrections. If the model
  // did not account for one, preserve it as a question instead of extra work.
  for(const mention of text.matchAll(/\b(?:update|make|create|edit|refresh)\s+(?:(?:my|the|a|an)\s+)?([\p{L}\p{N}]+)\s+profile\b/giu)){
    const name=normalize(mention[1]);
    if(['a','an','my','the','this','that','own','new'].includes(name))continue;
    if(!draft.tasks.some(t=>primaryTitle(t.title).split(' ').includes(name))&&!draft.unresolved.some(d=>normalize(d.source).split(' ').includes(name)))draft.unresolved.push({taskKey:null,field:'newTask',source:mention[0],question:`What did you mean by “${mention[1]} profile”? Is it additional work or a dictation correction?`});
  }
  // A bounded repair catches unrepresented request clauses. This checks only
  // coverage; interpretation and task creation remain the model's job.
  const represented=draft.tasks.map(t=>normalize(`${t.title} ${t.source}`)).concat(draft.unresolved.map(d=>normalize(d.source))).map(s=>new Set(s.split(' ')));
  for(const clause of text.split(/\b(?:i\s+(?:(?:also|definitely|really)\s+)*(?:need|want|have) to|i must)\b/i).slice(1)){
    const statement=clause.split(/[.!?]|\band then\b/i)[0];
    const topic=normalize(statement).split(' ').filter(word=>(word.length>2||/\d/.test(word))&&!common.has(word));
    if(topic.length&&!represented.some(words=>topic.some(word=>words.has(word))))errors.push(`Account for this commitment as a task or unresolved detail: ${statement.trim()}`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
  const calendarTasks=draft.tasks.map(t=>({...t,sourceFragments:[t.source]}));
  applyCalendarIntent(text,calendarTasks);
  calendarTasks.forEach((t,i)=>{draft.tasks[i].sessions=t.sessions;draft.tasks[i].dueDate=t.dueDate;});
  draft.unresolved=draft.unresolved.filter(detail=>!(detail.field==='sessions'&&draft.tasks.some(t=>t.key===detail.taskKey&&t.sessions.length)));

  return draft;
}

export async function extractWorkload(runtime:OllamaRuntime,text:string,today:string,timezone:string,signal:AbortSignal):Promise<Workload>{
  const messages:any[]=[{role:'system',content:`Extract all distinct actionable commitments from this dictated workload into JSON. Today=${today}; timezone=${timezone}; end of this week=${endOfWeek(today)}. This is the user's requested to-do list, not a conversation. Scan the entire transcript, including the end, and cross-check every described goal.
For each task supply a unique short key, concise specific title, original source fragment, notes, dueDate, sessions (an array of startDate/endDate/startTime/endTime), 0–4 steps only when explicitly requested for this task, and prerequisite task keys. Use a SHORT verbatim topic phrase for source (3–12 words), not a rewritten sentence or reconstructed introduction. Ignore repeated filler, abandoned fragments and restatements. Do not ignore an independent goal because it mentions the same service as another. Merge gathering background information and creating the preparation document when they describe the same work. Do not merge different emails. Every task, including complex research and document work, must have empty steps unless the user explicitly requests a checklist or breakdown for that particular task.
Dates belong ONLY to the task or session their phrase describes. dueDate is the independent optional deadline; leave null if no deadline was requested. Sessions are separate planned calendar events; use an empty array for task-only work. Explicit calendar placement can have a different date from the deadline and can contain multiple sessions. A dueDate alone never creates a session. Group requests add these 3 on the calendar schedule all three preceding tasks; add these 2 schedules two. Do not invent a deadline from a session date. If conflicting date wording is unresolved, retain a required question and leave that field empty. No work is saved until the entire batch is resolved and the user clicks Apply. Unclear proper names stay in notes. A name that might be additional work belongs in unresolved newTask, not an invented duplicate.
Dependencies connect described tasks. An explicitly requested preparation document is its own task, in addition to the output tasks; do not bury it in an output's checklist. Wording like from that preparation then indicates a prerequisite. When several outputs use the same preparation, each depends directly on it; do not invent a chain between independent outputs.
Each unresolved item needs an original source, a taskKey (null only for possible additional work), field and focused question. Optional research criteria do not block saving a research task. Every commitment must appear as a task or unresolved item. Return only schema-compliant JSON.`},{role:'user',content:text}];
  let lastError='';
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();
    const response=await runtime.call('chat',{model:runtime.model,messages,format:modelSchema,think:false,stream:false,keep_alive:-1,options:{...runtime.modelOptions,num_ctx:runtime.status.context,temperature:0,num_predict:3800}},signal,600000);
    try{return validateWorkload(JSON.parse(response.message?.content??''),text);}
    catch(error){lastError=error instanceof Error?error.message:'Invalid task extraction';messages.splice(2,messages.length,{role:'user',content:`The draft failed validation: ${lastError}. Return a complete corrected JSON draft grounded in the original transcript.`});}
  }
  throw new Error(`I could not validate the dictated tasks. No changes saved. ${lastError}`);
}

export function workloadChanges(draft:Workload){
  const ids=new Map(draft.tasks.map(t=>[t.key,randomUUID()]));
  const changes:Change[]=draft.tasks.map(t=>({action:'create',entity:'task',id:ids.get(t.key),fields:{title:t.title,notes:t.notes,dueDate:t.dueDate,steps:t.steps.map(title=>({id:randomUUID(),title,completed:false})),dependsOnIds:[...new Set(t.dependsOnKeys.map(key=>ids.get(key)!))]}}));
  for(const t of draft.tasks)for(const session of t.sessions)changes.push({action:'create',entity:'event',id:randomUUID(),fields:{...session,endDate:session.endDate??session.startDate,title:t.title,kind:'planned',linkedTaskId:ids.get(t.key)}});
  return {changes,questions:draft.unresolved.map(detail=>({question:detail.question,field:detail.field,taskId:detail.taskKey?ids.get(detail.taskKey)!:null}))};
}
