import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {PlannerAssistant} from '../src/main/assistant';
import {PendingDraft} from '../src/shared/model';
import {activityReport,activityTimeCorrection} from '../src/main/activity';
const tool=(name:string,args:unknown)=>({message:{role:'assistant',content:'',tool_calls:[{function:{name,arguments:args}}]}});
function setup(responses:any[]=[]){const db=new PlannerDatabase(':memory:');const runtime:any={model:'test',status:{state:'ready',context:16384},call:async(_path:string,body:any)=>{const response=responses.shift();return typeof response==='function'?response(body):response??{message:{content:'Review and Apply.'}};}};const assistant=new PlannerAssistant(db,runtime,()=>{});return {db,assistant};}
const edit=(draft:PendingDraft)=>({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision});
const apply=(draft:PendingDraft)=>({...edit(draft),requestId:'apply-review'});

test('a named event with explicitly undecided timing has a blocked preview before inference',async()=>{
 const responses:any[]=[()=>{throw new Error('The missing timing should be detected before inference');}];
 const {db,assistant}=setup(responses);
 try{
  const reply=await assistant.chat({text:'Create a planned calendar event called Jazz Night, but I have not picked its date or time. Ask me what date and time to use.',requestId:'jazz-question'});
  const draft=reply.preview!.draft;
  assert.match(reply.content,/date and time.*Jazz Night/i);
  assert.equal(draft.projectedSnapshot.events.length,0);
  assert.equal(draft.unresolved[0].required,true);
  assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);
  assert.equal(responses.length,1);
  responses.splice(0,1,tool('stage_changes',{changes:[{action:'create',entity:'event',title:'Jazz Night',startDate:'2026-11-10',startTime:'19:00',endTime:'21:00'}]}),tool('preview_changes',{}));
  await assistant.chat({text:'Schedule Jazz Night on 2026-11-10 from 19:00 to 21:00.',requestId:'jazz-answer'});
  const answered=assistant.getDraft()!;
  assert.equal(answered.id,draft.id);
  assert.equal(answered.unresolved.length,0);
  assert.equal(answered.projectedSnapshot.events[0].startTime,'19:00');
  assert.equal(db.revision,0);
 }finally{db.close();}
});

