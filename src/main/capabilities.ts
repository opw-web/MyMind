import {Change,COLORS,DraftPreview,Receipt} from '../shared/model';
import {requestsNewProject} from './project-workflow';
import {projectGroupingIntent} from './project-grouping';
import {hasExplicitDeletion} from './deletion-intent';
import {viewActionParameters} from './assistant-view';
const entity={type:'string',enum:['all','event','task','project','section','category']};
const session={type:'object',properties:{startDate:{type:'string'},endDate:{type:'string'},startTime:{type:['string','null']},endTime:{type:['string','null']},linkedStepId:{type:['string','null']}},required:['startDate'],additionalProperties:false};
const fields={title:{type:'string'},notes:{type:'string'},textBox:{type:'string'},color:{type:'string',enum:COLORS},categoryTitle:{type:'string'},categoryId:{type:['string','null']},colorOverride:{type:['string','null'],enum:[...COLORS,null]},startDate:{type:'string'},endDate:{type:'string'},startTime:{type:['string','null']},endTime:{type:['string','null']},kind:{type:'string',enum:['planned','actual'],description:'Planned sessions and factual actual activity are independent.'},linkedTaskId:{type:['string','null']},linkedTaskTitle:{type:'string'},linkedStepId:{type:['string','null']},linkedStepTitle:{type:'string'},dueDate:{type:['string','null'],description:'Independent optional task deadline. Displayed as an all-day marker, never saved as an event.'},completed:{type:'boolean',description:'Task completion only; linked calendar controls route to task/step completion. Standalone events cannot complete.'},steps:{type:'array',description:'Only edit when requested. Retrieve existing steps first and retain their IDs.',items:{type:'object',properties:{id:{type:'string'},title:{type:'string'},completed:{type:'boolean'}},required:['title'],additionalProperties:false}},dependsOnIds:{type:'array',items:{type:'string'}},dependsOnTitles:{type:'array',items:{type:'string'}},projectId:{type:'string'},sectionId:{type:['string','null']},projectTitle:{type:'string'},sectionTitle:{type:'string'},order:{type:'integer'}};
type PlannerAction=Change['action']|'restore';
const mutationActions:Change['action'][]=['create','update','delete'];
function stageChanges(actions:readonly Change['action'][],bloom=false){
  const identity={entity:{type:'string',enum:entity.enum.filter(value=>value!=='all'&&(!bloom||value!=='section'))},id:{type:'string'}};
  const attributes=bloom?{
    ...Object.fromEntries(Object.entries(fields).filter(([name])=>!['textBox','dependsOnIds','dependsOnTitles','sectionId','sectionTitle','order'].includes(name))),
    dueDate:{type:['string','null'],description:'Task due date, independent of calendar blocks.'},
    priority:{type:'string',enum:['','Low','Medium','High']},estimate:{type:'string'},
  }:fields;
  const editable=actions.filter(action=>action!=='delete');
  const branches=[];
  if(editable.length&&bloom){
    const editableFields={
      project:['title'],
      task:['title','projectId','projectTitle','steps','dueDate','completed','priority','estimate','notes','categoryId','colorOverride'],
      event:['title','kind','startDate','endDate','startTime','endTime','linkedTaskId','linkedTaskTitle','linkedStepId','linkedStepTitle','notes','categoryId','colorOverride'],
      category:['title','color']
    };
    for(const [name,names] of Object.entries(editableFields)){
      const properties=Object.fromEntries(Object.entries(attributes).filter(([field])=>names.includes(field)));
      branches.push({type:'object',properties:{action:{type:'string',enum:editable},...identity,entity:{type:'string',enum:[name]},...properties},required:['action','entity'],additionalProperties:false});
    }
  }else if(editable.length)branches.push({type:'object',properties:{action:{type:'string',enum:editable},...identity,...attributes},required:['action','entity'],additionalProperties:false});
  if(actions.includes('delete'))branches.push({type:'object',properties:{action:{type:'string',enum:['delete']},...identity},required:['action','entity','id'],additionalProperties:false});
  return {name:'stage_changes',description:'Validate and accumulate a proposed batch. Sessions are event records and may link to a task and step. Forward references to new tasks and steps are resolved within the batch. Preserve independent session content and dates on task edits. For deletion send only action, entity, and the verified ID. No saving occurs.',parameters:{type:'object',properties:{changes:{type:'array',items:branches.length===1?branches[0]:{anyOf:branches}}},required:['changes'],additionalProperties:false}};
}
export const PLANNER_CAPABILITIES=[
 {mutation:true,type:'function',function:{name:'stage_tasks',description:'Prepare tasks supported by the request. Each task can have multiple independent planned sessions, separate from its optional deadline. Reuse verified IDs for corrections through stage_changes. Keys identify new tasks within THIS request only.',parameters:{type:'object',properties:{tasks:{type:'array',items:{type:'object',properties:{key:{type:'string'},sourceFragments:{type:'array',items:{type:'string'}},title:{type:'string'},dateEvidence:{type:['string','null']},dueDate:{type:['string','null']},sessions:{type:'array',items:session},calendarEvidence:{type:['string','null']},steps:{type:'array',items:{type:'string'}},prerequisiteKeys:{type:'array',items:{type:'string'}},categoryTitle:{type:'string'},notes:{type:'string'}},required:['key','sourceFragments','title','dateEvidence','dueDate','sessions','calendarEvidence','steps','prerequisiteKeys','categoryTitle'],additionalProperties:false}}},required:['tasks'],additionalProperties:false}}},
 {mutation:false,type:'function',function:{name:'find_items',description:'Read projected planner records, including pending proposals. due filters task deadlines; scheduled filters linked sessions; either includes both. kind selects planned or actual events/sessions. Query contains title words only; date filters are separate. Paginate and use exact returned IDs.',parameters:{type:'object',properties:{entity,query:{type:'string'},date:{type:'string'},dateKind:{type:'string',enum:['due','scheduled','either']},kind:{type:'string',enum:['planned','actual']},endDate:{type:'string'},categoryId:{type:'string'},projectId:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['entity','query']}}},
 {mutation:true,type:'function',function:stageChanges(mutationActions)},
 {mutation:true,type:'function',function:{name:'preview_changes',description:'Publish the complete valid proposed batch for the user to review. This NEVER saves. Only the user pressing Apply can save.',parameters:{type:'object',properties:{},additionalProperties:false}}},
 {mutation:true,type:'function',function:{name:'restore_item',description:'Propose restoration of an exact deleted task/event from this chat. Use a supplied deleted ID; never guess original fields.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}},
 {mutation:true,type:'function',function:{name:'undo_changes',description:'Propose the inverse of the latest actually applied batch from this chat, bound to that exact history head. Can compose with subsequent draft edits. No saving occurs.',parameters:{type:'object',properties:{expectedRevision:{type:'integer'}},required:['expectedRevision'],additionalProperties:false}}},
 {mutation:false,type:'function',function:{name:'finish_request',description:'Finish with no changes or a necessary clarification. Required questions block Apply for the entire batch; never partially save clear work.',parameters:{type:'object',properties:{outcome:{type:'string',enum:['no_change','clarification']},message:{type:'string'},targetIds:{type:'array',items:{type:'string'}}},required:['outcome','message'],additionalProperties:false}}}
];
export function toolDefinitions(writable:boolean,independentSessions=false,actions?:ReadonlySet<PlannerAction>,autoApply=false,viewActions=false){
  const changes=actions?mutationActions.filter(action=>actions.has(action)):mutationActions;
  return PLANNER_CAPABILITIES.flatMap(({mutation,...definition})=>{
    if(mutation&&!writable)return [];
    switch(definition.function.name){
      case 'stage_tasks':if(independentSessions||actions&&!actions.has('create'))return [];break;
      case 'stage_changes':if(!changes.length)return [];return [{...definition,function:stageChanges(changes,autoApply)}];
      case 'undo_changes':if(actions&&!actions.has('restore'))return [];break;
      case 'restore_item':if(actions&&!actions.has('restore'))return [];break;
      case 'preview_changes':if(autoApply)return [];break;
      case 'finish_request':if(autoApply)return [{...definition,function:{...definition.function,
        description:'Apply the complete staged batch immediately with outcome=apply. No user confirmation is needed. Use clarification only for a required missing detail. Use no_change for a read-only answer.',
        parameters:{type:'object',properties:{outcome:{type:'string',enum:writable?['apply','no_change','clarification']:['no_change','clarification']},message:{type:'string'},targetIds:{type:'array',items:{type:'string'}},...(viewActions?{viewActions:viewActionParameters}:{})},required:['outcome','message'],additionalProperties:false}
      }}];break;
    }
    return [definition];
  });
}
export const PLANNER_HELP='Tasks have optional independent deadlines displayed as all-day Deadline markers. A task can have many planned or actual calendar sessions, optionally linked to a checklist step. Sessions own their titles, notes, dates and times. Editing deadlines never moves sessions. Deleting tasks or steps detaches their sessions. Standalone events have no completion control. Task completion displays across linked blocks and deadline markers; step completion is independent. Completed tasks archive after 24 hours while their calendar blocks remain. Projects and sections organize work; categories provide reusable labels and colors. The assistant prepares one editable preview. Corrections and new requests join it; questions use its projected state. Review and Apply saves the whole batch once. Required questions must be resolved first. Dismiss or New chat clears proposals; Stop preserves the last valid preview. Manual editing and Undo remain immediate. Voice stays local.';
export function plannerExplanation(text:string,autoApply=false):string|undefined{
 if(/\b(how|explain|walk me through)\b/i.test(text)&&/\b(to[ -]?do(?: list)?|2dlest|2d list)\b/i.test(text))return autoApply?'Tasks can stand alone or belong to a project. You can add checklist steps, a due date, a priority, an estimate, a category, and notes. A due date is separate from scheduled time. A linked task can have multiple blocks on the same calendar. Check off tasks and steps independently. The assistant saves a complete request and shows a preview for each changed item, with an individual undo button. Voice stays local.':PLANNER_HELP;
}
export function savedReply(receipt:Receipt,restored=false):string{
  const items=receipt.items?.filter(item=>item.entity!=='category')??[];
  if(receipt.label.startsWith('Undid '))return 'I undid the last planner change.';
  if(!items.length)return 'Your category changes are saved.';
  if(items.length>1){const tasks=items.filter(i=>i.entity==='task'),events=items.filter(i=>i.entity==='event'),projects=items.filter(i=>i.entity==='project'&&i.action==='create');if(projects.length===1&&!events.length)return `Created “${projects[0].title}”${tasks.length?` and saved ${tasks.length} task${tasks.length===1?'':'s'}`:''}.`;if(tasks.length===1&&events.length===1)return `I saved ${tasks[0].title} in your to-do list and calendar.`;return `Done. I saved ${tasks.length} task${tasks.length===1?'':'s'}${events.length?` and ${events.length} calendar event${events.length===1?'':'s'}`:''} together.`;}
  const item=items[0],title=`“${item.title}”`;
  if(restored)return `I brought ${title} back.`;
  if(item.action==='delete')return `I removed ${title}.`;
  if(item.action==='create')return `I added ${title} to ${item.entity==='task'?'your to-do list':item.entity==='event'?'your calendar':'your projects'}.`;
  if(receipt.descriptions.some(d=>d.startsWith('Completed task:')))return `Marked ${title} done.`;
  if(receipt.descriptions.some(d=>d.startsWith('Reopened task:')))return `${title} is back on your to-do list.`;
  return `I updated ${title}.`;
}
export function authorizedActions(text:string):Set<'create'|'update'|'delete'|'restore'>{
  const actions=new Set<'create'|'update'|'delete'|'restore'>();
  if(hasExplicitDeletion(text))actions.add('delete');
  if(projectGroupingIntent(text)){actions.add('create');actions.add('update');}
  if(requestsNewProject(text))actions.add('create');
  if(/^(?:what\s+)?b(?:r)?ing\s+it\s+back[.?!,\s]*$/i.test(text.trim()))return new Set(['restore']);
  const taskGoals=/\b(?:add|create|make|put)\b.{0,45}\b(?:tasks|to-do list|to do list)\b/i.test(text);
  const clauses=text.replace(/["“][^"”]*["”]/g,' ').split(/[.;!?\n]|\b(?:and|but|then)\b|,\s*(?=(?:explain|walk me through|tell me|how|why|what|where|when)\b)/i);
  for(const raw of clauses){const clause=raw.trim();
    if(/^(?:do|did|should|would|could|can|will)\s+(?:i|we)\b|^(?:suppose|imagine)\b|^if\s+i\s+(?:needed|wanted|were|would|could)\b/i.test(clause))continue;
    if(/^(?:why|how|what|where|when|who)\b|\b(?:i wonder|wondering|tell me why|help me understand)\b/i.test(clause))continue;
    if(/\b(don['’]?t|do not|never|shouldn['’]?t|not to|without|how (?:do|can|would|should)|what (?:if|would)|explain|walk me through|tell me how|can i|could i|(?:need|want) to (?:know|understand|learn)|have to ask)\b/i.test(clause))continue;
    const workload=/\b(?:i (?:(?:also|definitely|really)\s+)*(?:need|have|want) to|i must|remind me to|remember to)\s+(?:buy|write|read|finish|prepare|prep|study|submit|build|print|3d print|pay|pick up|call|book|clean|review|send|complete|take|ensure|research|explore|apply|renew|visit|update|make|go|collect|look)\b/i.test(clause)||(taskGoals&&/^(?:update|connect|publish|post|review|research)\b/i.test(clause));
    if(/\b(add|create|schedule|remind me|put|make (?:a|an|the|me))\b/i.test(clause)||/^(?:please\s+)?submit\b.*\b(by|before|tomorrow|today)\b/i.test(clause))actions.add('create');
    if(/\b(move|reschedule|update|change|rename|recolor|categorize|organize|mark|complete|reopen|set|tick|uncheck|check off)\b/i.test(clause)&&!workload)actions.add('update');
    if(/\b(delete|remove|erase)\b/i.test(clause))actions.add('delete');
    if(/\b(restore|undo|bring.{0,25}back|bing.{0,25}back)\b/i.test(clause))actions.add('restore');
    if(workload||/^(?:please\s+)?record\b.*\b(?:actual|activities|activity|sleep|work|session|sessions)\b/i.test(clause))actions.add('create');
    if(/\b(?:help me|please|can you|could you)\s+(?:plan|break down|split)\b/i.test(clause))actions.add('create');
  }return actions;
}


export function previewReply(preview:DraftPreview,_restored=false):string {
 const items=preview.draft.items.filter(item=>item.entity!=='category');
 return `Preview ready: ${items.length} proposed change${items.length===1?'':'s'}${items.length?': '+items.slice(0,4).map(item=>item.title).join(', '):''}. Review and Apply to save.${preview.draft.unresolved.some(i=>i.required)?' Resolve the draft questions first.':''}`;
}
