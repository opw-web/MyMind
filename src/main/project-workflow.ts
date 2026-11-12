import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Change} from '../shared/model';
import {OllamaRuntime} from './ollama';

export function requestsNewProject(text:string):boolean {
  return text.split(/[.!?;\n]/).some(clause=>
    !/\b(?:don['’]?t|do not|never|without)\b|^\s*(?:why|how|what|when|does|is|are|suppose|imagine)\b|^\s*(?:(?:can|could|should|would|will|do|did)\s+(?:i|we)|if\s+i)\b/i.test(clause)
    && /^(?:\s*so[, ]+)?\s*new project\b|\b(?:create|make|add|start|set up)\s+(?:me\s+)?(?:a\s+|the\s+|new\s+|a new\s+)?project\b(?!\s+(?:brief|plan|report|document|proposal|outline|budget)\b)/i.test(clause));
}

// A supplied sequence already requests steps; internal order is not a blocker.
export function requestsProjectWorkflow(text:string):boolean {
  return requestsNewProject(text)
    && !/\b(?:separate|individual|different|multiple)\s+tasks?\b|\b(?:tasks|to[ -]?do list)\b|\b(?:no|without)\s+(?:steps|checklist)\b|\b(?:don['’]?t|do not|never)\b.{0,35}\b(?:steps|checklist)\b/i.test(text)
    && /\bfirst\b/i.test(text)
    && /\b(?:then|thaen|next|after|finally)\b/i.test(text)
    && !/\b(?:calendar|schedule|scheduled|due|deadline|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(text);
}

const title=z.string().trim().min(1).max(240);
const schema=z.object({
  projectTitle:title,
  taskTitle:title,
  categoryTitle:z.string().trim().min(1).max(80),
  steps:z.array(z.object({title,source:z.string().trim().min(1).max(600)}).strict()).min(2).max(100)
}).strict();
// Avoid expanding bounds into thousands of model grammar rules.
const modelSchema=JSON.parse(JSON.stringify(z.toJSONSchema(schema),(key,value)=>['minLength','maxLength','minItems','maxItems'].includes(key)?undefined:value));
const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export function projectWorkflowChanges(value:unknown,text:string):Change[] {
  const workflow=schema.parse(value),request=normalize(text);
  let previous=-1;
  for(const step of workflow.steps){
    const source=normalize(step.source),position=request.indexOf(source);
    if(source.split(' ').length<3||position<0)throw new Error('Each step needs a verbatim source phrase of at least three words from the request.');
    if(position<=previous)throw new Error('Keep all supplied steps in their original order, without duplicates.');
    previous=position;
  }
  // Each narrated action must be represented, including a final "then" that
  // the model might otherwise omit. Background sentences are not new steps.
  const action=/\b(?:first|then|thaen|next|finally)\b.{0,80}\b(?:make|create|write|prepare|go|complete|update|post|choose|practice|research|review|build|finish|submit|send|publish|enroll|buy|collect)\b/i;
  const quoted=workflow.steps.map(step=>normalize(step.source));
  for(const sentence of text.split(/[.!?;\n]/)){
    if(action.test(sentence)&&!quoted.some(source=>normalize(sentence).includes(source)))throw new Error(`Include the supplied action: ${sentence.trim()}`);
  }
  const projectId=randomUUID();
  return [
    {action:'create',entity:'project',id:projectId,fields:{title:workflow.projectTitle}},
    {action:'create',entity:'task',id:randomUUID(),fields:{title:workflow.taskTitle,projectId,categoryTitle:workflow.categoryTitle,notes:text,dueDate:null,dependsOnIds:[],steps:workflow.steps.map(step=>({id:randomUUID(),title:step.title,completed:false}))}}
  ];
}

export async function extractProjectWorkflow(runtime:OllamaRuntime,text:string,signal:AbortSignal):Promise<Change[]> {
  const messages:any[]=[{role:'system',content:`Extract this new project and its user-supplied workflow as JSON. Use the stated topic itself as a concise projectTitle; preserve an explicitly named project, and do not append generic words like Planning or Exploration. Use one practical taskTitle of at most 10 words describing the overall outcome rather than listing all actions. Supply a reusable categoryTitle and all supplied actions as ordered checklist steps inside that task. "First ... after ... then ..." supplies steps even without saying "checklist". Do not create separate tasks or prerequisites for these internal steps. Preserve each described action and its meaning, including the final action. Each step source must be a short verbatim phrase of at least three words from the original request, in narration order. Step titles should clean up dictation and spelling. Do not invent extra actions or ask for optional setup. Return only schema-compliant JSON.`},{role:'user',content:text}];
  let lastError='';
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();
    const response=await runtime.call('chat',{model:runtime.model,messages,format:modelSchema,think:false,stream:false,keep_alive:-1,options:{...runtime.modelOptions,num_ctx:runtime.status.context,temperature:0,num_predict:4096}},signal,600000);
    try{return projectWorkflowChanges(JSON.parse(response.message?.content??''),text);}
    catch(error){lastError=error instanceof Error?error.message:'Invalid project workflow';messages.splice(2,messages.length,{role:'user',content:`Repair the complete workflow: ${lastError}. Include every action from the original request.`});}
  }
  throw new Error(`I could not validate the project workflow. No changes saved. ${lastError}`);
}