test('required interval issue IDs require an actual target interval correction before Apply',async()=>{
 const {db,assistant}=setup();try{await assistant.chat({text:'Today I slept from 6 to 8',requestId:'ambiguous'});const draft=assistant.getDraft()!,event=draft.projectedSnapshot.events[0],issue=draft.unresolved[0];
 for(const changes of [undefined,[{action:'update' as const,entity:'event' as const,id:event.id,fields:{title:'Rest'}}],[{action:'update' as const,entity:'event' as const,id:event.id,fields:{startTime:null,endTime:null}}]]){
  assert.throws(()=>assistant.editDraft({...edit(draft),changes,resolveIssueIds:[issue.id]}),/resolv|interval|time/i);assert.equal(assistant.getDraft()?.version,draft.version);assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);assert.equal(db.revision,0);
 }
 const resolved=assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'event',id:event.id,fields:{startTime:'06:00',endTime:'08:00'}}],resolveIssueIds:[issue.id]});assert.equal(resolved.unresolved.length,0);assistant.applyDraft(apply(resolved));assert.equal(db.snapshot().events[0].startTime,'06:00');assert.equal(db.snapshot().events[0].endTime,'08:00');
 }finally{db.close();}
});
test('later-turn required clarification joins and versions an existing draft without local changes',async()=>{
 const responses=[tool('finish_request',{outcome:'clarification',message:'What date and time should the meeting have?'})];const {db,assistant}=setup(responses);try{await assistant.chat({text:'Add task called Read today',requestId:'first'});const first=assistant.getDraft()!;const reply=await assistant.chat({text:'Add a meeting with notes, but I have not decided the date and time',requestId:'joined'});const draft=assistant.getDraft()!;assert.equal(reply.preview?.draft.id,first.id);assert.ok(draft.version>first.version);assert.equal(draft.unresolved.length,1);assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);assert.equal(db.snapshot().tasks.length,0);
 responses.push(tool('finish_request',{outcome:'clarification',message:'Which appointment location is required?'}));await assistant.chat({text:'Add an appointment with notes, but I have not decided the location',requestId:'another-joined'});assert.equal(assistant.getDraft()?.unresolved.length,2);assert.equal(db.revision,0);
 }finally{db.close();}
});
test('repeated repreview retains field conflicts until an explicit matching field choice',()=>{
 const {db,assistant}=setup();try{db.mutate({changes:[{action:'create',entity:'task',id:'task',fields:{title:'Original'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const turn=assistant.drafts.begin('proposal');assistant.drafts.stage(turn,[{action:'update',entity:'task',id:'task',fields:{title:'Proposal'}}]);assistant.drafts.end(turn);let draft=assistant.getDraft()!;db.mutate({changes:[{action:'update',entity:'task',id:'task',fields:{title:'Manual'}}],label:'Manual',expectedRevision:1,requestId:'manual'});
 draft=assistant.editDraft({...edit(draft),expectedRevision:2,repreview:true});const issue=draft.unresolved.find(issue=>issue.field==='conflict')!;assert.ok(issue);draft=assistant.editDraft({...edit(draft),repreview:true});assert.ok(draft.unresolved.some(item=>item.id===issue.id));assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);
 assert.throws(()=>assistant.editDraft({...edit(draft),resolveIssueIds:[issue.id]}),/resolv|conflict|field/i);assert.throws(()=>assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'task',id:'task',fields:{notes:'Irrelevant'}}],resolveIssueIds:[issue.id]}),/resolv|conflict|field/i);
 const resolved=assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'task',id:'task',fields:{title:'Manual'}}],resolveIssueIds:[issue.id]});assert.equal(resolved.unresolved.length,0);assert.equal(resolved.projectedSnapshot.tasks[0].title,'Manual');
 }finally{db.close();}
});
test('missing-target and invalid Undo conflicts cannot be cleared by issue IDs',async()=>{
 for(const inverse of [false,true]){const {db,assistant}=setup();try{await assistant.chat({text:'Add task called Read today',requestId:'base'});let draft=assistant.getDraft()!;assistant.applyDraft(apply(draft));const id=db.snapshot().tasks[0].id;if(inverse)await assistant.chat({text:'Undo that',requestId:'inverse'});else{const turn=assistant.drafts.begin('edit');assistant.drafts.stage(turn,[{action:'update',entity:'task',id,fields:{title:'Proposal'}}]);assistant.drafts.end(turn);}draft=assistant.getDraft()!;db.mutate({changes:inverse?[{action:'create',entity:'task',fields:{title:'Later'}}]:[{action:'delete',entity:'task',id}],label:'Manual',expectedRevision:db.revision,requestId:'later'});draft=assistant.editDraft({...edit(draft),expectedRevision:db.revision,repreview:true});assert.ok(draft.unresolved.length);assert.throws(()=>assistant.editDraft({...edit(draft),resolveIssueIds:draft.unresolved.map(issue=>issue.id)}));assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);
 }finally{db.close();}}
});
test('same-loop new checklist rename retains step identity, completion and linked session',async()=>{
 let originalStep='';const {db,assistant}=setup([
 tool('stage_changes',{changes:[{action:'create',entity:'task',id:'research',fields:{title:'Research',steps:[{title:'Read',completed:true}]}},{action:'create',entity:'event',id:'session',fields:{title:'Read session',startDate:'2026-11-05',linkedTaskId:'research',linkedStepTitle:'Read'}}]}),
 (body:any)=>{const result=JSON.parse(body.messages.filter((m:any)=>m.role==='tool').at(-1).content);originalStep=result.draft.find((item:any)=>item.entity==='task').steps[0].id;return tool('stage_changes',{changes:[{action:'update',entity:'task',id:'research',fields:{steps:[{title:'Read sources'}]}}]});},tool('preview_changes',{})]);try{const result=await assistant.chat({text:'Add Research with a Read step and a session. Update the checklist to Read sources.',requestId:'step-repair'});assert.ok(result.preview,result.content);const draft=result.preview.draft;assert.equal(draft.projectedSnapshot.tasks[0].steps[0].id,originalStep);assert.equal(draft.projectedSnapshot.tasks[0].steps[0].completed,true);assert.equal(draft.projectedSnapshot.events[0].linkedStepId,originalStep);assert.equal(db.revision,0);
 }finally{db.close();}
});
test('unresolved activity time preserves explicit historical and last-night date context',()=>{
 const {db}=setup();try{for(const [text,expected,answer] of [['On 2026-11-02 I slept from 6 to 8','2026-11-02','6 AM to 8 AM'],['Last night I slept from 11 to 6','2026-11-04','11 PM to 6 AM']]){const report=activityReport(text,'2026-11-05',db.snapshot())!;assert.equal(report.changes[0].fields?.startDate,expected);const compiled=db.previewBatch({changes:report.changes,expectedRevision:0}),event=compiled.projectedSnapshot.events[0],correction=activityTimeCorrection(answer,event)!;assert.equal(correction.changes[0].fields?.startDate,expected);assert.equal(correction.changes[0].fields?.endDate,text.startsWith('Last')?'2026-11-05':expected);}
 }finally{db.close();}
});
test('coordinated factual activities defer the complete request to tools while combined preparation/travel stays one block',async()=>{
 const {db,assistant}=setup([tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Sleep',kind:'actual',startDate:'2026-11-05',startTime:'01:00',endTime:'06:00'}},{action:'create',entity:'event',fields:{title:'Study',kind:'actual',startDate:'2026-11-05',startTime:'08:00',endTime:'10:00'}}]}),tool('preview_changes',{})]);try{const text='I slept from 1 AM to 6 AM and studied from 8 AM to 10 AM';assert.equal(activityReport(text,'2026-11-05',db.snapshot())?.mixed,true);const result=await assistant.chat({text,requestId:'two-activities'});assert.equal(result.preview?.draft.projectedSnapshot.events.length,2);assert.deepEqual(result.preview?.draft.projectedSnapshot.events.map(event=>event.kind),['actual','actual']);assert.equal(activityReport('From 6 AM to 8 AM got ready and traveled','2026-11-05',db.snapshot())?.changes.length,1);assert.equal(db.revision,0);
 }finally{db.close();}
});

test('historical ambiguous activity and a short answer preserve one grounded block through the assistant',async()=>{
 const {db,assistant}=setup();try{const initial=await assistant.chat({text:'On 2026-11-02 I slept from 6 to 8',requestId:'historical'});const event=initial.preview!.draft.projectedSnapshot.events[0];assert.equal(event.startDate,'2026-11-02');const reply=await assistant.chat({text:'6 AM to 8 AM',requestId:'historical-answer'});assert.equal(reply.preview?.draft.projectedSnapshot.events[0].id,event.id);assert.equal(reply.preview?.draft.projectedSnapshot.events[0].startDate,'2026-11-02');assert.equal(reply.preview?.draft.unresolved.length,0);assistant.applyDraft(apply(assistant.getDraft()!));assert.equal(db.snapshot().events[0].startDate,'2026-11-02');
 }finally{db.close();}
});
test('an explicit proposal field choice resolves a retained conflict and alone authorizes the later Apply',()=>{
 const {db,assistant}=setup();try{db.mutate({changes:[{action:'create',entity:'task',id:'task',fields:{title:'Original'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});const turn=assistant.drafts.begin('proposal');assistant.drafts.stage(turn,[{action:'update',entity:'task',id:'task',fields:{title:'Proposal'}}]);assistant.drafts.end(turn);let draft=assistant.getDraft()!;db.mutate({changes:[{action:'update',entity:'task',id:'task',fields:{title:'Manual'}}],label:'Manual',expectedRevision:1,requestId:'manual'});draft=assistant.editDraft({...edit(draft),expectedRevision:2,repreview:true});draft=assistant.editDraft({...edit(draft),repreview:true});const conflict=draft.unresolved.find(issue=>issue.field==='conflict')!;assert.deepEqual(conflict.conflictingFields,['title']);draft=assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'task',id:'task',fields:{title:'Proposal'}}],resolveIssueIds:[conflict.id]});assert.equal(db.snapshot().tasks[0].title,'Manual');assistant.applyDraft(apply(draft));assert.equal(db.snapshot().tasks[0].title,'Proposal');
 }finally{db.close();}
});

