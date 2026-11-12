import {randomUUID} from 'node:crypto';
import {Change,Selection,Snapshot,Task} from '../shared/model';
import {isDate,shiftDate,todayIn,weekday} from '../shared/dates';

export interface PlannerReference {entity:'event'|'task';id:string;linkedTaskId?:string|null}
export interface ReferenceGroup {turn:number;key:string;records:PlannerReference[]}
export interface ProjectGroupingIntent {text:string;targetText:string;title?:string;count?:number;requiresTools?:boolean}
export type GroupingResolution={tasks:Task[]}|{question:string};
const numbers:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
const countPattern='\\d+|one|two|three|four|five|six|seven|eight|nine|ten';
const cleanTitle=(value:string)=>value.trim().replace(/[.!?]+$/,'').trim().replace(/^["“](.*)["”]$/,'$1').trim();
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

// Recognize assignment of existing work, separately from describing new work.
// A count is a constraint on a verified group, never a way to select arbitrary rows.
export function projectGroupingIntent(text:string):ProjectGroupingIntent|undefined{
  if(!/\bproject\b/i.test(text))return;
  const clauses=text.split(/[.!?;\n]/).filter(clause=>
    !/^\s*(?:why|how|what|when|where|who|explain|suppose|imagine|if|does|is|are)\b|^\s*(?:can|could|would|should|will|do|did)\s+(?:i|we)\b/i.test(clause)
    && !/\b(?:don['’]?t|do not|never|shouldn['’]?t|without|what if|wonder|understand|know how)\b/i.test(clause));
  const request=clauses.map(clause=>clause.trim()).filter(Boolean).join('. ');
  const existing=/\b(?:these|those|the)\s+(?:(?:existing|same|linked|connected|selected|all)\s+)*(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:tasks?|events?)\b|\b(?:them|these|those|it|selected task|selected event)\b|\ball\s+(?:of\s+)?(?:my\s+)?(?:tasks|events)\b/i.test(request);
  const assignment=/\b(?:put|move|group|organize|assign|place|include|add)\b[^.!?]*\b(?:in|into|under|to|within)\b[^.!?]*\bproject\b/i.test(request);
  const desire=/\b(?:i|we)\s+(?:want|need|would like)\b[^.!?]*\b(?:tasks?|events?|them|these|those|it)\b[^.!?]*\b(?:in|into|under|within)\b[^.!?]*\bproject\b/i.test(request);
  if(!(assignment||desire)||(!existing&&!/\b(?:move|group|organize|assign|place)\b/i.test(request)))return;
  let title:string|undefined,targetText=request;
  const naming=/\b(?:name|call)\s+(?:the |this |that |my |new )?project\s+([\s\S]+)$|\bproject\s+(?:called|named)\s+([\s\S]+)$/i.exec(request);
  if(naming){title=cleanTitle(naming[1]?.replace(/^(?:to be|as)\s+/i,'')??naming[2]);targetText=request.slice(0,naming.index).replace(/\b(?:in|into|under|to|within)\s+(?:(?:a|an|the|my|our|new|existing)\s+)*$/i,'').trim();}
  else{
    const destination=/\b(?:in|into|under|to|within)\s+(?:(?:a|an|the|my|our|new|existing)\s+)*project(?:\s+([\s\S]+))?$/i.exec(request)
      ?? /\b(?:in|into|under|to|within)\s+(?:(?:the|my|our|existing)\s+)?([\s\S]+\bproject)$/i.exec(request);
    if(destination){if(destination[1])title=cleanTitle(destination[1]);targetText=request.slice(0,destination.index);}
  }
  // The direct path only assigns existing work. New commitments or other
  // requested edits need the full assistant, even when "put it in a project"
  // appears as one part of the message.
  const groupingLead=new RegExp(`^(?:so[, ]+)?(?:please\\s+)?(?:(?:(?:can|could|would) you\\s+)?(?:move|put|group|organize|assign|place|include|add)\\b|(?:i|we)\\s+(?:want|need|would like)\\s+(?:the|these|those|it|them|all|tasks?|events?|${countPattern})\\b|(?:the|these|those|all)\\s+(?:(?:${countPattern}|existing|linked|connected)\\s+)*(?:tasks?|events?)\\b)`,'i').test(request);
  const additionalWork=!groupingLead||/\b(?:add|schedule|create)\b[^.!?;]{0,120}\b(?:calendar|events?|tasks?)\b|\bi\s+(?:also\s+)?have\b|\bi\s+(?:also\s+)?(?:need|want|have) to\s+(?:submit|finish|prepare|write|buy|build|research|review|complete|send|post|study|take|collect|print)\b|\b(?:change|update|set|remove|delete|mark|complete|reopen|reschedule)\b[^.!?;]{0,70}\b(?:deadline|due date|notes|steps|completed?|done|calendar)\b/i.test(request);
  const requiresTools=additionalWork||!!title&&/(?:[.;]\s*|\s+(?:and|then)\s+)(?:please\s+)?(?:add|create|move|mark|complete|delete|remove|schedule|update|rename|set)\b/i.test(title);
  const countMatch=new RegExp(`\\b(${countPattern})\\s+(?:linked\\s+|existing\\s+|connected\\s+)?(?:tasks?|events?)\\b|\\b(?:these|those)\\s+(${countPattern})\\b`,'i').exec(targetText);
  const countToken=countMatch?.[1]??countMatch?.[2];
  return {text,targetText,title,count:countToken?(numbers[countToken.toLowerCase()]??Number(countToken)):undefined,...(requiresTools?{requiresTools:true}:{})};
}

