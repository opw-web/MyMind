import { randomUUID } from 'node:crypto';
import { Change, Entity, Snapshot } from '../shared/model';
import {categorizeChanges} from './categories';

const stable = (value: Record<string,unknown> | undefined): string => JSON.stringify(value,Object.keys(value??{}).sort());
const key = (value:string):string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
type Reference = { id:string; title:string; projectId?:string };
function resolveReference(ref: string, records: Reference[], kind:string, byTitle=false): Reference {
  if (!byTitle) { const exact=records.find(record=>record.id===ref);if(exact)return exact; }
  const normalized=key(ref);
  const matches=records.filter(record=>byTitle ? record.title.trim().toLowerCase()===ref.trim().toLowerCase() : ['', 'newid', 'id', 'new', `${kind}id`].some(suffix=>normalized===key(record.title)+suffix));
  const distinct=matches.filter((record,index)=>matches.findIndex(other=>other.id===record.id)===index);
  if(distinct.length===1)return distinct[0];
  if(distinct.length>1)throw new Error(`Several ${kind}s match “${ref}”. Ask which one; no changes saved.`);
  throw new Error(`Cannot find ${kind} “${ref}”. Use its returned ID or its exact title.`);
}

// Resolve titles and temporary references against the whole draft. The model
// never gets to write guessed foreign keys into the database.
export function prepareDraft(snapshot:Snapshot,previous:Change[],incoming:Change[]):Change[] {
  const accumulatedSteps=new Map(previous.filter(change=>change.entity==='task'&&change.action!=='delete'&&change.id&&Array.isArray(change.fields?.steps)).map(change=>[change.id!,structuredClone(change.fields!.steps) as Snapshot['tasks'][number]['steps']]));
  let combined:Change[]=previous.map(change=>({...change,fields:change.fields?{...change.fields}:undefined}));
  for(const source of incoming){
    const change={...source,fields:source.fields?{...source.fields}:undefined};
    const prior=change.id?combined.findIndex(item=>item.entity===change.entity&&item.id===change.id):-1;
    if(prior>=0){const old=combined[prior];if(old.action==='create'&&change.action==='delete')combined.splice(prior,1);else if((change.action==='update'||change.action==='create'&&old.action==='create')&&old.action!=='delete')combined[prior]={...old,fields:{...old.fields,...change.fields}};else if(change.action==='delete')combined[prior]=change;}
    else combined.push(change);
  }
  // Cancelling an unsaved task creation leaves its sessions as independent records,
  // just as deleting a saved task does. Resolve no foreign keys against that removed creation.
  const cancelledTasks=new Set(incoming.filter(c=>c.entity==='task'&&c.action==='delete'&&previous.some(p=>p.entity==='task'&&p.id===c.id&&p.action==='create')).map(c=>c.id!));
  for(const change of combined){const fields=change.fields;if(!fields)continue;
    if(typeof fields.linkedTaskId==='string'&&cancelledTasks.has(fields.linkedTaskId)){fields.linkedTaskId=null;fields.linkedStepId=null;delete fields.linkedStepTitle;}
    if(Array.isArray(fields.dependsOnIds))fields.dependsOnIds=fields.dependsOnIds.filter(id=>!cancelledTasks.has(String(id)));
  }
  combined.forEach(change=>{if(change.action==='create'&&!change.id)change.id=randomUUID();});
  const replacements=new Map<string,string>();
  function dedupe(entity:Entity){
    const found=new Map<string,Change>();
    combined=combined.filter(change=>{
      if(change.entity!==entity||change.action!=='create')return true;
      const base=entity==='task'?{notes:'',textBox:'',color:'sage',dueDate:null,scheduledDate:null,completed:false,projectId:'inbox',sectionId:null}:entity==='event'?{kind:'planned',linkedStepId:null,completed:false,linkedTaskId:null,notes:'',textBox:'',color:'coral',startTime:null,endTime:null,endDate:change.fields?.startDate}:{};
      const canonical={...base,...change.fields,title:String(change.fields?.title??'').trim().toLowerCase()};
      const {order:_order,...identityFields}=canonical as Record<string,unknown>;
      if(entity==='task'&&Array.isArray(identityFields.steps))identityFields.steps=identityFields.steps.map(({id:_id,...step})=>({completed:false,...step}));
      const identity=stable(identityFields),earlier=found.get(identity);
      if(earlier){replacements.set(change.id!,earlier.id!);return false;}
      found.set(identity,change);return true;
    });
  }
  function replaceReferences(){for(const change of combined){if(change.id&&replacements.has(change.id))change.id=replacements.get(change.id);for(const name of ['projectId','sectionId','linkedTaskId'])if(typeof change.fields?.[name]==='string'&&replacements.has(change.fields[name] as string))change.fields[name]=replacements.get(change.fields[name] as string);if(Array.isArray(change.fields?.dependsOnIds))change.fields.dependsOnIds=[...new Set(change.fields.dependsOnIds.map(id=>replacements.get(String(id))??id))];}}
  dedupe('project');replaceReferences();
  const projects:Reference[]=[...snapshot.projects,...combined.filter(change=>change.action==='create'&&change.entity==='project').map(change=>({id:change.id!,title:String(change.fields?.title??'')}))];
  for(const change of combined){
    const fields=change.fields;if(!fields)continue;
    if(fields.projectTitle!==undefined){fields.projectId=resolveReference(String(fields.projectTitle),projects,'project',true).id;delete fields.projectTitle;}
    else if(fields.projectId!==undefined)fields.projectId=resolveReference(String(fields.projectId),projects,'project').id;
  }
  dedupe('section');replaceReferences();
  const sections:Reference[]=[...snapshot.sections,...combined.filter(change=>change.action==='create'&&change.entity==='section').map(change=>({id:change.id!,title:String(change.fields?.title??''),projectId:change.fields?.projectId as string}))];
  for(const change of combined){
    const fields=change.fields;if(!fields||change.entity!=='task')continue;
    const candidates=fields.projectId?sections.filter(section=>section.projectId===fields.projectId):sections;
    let section:Reference|undefined;
    if(fields.sectionTitle!==undefined){section=resolveReference(String(fields.sectionTitle),candidates,'section',true);delete fields.sectionTitle;}
    else if(fields.sectionId)section=resolveReference(String(fields.sectionId),candidates,'section');
    if(section){fields.sectionId=section.id;if(fields.projectId===undefined)fields.projectId=section.projectId;}
  }
  dedupe('task');dedupe('event');replaceReferences();
  const tasks:Reference[]=[...snapshot.tasks,...combined.filter(c=>c.action==='create'&&c.entity==='task').map(c=>({id:c.id!,title:String(c.fields?.title??'')}))];
  for(const change of combined)if(change.entity==='task'&&change.fields){
    const fields=change.fields;
    if(Array.isArray(fields.dependsOnTitles)){
      fields.dependsOnIds=fields.dependsOnTitles.map(title=>resolveReference(String(title),tasks,'task',true).id);
      delete fields.dependsOnTitles;
    }else if(Array.isArray(fields.dependsOnIds))fields.dependsOnIds=fields.dependsOnIds.map(id=>resolveReference(String(id),tasks,'task').id);
    if(Array.isArray(fields.steps)){
      const previousSteps=accumulatedSteps.get(change.id!)??snapshot.tasks.find(task=>task.id===change.id)?.steps??[];
      fields.steps=fields.steps.map((step,index)=>{
        if(step.id)return {completed:false,...step};
        const matches=previousSteps.filter(old=>key(old.title)===key(String(step.title)));
        if(matches.length>1)throw new Error('Several checklist steps match. Use verified step IDs.');
        const existing=matches[0]??(previousSteps.length===(fields.steps as unknown[]).length?previousSteps[index]:undefined);
        return {id:existing?.id??randomUUID(),completed:existing?.completed??false,...step};
      });
    }
  }
  for(const change of combined)if(change.entity==='event'&&change.fields){
    const fields=change.fields;
    if(fields.linkedTaskTitle!==undefined){fields.linkedTaskId=resolveReference(String(fields.linkedTaskTitle),tasks,'task',true).id;delete fields.linkedTaskTitle;}
    else if(fields.linkedTaskId)fields.linkedTaskId=resolveReference(String(fields.linkedTaskId),tasks,'task').id;
    if(fields.linkedStepId||fields.linkedStepTitle){
      const taskId=fields.linkedTaskId??snapshot.events.find(e=>e.id===change.id)?.linkedTaskId;
      const task=combined.find(c=>c.entity==='task'&&c.id===taskId&&c.action!=='delete');
      const steps=(task?.fields?.steps??snapshot.tasks.find(t=>t.id===taskId)?.steps??[]) as {id:string;title:string}[];
      fields.linkedStepId=resolveReference(String(fields.linkedStepTitle??fields.linkedStepId),steps,'step',fields.linkedStepTitle!==undefined).id;delete fields.linkedStepTitle;
    }
  }
  // Parents must exist before their children, even if the model ordered them differently.
  // Preserve normalized item/category order; category deletion has item side effects.
  const rank=(change:Change)=>change.action==='create'&&change.entity==='project'?0:change.action==='create'&&change.entity==='section'?1:2;
  combined=categorizeChanges(snapshot,combined);dedupe('task');dedupe('event');replaceReferences();
  return combined.sort((a,b)=>rank(a)-rank(b));
}

export function searchWords(query:string):string[] {
  const stops=new Set(['mark','complete','completed','finish','finished','done','the','a','an','my','please','task','tasks','event','events','as','is','are','show','find','me','in','project','section','due','on','for','delete','remove','today','tomorrow','yesterday','this','that']);
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word=>word&&!stops.has(word));
}