test('required due dates reject null acknowledgements and unchanged null in complete-record corrections',async()=>{
 const {db,assistant}=setup();try{const turn=assistant.drafts.begin('report');assistant.drafts.stage(turn,[{action:'create',entity:'task',id:'report',fields:{title:'Report',dueDate:null}}],{unresolved:[{id:'report-date',required:true,entity:'task',targetId:'report',field:'dueDate',question:'What date is the report due?'}]});assistant.drafts.end(turn);const draft=assistant.getDraft()!;assert.throws(()=>assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'task',id:'report',fields:{dueDate:null}}],resolveIssueIds:['report-date']}),/date|resolv/i);assert.equal(assistant.getDraft()?.version,draft.version);
 const correction=assistant.drafts.begin('full-record-correction');assistant.drafts.stage(correction,[{action:'update',entity:'task',id:'report',fields:{title:'Report revised',notes:'Clearer subject',dueDate:null}}]);assistant.drafts.end(correction);const corrected=assistant.getDraft()!;assert.equal(corrected.unresolved.length,1);assert.throws(()=>assistant.applyDraft(apply(corrected)),/questions/);const resolved=assistant.editDraft({...edit(corrected),changes:[{action:'update',entity:'task',id:'report',fields:{dueDate:'2026-11-06'}}],resolveIssueIds:['report-date']});assert.equal(resolved.unresolved.length,0);assistant.applyDraft(apply(resolved));assert.equal(db.snapshot().tasks[0].dueDate,'2026-11-06');
 }finally{db.close();}
});
test('a complete answer resolves its request-level meeting question and preserves unrelated pending work',async()=>{
 const responses=[tool('finish_request',{outcome:'clarification',message:'What date and time should the meeting have?'})];const {db,assistant}=setup(responses);try{await assistant.chat({text:'Add task called Read today',requestId:'read'});await assistant.chat({text:'Add a meeting with notes, but I have not decided the date and time',requestId:'meeting-question'});const question=assistant.getDraft()!.unresolved[0];assert.equal(question.requestId,'meeting-question');responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Meeting',startDate:'2026-11-06',startTime:'09:00',endTime:'10:00',notes:'Discussion'}}]}),tool('preview_changes',{}));const result=await assistant.chat({text:'Add the meeting on 2026-11-06 from 9 AM to 10 AM with notes Discussion',requestId:'meeting-answer'});assert.equal(result.preview?.draft.unresolved.some(issue=>issue.id===question.id),false);assert.equal(result.preview?.draft.projectedSnapshot.tasks[0].title,'Read');assert.equal(db.revision,0);assistant.applyDraft(apply(assistant.getDraft()!));assert.equal(db.snapshot().tasks.length,1);assert.equal(db.snapshot().events.length,1);
 }finally{db.close();}
});
test('short date/time answers use the latest request clarification and unrelated events do not resolve it',async()=>{
 const responses=[tool('finish_request',{outcome:'clarification',message:'What date and time should the meeting have?'})];const {db,assistant}=setup(responses);try{await assistant.chat({text:'Add task called Read today',requestId:'read-short'});await assistant.chat({text:'Add a meeting with notes, but I have not decided the date and time',requestId:'short-question'});const question=assistant.getDraft()!.unresolved[0];
 responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Dentist appointment',startDate:'2026-11-06',startTime:'09:00',endTime:'10:00'}}]}),tool('preview_changes',{}));await assistant.chat({text:'Add a dentist appointment on my calendar 2026-11-06 from 9 AM to 10 AM',requestId:'unrelated-event'});assert.ok(assistant.getDraft()?.unresolved.some(issue=>issue.id===question.id));
 responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Meeting',startDate:'2026-11-07',startTime:'11:00',notes:'Independent meeting'}}]}),tool('preview_changes',{}));await assistant.chat({text:'Add another meeting with notes on 2026-11-07 at 11 AM',requestId:'independent-meeting'});assert.ok(assistant.getDraft()?.unresolved.some(issue=>issue.id===question.id));
 responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Meeting',startDate:'2026-11-06',startTime:'09:00',notes:'Discussion'}}]}),tool('preview_changes',{}));const result=await assistant.chat({text:'Tomorrow at 9 AM',requestId:'short-answer'});assert.ok(result.preview,result.content);assert.equal(result.preview.draft.unresolved.filter(issue=>/meeting/i.test(issue.question)).length,0);assert.equal(result.preview.draft.projectedSnapshot.events.length,3);
 }finally{db.close();}
});

