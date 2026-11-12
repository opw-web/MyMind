import {Change,Snapshot} from '../shared/model';
import {isDate,shiftDate} from '../shared/dates';
export type ActivityReport={changes:Change[];question?:string;duplicate?:boolean;mixed?:boolean};
const timePattern='(?:[01]?\\d|2[0-3])(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?';
function minutes(value:string):number|undefined {
 const m=/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.replace(/\./g,'').trim());if(!m)return;
 let hour=Number(m[1]);if(m[3]){if(hour<1||hour>12)return;hour=hour%12+(m[3].toLowerCase()==='pm'?12:0);}else if(!m[2])return;
 if(hour>23)return;return hour*60+Number(m[2]??0);
}
const clock=(value:number)=>`${String(Math.floor(value%1440/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
/** Conservative factual first-person capture; all uncertain intervals stay questions. */
export function activityReport(text:string,today:string,snapshot:Snapshot):ActivityReport|undefined {
 const body=text.trim().replace(/[.!]+$/,'');
 if(/[?"“”]/.test(body)||/\b(?:if|imagine|suppose|would|could|should|might|will|plan|planning|tomorrow|every|usually|often|recurr|don't|do not|did not|didn't)\b/i.test(body))return;
 const firstPerson=/^(?:(?:today|yesterday|last night|on \d{4}-\d{2}-\d{2}),?\s+)?i\s+(?:slept|sleep|got ready|traveled|travelled|worked|studied|exercised|walked|ran)\b/i.test(body);
 const intervalFirst=/^(?:(?:today|yesterday),?\s+)?from\s+\d/i.test(body)&&/\b(?:i\s+)?(?:got ready|traveled|travelled|worked|studied|exercised|walked|ran)\b/i.test(body);
 if(!firstPerson&&!intervalFirst)return;
 const additionalActivity=[...body.matchAll(/\b(?:and|also|then)\s+(?:(?:also|then)\s+)?(?:i\s+)?(slept|worked|studied|exercised|walked|ran|got ready|traveled|travelled)\b/gi)].some(match=>!(['traveled','travelled'].includes(match[1].toLowerCase())&&/\bgot ready\s*$/i.test(body.slice(0,match.index))));
 if(additionalActivity||(body.match(/\bfrom\s+/gi)?.length??0)>1||/\b(?:and|also|then)\s+(?:(?:i|please)\s+)?(?:add|create|schedule|remind|update|delete|remove|mark|complete|i slept|i worked|from)\b|[.;]\s*(?:i|add|create|schedule)\b/i.test(body))return {changes:[],mixed:true};
 const sleep=/\b(?:slept|sleep)\b/i.test(body),title=sleep?'Sleep':/got ready.*travel/i.test(body)?'Get ready and travel':/got ready/i.test(body)?'Get ready':/travel/i.test(body)?'Travel':/studied/i.test(body)?'Study':/worked/i.test(body)?'Work':/exercised/i.test(body)?'Exercise':/walked/i.test(body)?'Walk':'Run';
 const explicit=/\bon (\d{4}-\d{2}-\d{2})\b/i.exec(body)?.[1];if(explicit&&!isDate(explicit))return {changes:[],question:'What date should I use for this activity?'};
 let startDate=explicit??(/\byesterday\b|\blast night\b/i.test(body)?shiftDate(today,-1):today);
 const range=new RegExp(`\\bfrom\\s+(${timePattern})\\s+(?:last night\\s+)?(?:to|until|–|-)\\s*(${timePattern})`,'i').exec(body);
 const startMatch=range??new RegExp(`\\bfrom\\s+(${timePattern})(?=\\s|$)`,'i').exec(body);
 const duration=/\b(?:slept|for)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+hours?\b/i.exec(body);
 const start=startMatch?minutes(startMatch[1]):undefined,end=range?minutes(range[2]):undefined;
 if(!explicit&&/\blast night\b/i.test(body)&&start!==undefined&&start<12*60)startDate=today;
 if(start===undefined||(!range&&!duration)||range&&end===undefined){
  return {changes:[{action:'create',entity:'event',fields:{title,kind:'actual',linkedTaskId:null,linkedStepId:null,startDate,endDate:startDate,startTime:null,endTime:null,categoryTitle:sleep?'Sleep':title}}],question:`What start and end times should I use for ${title.toLowerCase()}? Include AM or PM. This interval is unresolved, not an all-day activity.`};
 }
 const numberWords:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
 const length=duration?60*(numberWords[duration[1].toLowerCase()]??Number(duration[1])):undefined;
 const finish=end!==undefined?end+(end<=start?1440:0):start+length!;
 if(length!==undefined&&range&&finish-start!==length)return {changes:[],question:'The reported duration and times differ. Which interval should I use?'};
 if(finish-start<=0||finish-start>24*60)return {changes:[],question:'What exact date and interval should I use for this activity?'};
 if(sleep&&finish>=1440&&!explicit&&!/\byesterday\b|\blast night\b/i.test(body))startDate=shiftDate(today,-1);
 const fields={title,kind:'actual',linkedTaskId:null,linkedStepId:null,startDate,endDate:shiftDate(startDate,Math.floor(finish/1440)),startTime:clock(start),endTime:clock(finish),categoryTitle:sleep?'Sleep':title};
 const duplicate=snapshot.events.some(event=>event.kind==='actual'&&!event.linkedTaskId&&event.startDate===fields.startDate&&event.endDate===fields.endDate&&event.startTime===fields.startTime&&event.endTime===fields.endTime&&(event.title.toLowerCase()===title.toLowerCase()||sleep&&snapshot.categories.find(c=>c.id===event.categoryId)?.semanticKey==='sleep'));
 return duplicate?{changes:[],duplicate:true}:{changes:[{action:'create',entity:'event',fields}]};
}

/** Explicit interval answers and selected declarative edits preserve session identity. */
export function activityTimeCorrection(text:string,event:Snapshot['events'][number]):ActivityReport|undefined {
 const body=text.trim();if(/[?"“”]/.test(body)||/\b(?:if|imagine|suppose|would|could|might|every|usually|don't|do not)\b/i.test(body))return;
 const range=new RegExp(`^(?:actually[, ]+|instead[, ]+)?(?:from\\s+)?(${timePattern})\\s+(?:to|until|–|-)\\s*(${timePattern})[.!\\s]*$`,'i').exec(body);
 const endEdit=new RegExp(`\\b(?:should\\s+)?end(?:s)?\\s+(?:at\\s+)?(${timePattern})[.!\\s]*$`,'i').exec(body);
 if(!range&&!endEdit)return;
 const start=range?minutes(range[1]):event.startTime?minutes(event.startTime):undefined,end=range?minutes(range[2]):minutes(endEdit![1]);
 if(start===undefined||end===undefined)return {changes:[],question:'Include AM or PM for the start and end times so I can resolve this interval.'};
 return {changes:[{action:'update',entity:'event',id:event.id,fields:{startDate:event.startDate,endDate:shiftDate(event.startDate,end<=start?1:0),startTime:clock(start),endTime:clock(end)}}]};
}