export function rememberGroup(groups:ReferenceGroup[],turn:number,key:string,records:PlannerReference[]):void{
  let group=groups.find(g=>g.turn===turn&&g.key===key);
  if(!group){group={turn,key,records:[]};groups.push(group);}
  const pointers=records.map(({entity,id,linkedTaskId}):PlannerReference=>({entity,id,...(entity==='event'?{linkedTaskId}: {})}));
  group.records=[...new Map([...group.records,...pointers].map(r=>[`${r.entity}:${r.id}`,r])).values()];
  if(groups.length>24)groups.splice(0,groups.length-24);
}

function linkedTasks(snapshot:Snapshot,refs:PlannerReference[]):GroupingResolution{
  const ids=new Set<string>();
  for(const ref of refs){
    if(ref.entity==='task'){
      if(!snapshot.tasks.some(t=>t.id===ref.id))return {question:'One of the referenced tasks no longer exists. Which tasks should I group?'};
      ids.add(ref.id);
    }else{
      const event=snapshot.events.find(e=>e.id===ref.id);
      if(!event)return {question:'One of the referenced events no longer exists. Which tasks should I group?'};
      if(!event.linkedTaskId||!snapshot.tasks.some(t=>t.id===event.linkedTaskId))return {question:`“${event.title}” has no linked task. Which existing tasks should go in the project?`};
      ids.add(event.linkedTaskId);
    }
  }
  return {tasks:snapshot.tasks.filter(t=>ids.has(t.id))};
}

function datedGroup(text:string,snapshot:Snapshot):GroupingResolution|undefined{
  const dates='today|tomorrow|yesterday|(?:(?:this|next) )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d{4}-\\d{2}-\\d{2}';
  const matches=[...text.matchAll(new RegExp(`\\b(?:events?|tasks?)\\b[^.!?]{0,45}?\\b(${dates})\\b|\\b(today|tomorrow|yesterday)['’]s\\s+(?:events?|tasks?)\\b`,'gi'))];
  if(!matches.length)return;
  const today=todayIn(snapshot.preferences.timezone),resolved=new Set<string>();
  for(const match of matches){
    const token=(match[1]??match[2]).toLowerCase();
    if(token==='today')resolved.add(today);
    else if(token==='tomorrow')resolved.add(shiftDate(today,1));
    else if(token==='yesterday')resolved.add(shiftDate(today,-1));
    else if(/^\d{4}-/.test(token)){
      if(!isDate(token))return {question:'Which valid calendar date should I use to identify the tasks?'};
      resolved.add(token);
    }else{
      const day=token.replace(/^(?:this|next) /,'').slice(0,3);
      for(let offset=token.startsWith('next ')?1:0;offset<8;offset++)if(weekday(shiftDate(today,offset)).toLowerCase()===day){resolved.add(shiftDate(today,offset));break;}
    }
  }
  if(resolved.size!==1)return {question:'Which date identifies the group you want to move?'};
  const date=[...resolved][0];
  if(/\b(?:events?|calendar)\b/i.test(text))return linkedTasks(snapshot,snapshot.events.filter(e=>e.startDate<=date&&e.endDate>=date).map(e=>({entity:'event',id:e.id,linkedTaskId:e.linkedTaskId})));
  return {tasks:snapshot.tasks.filter(t=>/\b(?:due|deadline)\b/i.test(text)?t.dueDate===date:t.dueDate===date||t.scheduledDate===date)};
}