test('an explicit named schedule answers a fresh event question without a special reply button',async()=>{
 const responses=[{message:{content:'What date and time should Jazz Night start and end?'}}];
 const {db,assistant}=setup(responses);
 try{
  await assistant.chat({text:'Create a planned calendar event called Jazz Night, but I have not picked its date or time. Ask me what date and time to use.',requestId:'fresh-jazz'});
  const before=assistant.getDraft()!;
  assert.equal(before.unresolved.length,1);
  assert.throws(()=>assistant.applyDraft(apply(before)),/questions/);
  responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',title:'Jazz Night',kind:'planned',startDate:'2026-11-10',endDate:'2026-11-10',startTime:'19:00',endTime:'21:00'}]}),tool('preview_changes',{}));
  const result=await assistant.chat({text:'Schedule Jazz Night on 2026-11-10 from 19:00 to 21:00.',requestId:'schedule-jazz'});
  assert.equal(result.preview?.draft.unresolved.length,0);
  assert.equal(db.revision,0);
  assistant.applyDraft(apply(result.preview!.draft));
  assert.deepEqual(db.snapshot().events.map(event=>[event.title,event.startDate,event.startTime,event.endTime]),[['Jazz Night','2026-11-10','19:00','21:00']]);
 }finally{db.close();}
});
test('an explicitly selected request question resolves alone while older unrelated questions survive',async()=>{
 const responses=[tool('finish_request',{outcome:'clarification',message:'What date and time should the meeting have?'}),tool('finish_request',{outcome:'clarification',message:'What date and time should the interview have?'})];const {db,assistant}=setup(responses);try{await assistant.chat({text:'Add task called Read today',requestId:'read-multiple'});await assistant.chat({text:'Add a meeting with notes but I do not know the date and time',requestId:'meeting-multiple'});const meeting=assistant.getDraft()!.unresolved[0];await assistant.chat({text:'Add an interview on my calendar but I do not know the date and time',requestId:'interview-multiple'});assert.equal(assistant.getDraft()?.unresolved.length,2);
 responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Meeting',startDate:'2026-11-06',startTime:'09:00',notes:'Discussion'}}]}),tool('preview_changes',{}));const result=await assistant.chat({text:'Tomorrow at 9 AM',requestId:'explicit-answer',clarificationIssueId:meeting.id});assert.ok(result.preview,result.content);assert.equal(result.preview.draft.unresolved.length,1);assert.match(result.preview.draft.unresolved[0].question,/interview/i);assert.equal(result.preview.draft.projectedSnapshot.tasks[0].title,'Read');assert.throws(()=>assistant.applyDraft(apply(result.preview!.draft)),/questions/);
 }finally{db.close();}
});

