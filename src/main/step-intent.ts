import {Change,Snapshot} from '../shared/model';
import {requestsProjectWorkflow} from './project-workflow';

type Target={title:string;sourceFragments?:string[]};
const words=(value:string)=>value.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const filler=new Set('a an the my me to for of on in task tasks add create make please with steps step checklist break down into give include only'.split(' '));
const topic=(value:string)=>words(value).filter(w=>!filler.has(w));

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
  const allowed=requestedStepTargets(text,tasks.map(c=>({title:String(c.fields?.title??snapshot.tasks.find(t=>t.id===c.id)?.title??''),sourceFragments:sources.get(c.id??'')})));
  tasks.forEach((change,index)=>{
    if(!change.fields||change.fields.steps===undefined||allowed.has(index))return;
    // Unrelated updates must preserve the saved checklist, even if the model
    // returns an empty array or invents a replacement.
    if(change.action==='create')change.fields.steps=[];
    else delete change.fields.steps;
  });
}
