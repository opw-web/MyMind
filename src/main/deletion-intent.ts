import {isDate,shiftDate} from '../shared/dates';
import {Change,Entity,Snapshot} from '../shared/model';

export type DeletionTarget={entity:Entity;id:string;title:string};
type DeleteChange=Change&{action:'delete';id:string};
export type DeletionPlan={changes:DeleteChange[];companions:string[];explain:boolean}|{question:string};
type DeletionDecision={target:DeletionTarget;remove:boolean;order:number};
export type ResolveDescription=(source:string,description:string,operation:'delete'|'keep',pool:DeletionTarget[])=>DeletionTarget|undefined;

const deleteVerb='delete|remove|erase';
const keepVerb=`keep|leave|spare|(?:do not|don['’]t|never)\\s+(?:${deleteVerb})|except|not`;
const deletionCommand=new RegExp(`^(?:just\\s+)?(?:${deleteVerb})\\b`,'i');
const command=new RegExp(`^((?:just\\s+)?(?:${deleteVerb})|${keepVerb})\\b`,'i');
const emphasis=new RegExp(`^just\\s+(?:${deleteVerb})(?:\\s+(?:it|them))?$`,'i');
const repeat=/^do the same (?:with|for|to)\s+/i;
const prefix=/^(?:yeah|yes|ok(?:ay)?|actually|you know what|also|please|you can|(?:can|could|would) you|i (?:want|need|would like) you to|completely|just|instead)(?:\s+|$)/i;
const advice=/^(?:why|how|what|when|where|who|explain|walk me through|tell me|help me understand)\b/i;
const otherCommand=/^(?:add|create|schedule|remind|put|make|record|submit|i (?:need|have|want) to|move|reschedule|update|change|rename|recolor|categorize|organize|mark|complete|reopen|set|tick|uncheck|check off|restore|undo|bring)\b/i;
const association=/^(?:(?:all|every|any|the|both)\s+)?(?:(its|their)\s+)?(?:(linked|associated)\s+)?(?:calendar\s+)?(?:events?|sessions?|blocks?)(?:\s+(?:associated with|linked to|for|of)\s+(.+))?$/i;
const keepSuffix=/\s+(?:as an? (?:independent|standalone) event|unchanged)$/i;
const pointer=/^(?:it|them|selected|(?:the )?selected (?:one|item)|(?:this|that|these|those)(?: (?:one|ones|item|items|tasks?|events?|sessions?))?)$/i;
const typeWords:Record<string,Entity>={task:'task',tasks:'task',event:'event',events:'event',session:'event',sessions:'event',project:'project',projects:'project',section:'section',sections:'section',category:'category',categories:'category'};
const kind='tasks?|(?:calendar )?(?:events?|sessions?)|projects?|sections?|categor(?:y|ies)';
const inlineCommand=new RegExp(`(\\b(?:${kind}|blocks?))\\s+(?=(?:(?:just\\s+)?(?:${deleteVerb})|${keepVerb}|do the same (?:with|for|to))\\b)`,'gi');
const trailingEmphasis=new RegExp(`\\s+(?=just\\s+(?:${deleteVerb})(?:\\s+(?:it|them))?(?:\\s+(?:and|but|then)\\b|\\s*[,.;!?\\n]|$))`,'gi');
const leadingKind=new RegExp(`^(${kind})(?:\\s+(?:(named|called|titled)\\s+)?|$)`,'i');
const trailingKind=new RegExp(`(?:^|\\s+)(${kind})$`,'i');
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^\p{L}\p{N}']+/gu,' ').trim();
const alias=(text:string)=>normalize(text).replace(/^(?:the\s+)?apply for\s+|^(?:the|a|an)\s+/,'');
const digitWords=['zero','one','two','three','four','five','six','seven','eight','nine'];
const spokenWords=(text:string)=>alias(text).split(' ').map(word=>{
  const digit=digitWords.indexOf(word);
  return digit===-1?word:String(digit);
});
function matchesDictation(name:string,title:string):boolean{
  const a=spokenWords(name),b=spokenWords(title);
  if(a.join(' ')===b.join(' '))return true;
  const [short,long]=a.length<b.length?[a,b]:[b,a];
  if(long.length!==short.length+1)return false;
  const index=short.findIndex((word,i)=>word!==long[i]);
  return index!==-1&&short[index]===long[index]+long[index+1]&&short.slice(index+1).join(' ')===long.slice(index+2).join(' ');
}
const unquote=(text:string)=>text.replace(/^["“]([^"”]+)["”]$/,'$1');
const targetKey=(target:DeletionTarget)=>`${target.entity}:${target.id}`;

function clauses(text:string):string[]{
  const quoted:string[]=[];
  const protectedText=text.replace(/["“][^"”]+["”]/g,match=>`\u0001${quoted.push(match)-1}\u0002`);
  return protectedText.replace(inlineCommand,'$1,').replace(trailingEmphasis,',').split(/[,.;!?\n]+|\b(?:and|but|then)\b|(?=\b(?:except|or)\b)/i).map(part=>{
    let clause=part.trim();
    while(prefix.test(clause)&&!emphasis.test(clause))clause=clause.replace(prefix,'');
    return clause.replace(/\u0001(\d+)\u0002/g,(_match,index)=>quoted[Number(index)]);
  }).filter(Boolean);
}

export function hasExplicitDeletion(text:string):boolean{
  const [first,...rest]=clauses(text);
  return !!first&&(deletionCommand.test(first)||command.test(first)&&rest.some(clause=>deletionCommand.test(clause)));
}

export function refersOnlyToDeletedItem(text:string):boolean{
  const [clause,...rest]=clauses(text);
  return !!clause&&!rest.length&&/^(?:just\s+)?(?:delete|remove|erase)\s+(?:it|(?:this|that)(?: item)?)$/i.test(clause);
}

export function planDeletion(text:string,snapshot:Snapshot,items:DeletionTarget[],today:string,selected:DeletionTarget|undefined,references:string[],selectionUnavailable=false,resolveDescription?:ResolveDescription):DeletionPlan{
  const decisions=new Map<string,DeletionDecision>();
  const linked=new Map<string,{remove:boolean;order:number;requiresTaskDeletion:boolean}>();
  const companions:string[]=[];
  let explain=false;
  const plannerItems=items.filter(item=>item.entity==='task'||item.entity==='event');
  let operation:'delete'|'keep'|undefined;
  let group:DeletionTarget[]=[],priorGroup:DeletionTarget[]=[];
  const groupLinks=new Set<string>();
  const externalRefs=selected?[selected]:selectionUnavailable?[]:plannerItems.filter(item=>references.includes(item.id));
  const localRefs=()=>group.length?group:priorGroup;

  const resolve=(phrase:string,forced?:Entity):DeletionTarget[]=>{
    const clean=phrase.trim().replace(/\s+only$/i,'').replace(/^(?:only|just)\s+/i,'');
    const direct=(value:string,scope?:Entity)=>items.filter(item=>(scope?item.entity===scope:item.entity==='task'||item.entity==='event')&&(item.id===unquote(value)||normalize(item.title)===normalize(unquote(value))));
    const disambiguate=(matches:DeletionTarget[],many=false)=>{
      if(matches.length<=1||many)return matches;
      const picked=selected&&matches.find(item=>targetKey(item)===targetKey(selected));
      if(picked)return [picked];
      throw new Error(`I found several planner items matching “${phrase}”. Which one do you mean?`);
    };
    const whole=direct(clean,forced).filter(item=>item.id===unquote(clean)||clean!==unquote(clean)||!trailingKind.test(clean));
    if(whole.length)return disambiguate(whole);
    const day=/\s+(?:(?:for|on)\s+)?(today|tomorrow|yesterday|\d{4}-\d{2}-\d{2})$/i.exec(clean);
    const when=day?.[1].toLowerCase();
    const date=when==='today'?today:when==='tomorrow'?shiftDate(today,1):when==='yesterday'?shiftDate(today,-1):when&&isDate(when)?when:undefined;
    if(day&&!date)throw new Error(`Which date did you mean for “${phrase}”?`);
    let subject=(day?clean.slice(0,day.index):clean).replace(/^(?:the|my|a|an)\s+/i,'');
    const bulk=/^(?:all|every|both)\s+/i.exec(subject);
    if(bulk)subject=subject.slice(bulk[0].length);
    const standalone=/^standalone\s+/i.test(subject);
    if(standalone)subject=subject.replace(/^standalone\s+/i,'');
    const trailing=trailingKind.exec(subject),leading=leadingKind.exec(subject);
    // A trailing scope takes precedence over words in the actual title.
    const typed=leading?.[2]?leading:trailing??leading;
    const scope=typed?typeWords[typed[1].toLowerCase().replace(/^calendar /,'')]:standalone?'event':forced;
    if(forced&&scope!==forced||standalone&&scope!=='event')return [];
    const plural=!!typed&&/(?:s|ies)$/i.test(typed[1]);
    const both=!!bulk&&/^both\s/i.test(bulk[0]);
    const many=!!bulk&&!both||plural;
    const withoutKind=typed?(typed===trailing?subject.slice(0,trailing.index):subject.slice(typed[0].length)):subject;
    const name=withoutKind.trim().replace(/\s+(?:one|ones)$/i,'');
    const pool=items.filter(item=>(scope?item.entity===scope:item.entity==='event'||item.entity==='task')&&(!standalone||snapshot.events.some(event=>event.id===item.id&&!event.linkedTaskId))&&(!date||(
      item.entity==='event'?snapshot.events.some(event=>event.id===item.id&&event.startDate<=date&&event.endDate>=date)
        :item.entity==='task'&&snapshot.tasks.some(task=>task.id===item.id&&(task.dueDate===date||snapshot.events.some(event=>event.linkedTaskId===task.id&&event.kind==='planned'&&event.startDate<=date&&event.endDate>=date)))
    )));
    if(!name||pointer.test(name)||operation==='keep'&&/^both$/i.test(name)){
      const nearby=localRefs();
      const refs=nearby.length&&!/\bselected\b/i.test(name)?nearby:externalRefs;
      const related=operation==='keep'&&scope==='task'?snapshot.events.filter(event=>refs.some(ref=>ref.entity==='event'&&ref.id===event.id)).map(event=>event.linkedTaskId):[];
      const candidates=(!name&&bulk&&scope||!selectionUnavailable&&!refs.length&&date&&scope)?pool:pool.filter(item=>refs.some(ref=>targetKey(ref)===targetKey(item))||related.includes(item.id));
      if(!candidates.length)throw new Error('Which planner item do you mean? Give me its exact name or select its card.');
      if(both&&candidates.length!==2)throw new Error('Which two planner items do you mean?');
      return disambiguate(candidates,many||both||/^both$/i.test(name));
    }
    const exact=[...new Set([...direct(name,scope),...(typed?direct(subject,scope):[])])].filter(item=>pool.includes(item));
    const leadingTitleAlias=!forced&&leading&&!trailing&&!bulk&&!date&&plannerItems.filter(item=>alias(item.title)===alias(subject));
    const resolveNamed=(matches:DeletionTarget[])=>{
      if(both&&plural&&matches.length!==2)throw new Error(`Which two planner items matching “${phrase}” do you mean?`);
      return disambiguate(matches,many);
    };
    if(exact.length)return resolveNamed([...new Set([...exact,...(leadingTitleAlias||[])])]);
    const phraseAlias=alias(unquote(name));
    const aliases=[...new Set([...pool.filter(item=>phraseAlias&&alias(item.title)===phraseAlias),...(leadingTitleAlias||[])])];
    if(aliases.length)return resolveNamed(aliases);
    if(name===unquote(name)){
      const dictated=pool.filter(item=>matchesDictation(name,item.title));
      if(dictated.length)return disambiguate(dictated);
    }
    if(typed&&/\bsessions?$/i.test(typed[1])&&!standalone){
      const tasks=disambiguate(plannerItems.filter(item=>item.entity==='task'&&phraseAlias&&alias(item.title)===phraseAlias));
      if(tasks.length)return disambiguate(pool.filter(item=>snapshot.events.some(event=>event.id===item.id&&event.linkedTaskId===tasks[0].id)),many);
    }
    // A description can identify one already scoped item. Type, dates, bulk
    // scope, quoted titles and pointers must be resolved by the parser itself.
    const description=leading&&leading===typed&&name.match(/^(?:about|for|where)\s+(.+)$/i)?.[1];
    if(resolveDescription&&description&&operation&&!many&&!date&&!standalone&&!name.includes('"')&&!name.includes('“')&&(scope==='task'||scope==='event')){
      const target=resolveDescription(phrase,description,operation,pool);
      if(target&&pool.includes(target))return [target];
    }
    return [];
  };

  try{
    const fragments=clauses(text);
    if(!fragments.some(fragment=>command.test(fragment)))return {question:'Which planner item do you mean? Give me its exact name or select its card.'};
    let awaitingTarget=false;
    const requireTarget=()=>{if(awaitingTarget)throw new Error(`Which planner item did you mean to ${operation==='keep'?'keep':'delete'}?`);};
    for(const [order,raw] of fragments.entries()){
      if(/^or\b/i.test(raw)&&operation!=='keep')throw new Error(`Which deletion target did you mean instead of “${raw}”?`);
      if(emphasis.test(raw)&&operation==='delete'&&!awaitingTarget)continue;
      const fragment=raw.replace(/^or\s+/i,'').replace(/\s+as well$/i,'');
      const repeated=repeat.test(fragment);
      const previous=repeated?group:[];
      const repeatLinks=repeated&&groupLinks.size>0;
      if(repeated){
        requireTarget();
        if(operation!=='delete'||!previous.length||repeatLinks&&(groupLinks.size!==previous.length||previous.some(item=>item.entity!=='task'||!groupLinks.has(item.id))))throw new Error('Which items and linked calendar events should I remove?');
        priorGroup=previous;
        group=[];
        groupLinks.clear();
        awaitingTarget=true;
      }
      const action=command.exec(fragment);
      if(action){
        requireTarget();
        operation=deletionCommand.test(action[0])?'delete':'keep';
        if(group.length)priorGroup=group;
        group=[];
        groupLinks.clear();
        awaitingTarget=true;
      }
      const subject=(action?fragment.slice(action[0].length):fragment.replace(repeat,'')).trim();
      const phrase=operation==='keep'?subject.replace(keepSuffix,''):subject;
      if(!phrase||/^(?:the|a|an)$/i.test(phrase))continue;
      if(repeatLinks&&/(?:^only\s+|\s+only$)/i.test(phrase))throw new Error('Should I remove the task and its linked calendar events, or the task only?');
      if(!action&&!repeated&&advice.test(phrase)){requireTarget();operation=undefined;explain=true;continue;}
      if(!action&&!repeated&&otherCommand.test(phrase)){
        requireTarget();
        companions.push(phrase);operation=undefined;continue;
      }
      if(!operation)throw new Error(`Which planner change did you mean by “${phrase}”?`);
      const remove=operation==='delete';
      const inclusive=/^including\s+/i.test(phrase);
      const match=!repeated&&association.exec(inclusive?phrase.replace(/^including\s+/i,''):phrase);
      if(match&&(match[1]||match[2]||match[3])){
        const reference=match[3];
        const each=reference&&/^(?:each|both)(?:\s+of\s+(?:the|those|these))?\s+tasks?$/i.test(reference);
        const nearby=inclusive||each?group:localRefs();
        if((inclusive||each)&&!nearby.length)throw new Error('Which task are those calendar events associated with?');
        const tasks=(reference&&!each&&!pointer.test(reference)?resolve(reference,'task'):nearby.length?nearby:externalRefs).filter(item=>item.entity==='task');
        if(!tasks.length)throw new Error('Which task are those calendar events associated with?');
        for(const task of tasks){
          linked.set(task.id,{remove,order,requiresTaskDeletion:nearby.some(item=>targetKey(item)===targetKey(task))&&!!decisions.get(targetKey(task))?.remove});
          groupLinks.add(task.id);
        }
        awaitingTarget=false;
        continue;
      }
      const repeatedKind=previous.length&&previous.every(item=>item.entity===previous[0].entity)?previous[0].entity:undefined;
      const targets=resolve(phrase,repeatedKind);
      if(!targets.length)throw new Error(`I could not find a planner item matching “${phrase}”. Which item do you mean?`);
      awaitingTarget=false;
      for(const target of targets){
        if(!remove&&target.entity==='task'&&linked.get(target.id)?.requiresTaskDeletion)linked.delete(target.id);
        decisions.set(targetKey(target),{target,remove,order});
        if(repeatLinks&&target.entity==='task'){
          linked.set(target.id,{remove:true,order,requiresTaskDeletion:true});
          groupLinks.add(target.id);
        }
      }
      group.push(...targets);
    }
    requireTarget();
    for(const event of snapshot.events){
      const decision=event.linkedTaskId&&linked.get(event.linkedTaskId);
      if(!decision||decision.requiresTaskDeletion&&decision.remove&&!decisions.get(`task:${event.linkedTaskId}`)?.remove)continue;
      const target={...event,entity:'event' as const},key=targetKey(target);
      if((decisions.get(key)?.order??-1)<decision.order)decisions.set(key,{target,remove:decision.remove,order:decision.order});
    }
    const changes=[...decisions.values()].filter(decision=>decision.remove).map(({target})=>({action:'delete' as const,entity:target.entity,id:target.id}));
    return {changes,companions,explain};
  }catch(error){return {question:error instanceof Error?error.message:'Which planner items should I remove?'};}
}