test('complete-record model correction with an unchanged null deadline cannot answer a required date',async()=>{
 const {db,assistant}=setup([tool('stage_changes',{changes:[{action:'create',entity:'task',id:'report',fields:{title:'Report',dueDate:null}}]}),tool('finish_request',{outcome:'clarification',message:'What date is Report due?',targetIds:['report']}),{message:{content:JSON.stringify({isReply:true,updates:[{id:'report',title:'Report revised',notes:'Clearer subject',dueDate:null}],newTasks:[],unresolved:[]})}}]);try{const initial=await assistant.chat({text:'Add a Report task with notes and an undecided deadline',requestId:'model-report'});assert.equal(initial.preview?.draft.unresolved.length,1);const correction=await assistant.chat({text:'Actually the Report should be Report revised with clearer notes',requestId:'model-report-correction'});assert.equal(correction.preview?.draft.projectedSnapshot.tasks[0].title,'Report revised');assert.equal(correction.preview?.draft.unresolved.length,1);assert.throws(()=>assistant.applyDraft(apply(assistant.getDraft()!)),/questions/);assert.equal(db.revision,0);
 }finally{db.close();}
});

test('an older explicit short answer survives completion of the latest question and the full batch Applies',async()=>{
 const responses=[tool('finish_request',{outcome:'clarification',message:'What date and time should the meeting have?'}),tool('finish_request',{outcome:'clarification',message:'What date and time should the interview have?'})];const {db,assistant}=setup(responses);try{
 await assistant.chat({text:'Add task called Read today',requestId:'read-question-lifetime'});await assistant.chat({text:'Add a meeting with notes, but I have not decided the date and time',requestId:'older-meeting'});const meeting=assistant.getDraft()!.unresolved[0];await assistant.chat({text:'Add an interview on my calendar with notes, but I have not decided the date and time',requestId:'newest-interview'});
 responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Interview',startDate:'2026-11-06',startTime:'11:00',notes:'Interview'}}]}),tool('preview_changes',{}));await assistant.chat({text:'Add the interview on 2026-11-06 at 11 AM with notes Interview',requestId:'newest-interview-answer'});assert.deepEqual(assistant.getDraft()?.unresolved.map(issue=>issue.id),[meeting.id]);
 const input={text:'Tomorrow at 9 AM',clarificationIssueId:meeting.id},preflight=assistant.checkInput(input);responses.push((body:any)=>{assert.match(body.messages[0].content,/The user is answering a question about: Add a meeting with notes/);return tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:'Meeting',startDate:'2026-11-06',startTime:'09:00',notes:'Discussion'}}]});},tool('preview_changes',{}));const result=await assistant.chat({...input,requestId:'older-explicit-answer'});assert.deepEqual(preflight,{fits:true});assert.equal(result.preview?.draft.unresolved.length,0);assert.equal(result.preview?.draft.projectedSnapshot.tasks[0].title,'Read');assert.deepEqual(result.preview?.draft.projectedSnapshot.events.map(event=>event.title),['Interview','Meeting']);assert.equal(db.revision,0);assert.equal(db.snapshot().tasks.length,0);assert.equal(db.snapshot().events.length,0);assert.equal(db.db.prepare('SELECT count(*) AS n FROM history').get()!.n,0);assert.equal(db.db.prepare('SELECT count(*) AS n FROM requests').get()!.n,0);assistant.applyDraft(apply(assistant.getDraft()!));assert.equal(db.revision,1);assert.equal(db.snapshot().tasks[0].title,'Read');assert.equal(db.snapshot().events.length,2);
 }finally{db.close();}
});

