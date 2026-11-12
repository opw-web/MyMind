import test from 'node:test';
import assert from 'node:assert/strict';
import {previewSnapshot,draftOwns,resolutionIds,calendarResize} from '../src/renderer/preview-state';
import type {PendingDraft,Snapshot,Task} from '../src/shared/model';
const task=(id:string,title=id)=>({id,title,dueDate:null,completed:false,steps:[],projectId:'inbox'} as unknown as Task);
const saved={revision:2,tasks:[task('a'),task('concurrent')],events:[],projects:[],sections:[],categories:[],preferences:{timezone:'UTC'}} as unknown as Snapshot;
const draft={id:'d',version:1,baseRevision:1,stale:true,items:[{entity:'task',id:'a',action:'update',title:'Changed',before:{title:'a'},after:{title:'Changed'}}],projectedSnapshot:{...saved,tasks:[task('a','Changed')],preferences:{timezone:'Old'}},unresolved:[{id:'date',entity:'task',targetId:'a',field:'dueDate',required:true},{id:'notes',entity:'task',targetId:'a',field:'notes',required:true}]} as unknown as PendingDraft;
test('projection retains concurrent saved records and live preferences without losing proposed target',()=>{const s=previewSnapshot(saved,draft);assert.deepEqual(s.tasks.map(t=>t.title),['Changed','concurrent']);assert.equal(s.preferences.timezone,'UTC');assert.equal(s.revision,2);});
test('proposal ownership routes edits by entity and stable identity',()=>{assert.equal(draftOwns(draft,{entity:'task',id:'a',action:'update'}),true);assert.equal(draftOwns(draft,{entity:'event',id:'a',action:'update'}),false);});
test('editor resolution targets only fields explicitly corrected; null deadline is never a fix',()=>{assert.deepEqual(resolutionIds(draft,[{entity:'task',id:'a',action:'update',fields:{notes:'fixed'}}]),['notes']);assert.deepEqual(resolutionIds(draft,[{entity:'task',id:'a',action:'update',fields:{dueDate:null}}]),[]);});
test('calendar resize snaps quarter hours and rolls midnight into next date',()=>{assert.deepEqual(calendarResize('2026-11-05',1440),{endDate:'2026-11-06',endTime:'00:00'});assert.deepEqual(calendarResize('2026-11-05',613),{endDate:'2026-11-05',endTime:'10:15'});});
import {PlannerDatabase} from '../src/main/database';
import {PendingDraftService} from '../src/main/pending-draft';
test('deleting a newly proposed parent cancels its creation and retains detached sessions and dependents',()=>{
 const db=new PlannerDatabase(':memory:');try{const service=new PendingDraftService(db),turn=service.begin('mixed');service.stage(turn,[{action:'create',entity:'task',id:'parent',fields:{title:'Parent',steps:[{id:'read',title:'Read'}]}},{action:'create',entity:'task',id:'child',fields:{title:'Child',dependsOnIds:['parent']}},{action:'create',entity:'event',id:'session',fields:{title:'Session',startDate:'2026-11-06',linkedTaskId:'parent',linkedStepId:'read'}}]);service.end(turn);const before=service.getDraft()!,after=service.editDraft({draftId:before.id,version:before.version,expectedRevision:0,changes:[{action:'delete',entity:'task',id:'parent'}]});assert.equal(after.projectedSnapshot.tasks.some(t=>t.id==='parent'),false);assert.deepEqual(after.projectedSnapshot.tasks[0].dependsOnIds,[]);assert.equal(after.projectedSnapshot.events[0].linkedTaskId,null);assert.equal(after.projectedSnapshot.events[0].linkedStepId,null);assert.equal(db.revision,0);service.applyDraft({draftId:after.id,version:after.version,expectedRevision:0,requestId:'apply'});assert.equal(db.snapshot().events.length,1);assert.equal(db.snapshot().tasks.length,1);}finally{db.close();}
});

import {navigationRange} from '../src/renderer/preview-state';
test('far-date navigation keeps the virtual date window bounded',()=>{const next=navigationRange({start:-90,end:120},25000);assert.ok(next.end-next.start<=240);assert.ok(next.start<=25000&&next.end>25000);});
import {draftRequiresChange,visibleAllDayEntries} from '../src/renderer/preview-state';
import type {CalendarEntry} from '../src/shared/calendar';
test('new records referencing proposed-only task, step, project, section, category or prerequisite stay in the proposal',()=>{
 const projected={...saved,tasks:[...saved.tasks.map(t=>t.id==='a'?{...t,steps:[{id:'new-step',title:'New',completed:false}]}:t),{...task('pending'),steps:[{id:'pending-step',title:'Step',completed:false}]}],projects:[{id:'new-project'}],sections:[{id:'new-section'}],categories:[{id:'new-category'}]} as unknown as Snapshot;
 const pending={...draft,projectedSnapshot:projected};
 for(const fields of [{linkedTaskId:'pending',linkedStepId:'pending-step'},{linkedTaskId:'a',linkedStepId:'new-step'},{projectId:'new-project'},{sectionId:'new-section'},{categoryId:'new-category'},{dependsOnIds:['pending']}])assert.equal(draftRequiresChange(pending,saved,{entity:'event',action:'create',fields}),true,JSON.stringify(fields));
 assert.equal(draftRequiresChange(pending,saved,{entity:'event',action:'create',fields:{title:'Unrelated'}}),false);assert.equal(draftRequiresChange(pending,saved,{entity:'event',action:'create',fields:{linkedTaskId:'a'}}),false);
});
test('all-day reveal promotes only the selected composite identity and default presentation returns without it',()=>{const entries=[{id:'same',entryType:'session'},{id:'b',entryType:'session'},{id:'c',entryType:'session'},{id:'same',entryType:'deadline'}] as CalendarEntry[];assert.deepEqual(visibleAllDayEntries(entries,'deadline:same'),[entries[0],entries[1],entries[3]]);assert.deepEqual(visibleAllDayEntries(entries),entries.slice(0,3));});