export function resolveGroupingTasks(intent:ProjectGroupingIntent,snapshot:Snapshot,groups:ReferenceGroup[],selection?:Selection):GroupingResolution{
  const text=intent.targetText.toLowerCase();
  const pool:PlannerReference[]=[...snapshot.tasks.map(t=>({entity:'task' as const,id:t.id,title:t.title})),...snapshot.events.map(e=>({entity:'event' as const,id:e.id,title:e.title,linkedTaskId:e.linkedTaskId}))];
  let named=pool.filter(ref=>{
    const record=ref.entity==='task'?snapshot.tasks.find(t=>t.id===ref.id)!:snapshot.events.find(e=>e.id===ref.id)!;
    const contains=(value:string)=>{
      const needle=value.toLowerCase();let index=text.indexOf(needle);
      while(index>=0){
        if(!/[\p{L}\p{N}]/u.test(text[index-1]??'')&&!/[\p{L}\p{N}]/u.test(text[index+needle.length]??''))return true;
        index=text.indexOf(needle,index+1);
      }
      return false;
    };
    return contains(record.title)||contains(ref.id);
  });
  let result:GroupingResolution;
  const dated=datedGroup(text,snapshot);
  if(named.length){
    const command=/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:move|group|organize|assign|place|put|include|add)\s+([\s\S]+)$/i.exec(intent.targetText.trim());
    if(command){
      let remaining=command[1];
      for(const ref of named){
        const record=ref.entity==='task'?snapshot.tasks.find(t=>t.id===ref.id)!:snapshot.events.find(e=>e.id===ref.id)!;
        remaining=remaining.replace(new RegExp(escapePattern(record.title),'gi'),' ').replace(new RegExp(escapePattern(ref.id),'gi'),' ');
      }
      for(const project of snapshot.projects)remaining=remaining.replace(new RegExp(`\\bfrom\\s+(?:the\\s+|my\\s+)?${escapePattern(project.title)}(?:\\s+project)?\\b`,'gi'),' ');
      remaining=remaining.replace(new RegExp(`\\b(?:${countPattern}|tasks?|events?|these|those|them|the|my|all|existing|linked|connected|selected|called|named|and)\\b`,'gi'),' ').replace(/[\s,"“”]+/g,'');
      if(remaining)return {question:'I could not identify every named item in that request. Which existing tasks or linked events should I group?'};
    }
    // Duplicate titles need an actual group or explicit IDs to disambiguate.
    const taskIds=new Set(named.map(ref=>ref.entity==='task'?ref.id:snapshot.events.find(e=>e.id===ref.id)?.linkedTaskId??ref.id));
    const titles=snapshot.tasks.filter(t=>taskIds.has(t.id)).map(t=>t.title.toLowerCase());
    if(new Set(titles).size<titles.length&&!named.every(ref=>text.includes(ref.id.toLowerCase()))){
      const selectedId=selection?.revision===snapshot.revision?(selection.entity==='task'?selection.id:snapshot.events.find(e=>e.id===selection.id)?.linkedTaskId):undefined;
      const sources=snapshot.projects.filter(p=>new RegExp(`\\bfrom\\s+(?:the\\s+|my\\s+)?${escapePattern(p.title)}(?:\\s+project)?\\b`,'i').test(text));
      named=named.filter(ref=>{
        const id=ref.entity==='task'?ref.id:snapshot.events.find(e=>e.id===ref.id)?.linkedTaskId;
        return (!intent.count||intent.count===1)&&selectedId? id===selectedId:sources.length===1&&snapshot.tasks.find(t=>t.id===id)?.projectId===sources[0].id;
      });
      const qualifiedIds=new Set(named.map(ref=>ref.entity==='task'?ref.id:snapshot.events.find(e=>e.id===ref.id)?.linkedTaskId));
      if(qualifiedIds.size!==1)return {question:'Several tasks have the same name. Which tasks do you mean? Select one or identify its current project.'};
    }
    result=linkedTasks(snapshot,named);
  }else if(dated){
    result=dated;
  }else if(/\ball\s+(?:of\s+)?(?:my\s+)?tasks\b/i.test(text)&&!/\b(?:these|those)\b/i.test(text)){
    result={tasks:snapshot.tasks};
  }else if(/\ball\s+(?:of\s+)?(?:my\s+)?events\b/i.test(text)&&!/\b(?:these|those)\b/i.test(text)){
    result=linkedTasks(snapshot,snapshot.events.map(e=>({entity:'event',id:e.id,linkedTaskId:e.linkedTaskId})));
  }else if(selection&&selection.revision===snapshot.revision&&/\b(?:it|selected|this task|this event)\b/i.test(text)&&(!intent.count||intent.count===1)){
    result=linkedTasks(snapshot,[selection]);
  }else{
    if(selection&&selection.revision!==snapshot.revision&&/\b(?:it|selected|this task|this event)\b/i.test(text))return {question:'The selected item has changed. Which task or linked event do you mean? Select it again.'};
    if(!intent.count&&!/\b(?:these|those|them|it|this|that|the tasks|the events)\b/i.test(text))return {question:'Which existing tasks or linked events do you mean? I could not identify the named items.'};
    const latest=groups.at(-1)?.turn;
    const candidates=groups.filter(g=>g.turn===latest);
    if(!candidates.length)return {question:'Which tasks or linked events do you mean? Give their names or first ask me to show the group.'};
    let resolutions=candidates.map(g=>linkedTasks(snapshot,g.records));
    if(intent.count!==undefined&&resolutions.length>1){
      const fits=resolutions.filter(r=>'tasks'in r&&r.tasks.length===intent.count);
      if(fits.length)resolutions=fits;
    }
    const distinct=[...new Map(resolutions.map(r=>['tasks'in r?r.tasks.map(t=>t.id).sort().join('|'):r.question,r])).values()];
    if(distinct.length>1)return {question:'Which group do you mean? '+candidates.map((g,i)=>`${i+1}: ${g.records.map(ref=>ref.entity==='task'?snapshot.tasks.find(t=>t.id===ref.id)?.title:snapshot.events.find(e=>e.id===ref.id)?.title).filter(Boolean).join(', ')}`).join('; ')+'.'};
    result=distinct[0];
  }
  if('tasks'in result){
    if(!result.tasks.length)return {question:'Which existing tasks should I put in the project?'};
    if(intent.count!==undefined&&result.tasks.length!==intent.count)return {question:`You requested ${intent.count} tasks, but the referenced group resolves to ${result.tasks.length}. Which ${intent.count} tasks do you mean?`};
  }
  return result;
}

export function groupingChanges(snapshot:Snapshot,title:string,tasks:Task[],destinationId?:string):{changes:Change[];projectId:string}|{question:string}{
  const matches=snapshot.projects.filter(p=>p.title.trim().toLowerCase()===title.trim().toLowerCase());
  if(!destinationId&&matches.length>1)return {question:`There are ${matches.length} projects called “${title}”. Which one? `+matches.map((p,i)=>`${i+1}: ${snapshot.tasks.filter(t=>t.projectId===p.id).length} tasks (ID ${p.id})`).join('; ')+'.'};
  const project=destinationId?snapshot.projects.find(p=>p.id===destinationId&&matches.some(m=>m.id===p.id)):matches[0];
  if(destinationId&&!project)return {question:'That destination project is no longer available. Which project should I use?'};
  const projectId=project?.id??randomUUID();
  const changes:Change[]=project?[]:[{action:'create',entity:'project',id:projectId,fields:{title}}];
  for(const task of tasks){
    if(task.projectId===projectId)continue;
    changes.push({action:'update',entity:'task',id:task.id,fields:{projectId,...(task.sectionId&&snapshot.sections.find(s=>s.id===task.sectionId)?.projectId!==projectId?{sectionId:null}:{})}});
  }
  return {changes,projectId};
}

export function validateGrouping(changes:Change[],tasks:Task[],projectId:string):void{
  for(const task of tasks){
    const update=changes.find(c=>c.entity==='task'&&c.id===task.id);
    if(update&&update.action!=='update'||(update?.fields?.projectId??task.projectId)!==projectId)throw new Error('Put every referenced existing task inside the destination project before saving.');
  }
}