test('factual activities preview then apply with reusable category identities',async()=>{
 for(const text of ['I worked from 9 AM to 5 PM','From 6 AM to 8 AM got ready and traveled','I studied from 8 AM to 10 AM']){const {db,assistant}=setup();try{await assistant.chat({text,requestId:'first'});let d=assistant.getDraft()!;assert.equal(db.revision,0);assert.equal(d.projectedSnapshot.events[0].completed,false);const category=d.projectedSnapshot.events[0].categoryId;assistant.applyDraft(apply(d));await assistant.chat({text:text.replace('9 AM to 5 PM','8 AM to 4 PM').replace('6 AM to 8 AM','7 AM to 9 AM').replace('8 AM to 10 AM','9 AM to 11 AM'),requestId:'second'});d=assistant.getDraft()!;assert.equal(d.projectedSnapshot.events[1].categoryId,category);assistant.applyDraft({...apply(d),requestId:'second-apply'});assert.equal(db.snapshot().categories.length,1);}finally{db.close();}}
});
test('plain text and tool request questions retain earlier work and resolve only their own event',async()=>{
 for(const name of ['meeting','concert']){const responses:any[]=[name==='meeting'?{message:{content:'What date and time should the meeting have?'}}:tool('finish_request',{outcome:'clarification',message:'What date and time should the concert have?'})];const {db,assistant}=setup(responses);try{await assistant.chat({text:'Add task called Read today',requestId:'read'});await assistant.chat({text:`Add a ${name} with notes, but I have not decided the date and time`,requestId:'question'});let d=assistant.getDraft()!;assert.equal(d.unresolved[0].requestId,'question');assert.throws(()=>assistant.applyDraft(apply(d)),/questions/);assert.equal(db.revision,0);responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',fields:{title:name,startDate:'2026-11-07',startTime:'19:00',endTime:'21:00',notes:'Music'}}]}),tool('preview_changes',{}));await assistant.chat({text:`Add the ${name} on 2026-11-07 from 7 PM to 9 PM with notes Music`,requestId:'answer'});d=assistant.getDraft()!;assert.equal(d.unresolved.length,0);assert.equal(d.projectedSnapshot.tasks.length,1);assistant.applyDraft(apply(d));assert.equal(db.snapshot().events.length,1);}finally{db.close();}}
});
test('contradictory activity duration is resolved by a corrected interval',async()=>{const {db,assistant}=setup();try{await assistant.chat({text:'Today I slept from 1 AM to 6 AM for 7 hours',requestId:'bad'});const before=assistant.getDraft()!;assert.equal(before.unresolved.length,1);await assistant.chat({text:'Today I slept from 1 AM to 8 AM',requestId:'correct'});const d=assistant.getDraft()!;assert.equal(d.unresolved.length,0);assert.equal(d.projectedSnapshot.events.length,1);assert.equal(d.projectedSnapshot.events[0].id,before.projectedSnapshot.events[0].id);assistant.applyDraft(apply(d));assert.equal(db.snapshot().events[0].endTime,'08:00');}finally{db.close();}});
test('unresolved workload session cannot be answered with a deadline',async()=>{const value={tasks:[{key:'read',title:'Read the report',source:'read the report',notes:'',dueDate:null,sessions:[],steps:[],dependsOnKeys:[]}],unresolved:[{taskKey:'read',field:'sessions',source:'schedule this on the calendar',question:'What date should I schedule it?'}]};const {db,assistant}=setup([{message:{content:JSON.stringify(value)}}]);try{await assistant.chat({text:'I need to read the report. Please schedule this on the calendar; I have not decided when. '+('The report is background reading for my personal research and these are context notes. '.repeat(10)),requestId:'long'});let d=assistant.getDraft()!;const task=d.projectedSnapshot.tasks[0],issue=d.unresolved[0];assert.equal(issue.field,'sessions');assert.throws(()=>assistant.editDraft({...edit(d),changes:[{action:'update',entity:'task',id:task.id,fields:{dueDate:'2026-11-12'}}],resolveIssueIds:[issue.id]}),/session/i);assert.equal(db.revision,0);d=assistant.editDraft({...edit(d),changes:[{action:'create',entity:'event',id:'session',fields:{title:task.title,linkedTaskId:task.id,startDate:'2026-11-12'}}],resolveIssueIds:[issue.id]});assert.equal(d.unresolved.length,0);assistant.applyDraft(apply(d));assert.equal(db.snapshot().tasks[0].dueDate,null);assert.equal(db.snapshot().events[0].linkedTaskId,task.id);}finally{db.close();}});

test('a required plain-text question after publishing blocks the whole compound preview', async () => {
 const question = 'What date and time should the meeting have?';
 const responses = [
  tool('stage_changes', {changes:[{action:'create',entity:'task',title:'Read'}]}),
  tool('preview_changes', {}),
  {message:{content:question}},
 ];
 const {db,assistant} = setup(responses);
 try {
  const result = await assistant.chat({text:'Add a task called Read and add a meeting with notes, but I have not decided the date and time',requestId:'compound'});
  assert.equal(result.content, question);
  const draft = assistant.getDraft()!;
  const [issue] = draft.unresolved;
  assert.equal(issue?.requestId, 'compound');
  assert.throws(() => assistant.applyDraft(apply(draft)), /questions/);
  assert.equal(db.revision, 0);
  responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',title:'Meeting',startDate:'2026-11-12',startTime:'09:00',notes:'Discussion'}]}),tool('preview_changes',{}));
  await assistant.chat({text:'Tomorrow at 9 AM',clarificationIssueId:issue.id,requestId:'compound-answer'});
  const resolved = assistant.getDraft()!;
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.id, draft.id);
  assistant.applyDraft(apply(resolved));
  assert.deepEqual(db.snapshot().tasks.map(task => task.title), ['Read']);
  assert.deepEqual(db.snapshot().events.map(event => event.title), ['Meeting']);
 } finally { db.close(); }
});

test('optional and read-only text questions leave the existing proposal unchanged', async () => {
 const responses = [
  {message:{content:'What time would you prefer? The time is optional.'}},
  {message:{content:'What date and time should I show?'}},
 ];
 const {db,assistant} = setup(responses);
 try {
  await assistant.chat({text:'Add task called Read today',requestId:'optional-seed'});
  const before = assistant.getDraft()!;
  await assistant.chat({text:'Add a meeting on 2026-11-12; the time is optional',requestId:'optional'});
  await assistant.chat({text:'What appointments are on the calendar?',requestId:'read-only'});
  const after = assistant.getDraft()!;
  assert.equal(after.version,before.version);
  assert.equal(after.unresolved.length,0);
  assert.equal(db.revision,0);
 } finally { db.close(); }
});

test('explicitly answering a named event or notes question resolves only its associated record', async () => {
 const cases = [
  {request:'Add an event called Jazz Night with notes, but I have not decided the date and time',question:'What date and time should Jazz Night have?',answer:'Tomorrow at 9 AM',title:'Jazz Night'},
  {request:'Add a meeting on Tuesday with notes, but ask me for their content',question:'What should I put in the meeting notes?',answer:'Discuss the spring launch',title:'Meeting'},
  {request:'Add a workshop on Tuesday and ask me what equipment to bring',question:'Which equipment should we bring?',answer:'Bring a projector',title:'Workshop'},
 ];
 for (const {request,question,answer,title} of cases) {
  const responses = [tool('finish_request',{outcome:'clarification',message:question})];
  const {db,assistant} = setup(responses);
  const notes = title==='Jazz Night'?'Music':answer;
  try {
   await assistant.chat({text:'Add task called Read today',requestId:'seed'});
   await assistant.chat({text:request,requestId:'question'});
   const [issue] = assistant.getDraft()!.unresolved;
   assert.equal(issue.requestId,'question');
   responses.push(tool('stage_changes',{changes:[{action:'create',entity:'event',title,startDate:'2026-11-12',startTime:'09:00',notes}]}),tool('preview_changes',{}));
   await assistant.chat({text:answer,clarificationIssueId:issue.id,requestId:'answer'});
   const resolved = assistant.getDraft()!;
   assert.equal(resolved.unresolved.length,0);
   assistant.applyDraft(apply(resolved));
   assert.equal(db.snapshot().tasks[0].title,'Read');
   assert.equal(db.snapshot().events[0].title,title);
   assert.equal(db.snapshot().events[0].notes,notes);
  } finally { db.close(); }
 }
});

const unresolvedSession = {tasks:[{key:'read',title:'Read the report',source:'read the report',notes:'',dueDate:null,sessions:[],steps:[],dependsOnKeys:[]}],unresolved:[{taskKey:'read',field:'sessions',source:'schedule this on the calendar',question:'What date should I schedule it?'}]};
const longSessionRequest = 'I need to read the report. Please schedule this on the calendar; I have not decided when. '+('The report is background reading for my personal research and these are context notes. '.repeat(10));

test('a short answer to a workload session question goes through validated session tools', async () => {
 const responses: any[] = [{message:{content:JSON.stringify(unresolvedSession)}}];
 const {db,assistant} = setup(responses);
 try {
  await assistant.chat({text:longSessionRequest,requestId:'workload'});
  const task = assistant.getDraft()!.projectedSnapshot.tasks[0];
  responses.push((body: {tools?:{function:{name:string}}[];messages:{content:string}[]}) => {
   // A valid task-correction response cannot encode a linked session.
   if (!body.tools) return {message:{content:JSON.stringify({isReply:true,updates:[],newTasks:[],unresolved:[]})}};
   assert.ok(body.tools.some(tool => tool.function.name==='stage_changes'));
   assert.match(body.messages[0].content,/sessions/);
   return tool('stage_changes',{changes:[{action:'create',entity:'event',title:task.title,kind:'planned',linkedTaskId:task.id,startDate:'2026-11-12',startTime:'09:00'}]});
  },tool('preview_changes',{}));
  await assistant.chat({text:'2026-11-12 at 9 AM',requestId:'session-answer'});
  const draft = assistant.getDraft()!;
  assert.equal(draft.unresolved.length,0);
  assert.equal(db.revision,0);
  assistant.applyDraft(apply(draft));
  assert.equal(db.snapshot().tasks[0].dueDate,null);
  assert.equal(db.snapshot().events[0].linkedTaskId,task.id);
  assert.equal(db.snapshot().events[0].startDate,'2026-11-12');
 } finally { db.close(); }
});

test('the normal Schedule work payload resolves a typed question only with an explicitly dated planned session', async () => {
 const {db,assistant} = setup([{message:{content:JSON.stringify(unresolvedSession)}}]);
 try {
  db.mutate({changes:[
   {action:'create',entity:'event',id:'actual',fields:{title:'Logged activity',kind:'actual',startDate:'2026-11-11'}},
   {action:'create',entity:'event',id:'planned',fields:{title:'Other session',kind:'planned',startDate:'2026-11-11'}},
  ],label:'Existing events',expectedRevision:0,requestId:'existing'});
  await assistant.chat({text:longSessionRequest,requestId:'workload'});
  let draft = assistant.getDraft()!;
  const task = draft.projectedSnapshot.tasks[0];
  const issue = draft.unresolved[0];
  for (const fields of [{linkedTaskId:task.id},{linkedTaskId:task.id,startDate:'2026-11-12'}]) {
   assert.throws(() => assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'event',id:'actual',fields}],resolveIssueIds:[issue.id]}),/session/i);
  }
  for (const fields of [{linkedTaskId:task.id},{linkedTaskId:task.id,startDate:'2026-11-11'}]) {
   assert.throws(() => assistant.editDraft({...edit(draft),changes:[{action:'update',entity:'event',id:'planned',fields}],resolveIssueIds:[issue.id]}),/session/i);
  }
  assert.throws(() => assistant.applyDraft(apply(draft)),/questions/);
  draft = assistant.editDraft({...edit(draft),changes:[{action:'create',entity:'event',fields:{title:task.title,kind:'planned',linkedTaskId:task.id,startDate:'2026-11-12',endDate:'2026-11-12',startTime:'09:00',endTime:null}}],resolveIssueIds:[]});
  assert.equal(draft.unresolved.length,0);
  assert.equal(db.revision,1);
  assistant.applyDraft(apply(draft));
  assert.equal(db.snapshot().tasks[0].dueDate,null);
  const created = db.snapshot().events.find(event=>event.linkedTaskId===task.id);
  assert.equal(created?.kind,'planned');
  assert.equal(created?.startDate,'2026-11-12');
 } finally { db.close(); }
});

