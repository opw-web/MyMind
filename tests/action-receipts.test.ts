import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PlannerDatabase} from '../src/main/database';
import type {Change} from '../src/shared/model';

function manual(db:PlannerDatabase, changes:Change[]) {
  return db.mutate({changes, expectedRevision:db.revision, label:'Manual edit', requestId:randomUUID()});
}

function assistant(db:PlannerDatabase, changes:Change[], chatRequestId=randomUUID()) {
  db.beginChat({text:'Make these planner changes', requestId:chatRequestId});
  const expectedRevision=db.revision;
  const batch=db.previewBatch({changes, expectedRevision});
  return db.applyBatch(batch,{draftId:randomUUID(),version:1,expectedRevision,requestId:chatRequestId},
    {chatRequestId,content:'Updated your planner.'});
}

const task=(id:string,title:string):Change=>({entity:'task',id,action:'create',fields:{title,categoryId:null}});
const update=(id:string,fields:Record<string,unknown>):Change=>({entity:'task',id,action:'update',fields});

test('independent actions and checklist steps can be reversed in any order',()=>{
  const db=new PlannerDatabase(':memory:');
  try {
    const created=assistant(db,[task('task','Report'),task('other','Other work'),update('task',{
      steps:[{id:'one',title:'Outline',completed:false},{id:'two',title:'Write',completed:false}],
    })]).actions!;
    assert.deepEqual(created.map(card=>card.target.entity).sort(),['step','step','task','task']);
    const parent=created.find(card=>card.target.id==='task')!;
    assert.throws(()=>db.undoAction({actionId:parent.actionId,requestId:'parent-too-soon'}),/steps/i);
    const outline=created.find(card=>card.target.id==='one')!;
    const undo={actionId:outline.actionId,requestId:'undo-outline'};
    assert.equal(db.undoAction(undo).undone,true);
    const revision=db.revision;
    assert.equal(db.undoAction(undo).undone,true);
    assert.equal(db.revision,revision);
    assert.deepEqual(db.snapshot().tasks.find(item=>item.id==='task')!.steps.map(step=>step.id),['two']);
    assert.ok(db.snapshot().tasks.some(item=>item.id==='other'));
  } finally { db.close(); }
});

test('undo preserves unrelated fields, detects overlapping edits and restores causal order',()=>{
  const db=new PlannerDatabase(':memory:');
  try {
    manual(db,[task('task','Original')]);
    const first=assistant(db,[update('task',{title:'First'})]).actions![0];
    const second=assistant(db,[update('task',{title:'Second'})]).actions![0];
    manual(db,[update('task',{notes:'Keep my note'})]);
    assert.throws(()=>db.undoAction({actionId:first.actionId,requestId:'first'}),/changed/i);
    db.undoAction({actionId:second.actionId,requestId:'second'});
    db.undoAction({actionId:first.actionId,requestId:'first'});
    assert.equal(db.snapshot().tasks[0].title,'Original');
    assert.equal(db.snapshot().tasks[0].notes,'Keep my note');
    const third=assistant(db,[update('task',{title:'Third'})]).actions![0];
    manual(db,[update('task',{title:'Manual'})]);
    manual(db,[update('task',{title:'Third'})]);
    assert.throws(()=>db.undoAction({actionId:third.actionId,requestId:'third'}),/changed/i);
  } finally { db.close(); }
});

test('task deletion and its unlink side effect reverse together',()=>{
  const db=new PlannerDatabase(':memory:');
  try {
    manual(db,[task('task','Call'),{entity:'event',id:'block',action:'create',fields:{
      title:'Original block',startDate:'2026-11-18',categoryId:null,linkedTaskId:'task',
    }}]);
    const deleted=assistant(db,[{entity:'task',id:'task',action:'delete'}]).actions!;
    assert.equal(deleted.length,1);
    assert.equal(deleted[0].target.before?.title,'Call');
    assert.equal(db.snapshot().events[0].linkedTaskId,null);
    manual(db,[{entity:'event',id:'block',action:'update',fields:{notes:'Keep me'}}]);
    db.undoAction({actionId:deleted[0].actionId,requestId:'restore-task'});
    assert.equal(db.snapshot().events[0].linkedTaskId,'task');
    assert.equal(db.snapshot().events[0].notes,'Keep me');
  } finally { db.close(); }
});

test('restoring a deleted step restores its link and preserves independent checklist edits',()=>{
  const db=new PlannerDatabase(':memory:');
  try {
    const first={id:'first',title:'Call',completed:false},second={id:'second',title:'Write',completed:false};
    manual(db,[{...task('task','Prepare'),fields:{title:'Prepare',categoryId:null,steps:[first,second]}},{
      entity:'event',id:'step-block',action:'create',fields:{title:'Call',startDate:'2026-11-18',categoryId:null,linkedTaskId:'task',linkedStepId:first.id},
    }]);
    const receipt=assistant(db,[update('task',{steps:[second]})]);
    assert.deepEqual(receipt.actions?.map(action=>action.target.entity),['step']);
    const third={id:'third',title:'Publish',completed:false};
    manual(db,[update('task',{steps:[{...second,completed:true},third]})]);
    db.undoAction({actionId:receipt.actions![0].actionId,requestId:'restore-step'});
    assert.deepEqual(db.snapshot().tasks[0].steps,[first,{...second,completed:true},third]);
    assert.equal(db.snapshot().events[0].linkedStepId,first.id);
  } finally { db.close(); }
});

test('reversing new projects and tasks keeps independent linked records',()=>{
  const db=new PlannerDatabase(':memory:');
  try {
    const receipt=assistant(db,[{entity:'project',id:'project',action:'create',fields:{title:'New project'}},
      {...task('task','Linked task'),fields:{title:'Linked task',categoryId:null,projectId:'project'}},
      {entity:'event',id:'block',action:'create',fields:{title:'Linked block',startDate:'2026-11-18',categoryId:null,linkedTaskId:'task'}},
    ]);
    const undo=(entity:string)=>db.undoAction({actionId:receipt.actions!.find(card=>card.target.entity===entity)!.actionId,requestId:`undo-${entity}`});
    undo('project');
    assert.equal(db.snapshot().tasks[0].projectId,'inbox');
    undo('task');
    assert.equal(db.snapshot().events[0].linkedTaskId,null);
    undo('event');
    assert.equal(db.snapshot().events.length,0);
  } finally { db.close(); }
});

test('reopen recovers committed cards and interrupted turns, clean close keeps planner state',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mymind-action-receipts-'));
  const path=join(dir,'planner.sqlite');
  let db=new PlannerDatabase(path);
  try {
    const receipt=assistant(db,[task('saved','Saved work')],'completed-chat');
    db.beginChat({text:'An interrupted rant',requestId:'interrupted-chat'});
    db.close();
    db=new PlannerDatabase(path);
    db.recoverChat();
    assert.deepEqual(db.chatResult('completed-chat')?.receipt,receipt);
    assert.deepEqual(assistant(db,[task('accidental-duplicate','Duplicate work')],'completed-chat'),receipt);
    assert.equal(db.snapshot().tasks.length,1);
    assert.match(db.chatResult('interrupted-chat')!.content,/interrupted/i);
    assert.equal(db.chatHistory().length,4);
    db.clearChat();
    db.close();
    db=new PlannerDatabase(path);
    assert.equal(db.chatHistory().length,0);
    assert.equal(db.snapshot().tasks[0].title,'Saved work');
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
