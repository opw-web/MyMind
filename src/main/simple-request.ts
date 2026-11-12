import {CalendarSessionDraft} from './calendar-intent';
import {Change} from '../shared/model';
import {endOfWeek,isDate,shiftDate,weekday} from '../shared/dates';

// Fast path for one explicit item with an optional simple date. Anything with
// organization, times, ranges, extra commands or missing event dates goes to AI.
export function simpleCreation(text:string,today:string):{change:Change;sessions?:CalendarSessionDraft[]}|{missingEventDate:string}|undefined{
  if(/\b(and|plus|from|until|through|between|every|recurring|project|section|category|notes|color)\b|\bat\s+\d|[?!].+\S/i.test(text))return;
  let body=text.trim().replace(/[.!?]+$/,'');
  const prefix=/^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:add|create|schedule)\s+(?:(?:a|an|the)\s+)?/i;
  const submit=/^submit\b/i.test(body);
  if(!prefix.test(body)&&!submit)return;
  body=body.replace(prefix,'');
  const explicitTask=/^task\b|\btask$/i.test(body),explicitEvent=/^event\b|\bevent\b/i.test(body);
  let date:string|undefined;const schedule=/\bschedule\b/i.test(text);
  const week=/(?:,?\s+(?:due|by|before|for)\s+)(?:the )?end of (?:this|the) week$/i.exec(body);
  if(week){date=endOfWeek(today);body=body.slice(0,week.index).trim();}
  const match=/(?:,?\s+(?:due|for|on|by)\s+|\s+)(today|tomorrow|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})$/i.exec(body);
  if(match){const token=match[1].toLowerCase();if(/^\d{4}-\d{2}-\d{2}$/.test(token)&&!isDate(token))return;if(token==='today')date=today;else if(token==='tomorrow')date=shiftDate(today,1);else if(isDate(token))date=token;else{const wanted=token.replace(/^(next|this) /,'').slice(0,3),start=token.startsWith('next ')?1:0;for(let offset=start;offset<8;offset++){const d=shiftDate(today,offset);if(weekday(d).toLowerCase()===wanted){date=d;break;}}}body=body.slice(0,match.index).trim();}
  body=body.replace(/^(?:task|event)\s+(?:(?:called|named)\s+)?/i,'').replace(/\s+(?:event|task)$/i,'').trim().replace(/^["“](.*)["”]$/,'$1');
  const workHead=/^(?:buy|write|read|finish|prepare|prep|study|submit|build|print|3d print|pay|pick up|complete)\b/i.test(body),workNoun=/\b(assignment|homework|worksheet|essay|prototype|packaging|submission|report|groceries|notebooks)\b/i.test(body),eventNoun=/\b(exam|appointment|meeting|dentist|interview|workshop|lecture|class|seminar|lesson|flight|party|birthday|concert|trip|holiday)\b/i.test(body);
  if(!explicitTask&&!explicitEvent&&!submit&&!workHead&&!workNoun&&!eventNoun)return;
  const entity=explicitTask||submit||(!explicitEvent&&workHead)?'task':explicitEvent||eventNoun?'event':'task';
  if(!body||/^(task|event)$/i.test(body)||body.length>240||/\b(today|tomorrow|due|next|at)\b/i.test(body))return;
  const title=body[0].toUpperCase()+body.slice(1);
  if((entity==='event'||schedule)&&!date)return {missingEventDate:title};
  return {change:{action:'create',entity,fields:entity==='event'?{title,startDate:date,endDate:date}:{title,dueDate:!schedule||/\b(due|by|before)\b/i.test(text)?date??null:null}},...(entity==='task'&&schedule?{sessions:[{startDate:date!,endDate:date!}]}:{})};
}

export function simpleCreate(text:string,today:string):Change|undefined{
  const result=simpleCreation(text,today);
  return result&&'change'in result?result.change:undefined;
}