test('a separate actual report preserves the preceding unresolved interval', async () => {
 const {db,assistant} = setup();
 try {
  await assistant.chat({text:'Today I slept from 1 AM to 6 AM for 7 hours',requestId:'pending-interval'});
  const before = assistant.getDraft()!;
  const placeholder = before.projectedSnapshot.events[0];
  await assistant.chat({text:'Yesterday I slept from 2 AM to 8 AM as a separate interval',requestId:'separate'});
  const draft = assistant.getDraft()!;
  assert.deepEqual(draft.unresolved.map(issue=>issue.id),before.unresolved.map(issue=>issue.id));
  assert.equal(draft.projectedSnapshot.events.length,2);
  assert.equal(draft.projectedSnapshot.events.find(event=>event.id===placeholder.id)?.startTime,null);
  assert.equal(draft.projectedSnapshot.events.find(event=>event.id!==placeholder.id)?.startTime,'02:00');
  assert.throws(()=>assistant.applyDraft(apply(draft)),/questions/);
  assert.equal(db.revision,0);
  await assistant.chat({text:'1 AM to 8 AM',requestId:'original-interval-answer'});
  const resolved = assistant.getDraft()!;
  assert.equal(resolved.unresolved.length,0);
  assert.equal(resolved.projectedSnapshot.events.find(event=>event.id===placeholder.id)?.startTime,'01:00');
  assistant.applyDraft(apply(resolved));
  assert.equal(db.snapshot().events.length,2);
 } finally { db.close(); }
});
