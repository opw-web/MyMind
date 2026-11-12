import {Change,Snapshot,TaskStep} from '../shared/model';
import {requestsProjectWorkflow} from './project-workflow';

type Target={title:string;sourceFragments?:string[]};
const words=(value:string)=>value.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const filler=new Set('a an the my me to for of on in task tasks add create make please with steps step checklist break down into give include only'.split(' '));
const topic=(value:string)=>words(value).filter(w=>!filler.has(w));
const stepMarker=/\b(?:(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|next|last|final|one|another)\s+step\s+(?:is(?:\s+to)?|to)|(its|the)\s+(?:steps|checklist items)\s+are(?:\s+to)?)\s+/gi;
const stepKey=(title:string)=>words(title).filter(word=>!['a','an','the'].includes(word)).join(' ');

function explicitStepLists(text:string,targets:Target[]):Map<number,string[]>{
  const lists=new Map<number,string[]>(),repeated=new Set<number>();
  for(const sentence of text.split(/[.!?\n]+/)){
    const markers=[...sentence.matchAll(stepMarker)];
    if(!markers.length)continue;
    const scope=sentence.slice(0,markers[0].index);
    if(!/\b(?:i (?:need|want|have) to|add|create|make)\b/i.test(scope)||/\b(?:not|never|without|if|might|maybe)\b|n['’]t\b/i.test(scope))continue;
    const named=` ${topic(scope).join(' ')} `;
    const matches=targets.flatMap((target,index)=>{
      const title=topic(target.title);
      const sourceMatch=target.sourceFragments?.some(source=>topic(source).length>=2&&scope.toLowerCase().includes(source.toLowerCase()));
      return sourceMatch||title.length>=2&&named.includes(` ${title.join(' ')} `)?[index]:[];
    });
    if(matches.length!==1)continue;
    const [target]=matches;
    const titles=markers.flatMap((marker,index)=>{
      const phrase=sentence.slice(marker.index+marker[0].length,markers[index+1]?.index).trim().replace(/\s*(?:[,;]\s*)?(?:\band\s*)?$/i,'');
      return marker[1]?phrase.split(/\s*,\s*(?:and\s+)?/i):[phrase];
    });
    if(titles.some(title=>words(title).length<2||title.length>240||/[;:]|\b(?:also|then)\s+(?:add|create|make)\b|\b(?:due date|due on|due by)\b/i.test(title)))continue;
    if(lists.has(target)||repeated.has(target)){
      lists.delete(target);
      repeated.add(target);
      continue;
    }
    lists.set(target,titles.map(title=>title[0].toUpperCase()+title.slice(1)));
  }
  return lists;
}

// An opt-in belongs to the named task, not every task in the same request.
export function requestedStepTargets(text:string,targets:Target[]):Set<number>{
  const allowed=new Set<number>();
  if(targets.length===1&&requestsProjectWorkflow(text))allowed.add(0);
  const clauses=text.split(/[.!?;\n]|\b(?:and then|also add|and add|but)\b/i);
  for(const clause of clauses){
    if(!/\b(?:steps?|checklist|break\s+down|breakdown)\b/i.test(clause))continue;
    if(/\b(?:no|without|never)\s+(?:\w+\s+){0,2}(?:steps?|checklist|breakdown)\b|\b(?:don['’]?t|do not)\b.{0,35}\b(?:steps?|checklist|break\s+down)\b/i.test(clause))continue;
    // Merely mentioning steps is not a request to create or edit them.
    if(!/\b(?:add|create|make|give|include|generate|suggest|provide|show|list|break|split|remove|delete|clear|complete|mark|check|uncheck|reopen|update|change|edit)\b/i.test(clause))continue;
    const namedScope=/\b(?:steps?|checklist|breakdown)\s+(?:(?:only|just)\s+)?(?:for|to|of)\s+(.+)/i.exec(clause)?.[1];
    const stepPosition=clause.search(/\b(?:steps?|checklist|breakdown)\b/i);
    const scope=namedScope??(/\bbreak\s+down\b/i.test(clause)||stepPosition<0?clause:clause.slice(0,stepPosition));
    const scores=targets.map(target=>{
      const tokens=topic(target.title),mentioned=new Set(topic(scope));
      const matches=tokens.filter(word=>mentioned.has(word)).length;
      const sourceMatch=target.sourceFragments?.some(source=>topic(source).length>=2&&scope.toLowerCase().includes(source.toLowerCase()));
      return sourceMatch?1:tokens.length?matches/tokens.length:0;
    });
    const best=Math.max(0,...scores);
    if(/\b(?:all|every|each|both|these|those)\s+(?:of\s+)?(?:the\s+)?(?:tasks?|them)\b/i.test(clause)&&!/\bonly\b/i.test(clause))targets.forEach((_,i)=>allowed.add(i));
    else if(best>0) scores.forEach((score,i)=>{if(score===best&&score>=.5)allowed.add(i);});
    else if(targets.length===1&&!namedScope)allowed.add(0);
  }
  return allowed;
}

export function enforceRequestedSteps(changes:Change[],text:string,snapshot:Snapshot,sources=new Map<string,string[]>()):void{
  const tasks=changes.filter(c=>c.entity==='task'&&c.action!=='delete');
  const targets=tasks.map(c=>({title:String(c.fields?.title??snapshot.tasks.find(t=>t.id===c.id)?.title??''),sourceFragments:sources.get(c.id??'')}));
  const allowed=requestedStepTargets(text,targets),explicit=explicitStepLists(text,targets);
  tasks.forEach((change,index)=>{
    const titles=explicit.get(index);
    if(change.action==='create'&&change.fields&&titles){
      const previous=(change.fields.steps??[]) as Partial<TaskStep>[];
      const renames=new Map<string,string>();
      change.fields.steps=titles.map(title=>{
        const matches=previous.filter(step=>step.title&&stepKey(step.title)===stepKey(title));
        const step=matches.length===1?matches[0]:undefined;
        if(step?.title&&step.title!==title)renames.set(words(step.title).join(''),title);
        return {...step,title};
      });
      if(renames.size)for(const event of changes){
        const fields=event.fields;
        if(event.entity!=='event'||!fields)continue;
        const taskRef=fields.linkedTaskTitle??fields.linkedTaskId;
        if(typeof taskRef!=='string'||taskRef!==change.id&&words(taskRef).join('')!==words(targets[index].title).join(''))continue;
        for(const field of ['linkedStepTitle','linkedStepId']){
          const ref=fields[field],replacement=typeof ref==='string'&&renames.get(words(ref).join(''));
          if(replacement)fields[field]=replacement;
        }
      }
      return;
    }
    if(!change.fields||change.fields.steps===undefined||allowed.has(index))return;
    // Unrelated updates must preserve the saved checklist, even if the model
    // returns an empty array or invents a replacement.
    if(change.action==='create')change.fields.steps=[];
    else delete change.fields.steps;
  });
}
