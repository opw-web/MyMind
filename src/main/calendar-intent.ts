export interface CalendarSessionDraft {startDate:string;endDate?:string;startTime?:string|null;endTime?:string|null;linkedStepId?:string|null;}
export interface CalendarCandidate {title:string;sourceFragments?:string[];dueDate:string|null;sessions:CalendarSessionDraft[]}
const normalize=(s:string)=>s.toLowerCase().replace(/[’']/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function position(task:CalendarCandidate,text:string):number{
  const normalized=normalize(text);
  const exact=(task.sourceFragments??[]).map(normalize).map(s=>normalized.indexOf(s)).filter(p=>p>=0);
  if(exact.length)return Math.min(...exact);
  const words=normalize(task.title).split(' ').filter(w=>w.length>3);
  let best=-1,score=0;
  for(const match of normalized.matchAll(/\b(?:i need to|i also need to|i must|tomorrow|on thursday|today)\b/g)){
    const part=normalized.slice(match.index!,match.index!+160),hits=words.filter(w=>part.includes(w)).length;
    if(hits>score){score=hits;best=match.index!;}
  }
  return best;
}
// Ground grouped placement in the transcript, rather than trusting that a
// model remembered to schedule a second batch after staging its tasks.
export function calendarIntent<T extends CalendarCandidate>(text:string,tasks:T[]):Map<T,boolean>{
  const normalized=normalize(text),ordered=tasks.map(task=>({task,pos:position(task,text)})).filter(t=>t.pos>=0).sort((a,b)=>a.pos-b.pos),result=new Map<T,boolean>();
  const directives=/\b(?:add|put|place|schedule) (?:these|those|them)(?: (\d+|two|three|four|five))? (?:on|to|in) (?:the |my |your )?calendar\b|\b(?:i )?(?:dont|do not) want (?:these|those|them) to be on (?:the |my )?calendar\b/g;
  let boundary=0;
  for(const match of normalized.matchAll(directives)){
    const positive=!/dont|do not/.test(match[0]),counts:Record<string,number>={two:2,three:3,four:4,five:5},count=match[1]?(counts[match[1]]??Number(match[1])):0;
    let selected=ordered.filter(t=>t.pos>=boundary&&t.pos<match.index!);
    if(count){selected=ordered.filter(t=>t.pos<match.index!).slice(-count);if(selected.length!==count)throw new Error(`Calendar request refers to ${count} tasks, but the draft does not contain them all.`);}
    for(const item of selected)result.set(item.task,positive);
    boundary=match.index!+match[0].length;
  }
  return result;
}
export function applyCalendarIntent<T extends CalendarCandidate>(text:string,tasks:T[]):void{
  for(const [task,onCalendar] of calendarIntent(text,tasks)){
    if(!onCalendar){task.sessions=[];continue;}
    const date=task.sessions[0]?.startDate??task.dueDate;
    if(!date)throw new Error(`Resolve Date for “${task.title}” before saving.`);
    if(!task.sessions.length)task.sessions=[{startDate:date,endDate:date,startTime:null,endTime:null}];
  }
}
