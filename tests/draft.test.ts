import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {prepareDraft,searchWords} from '../src/main/draft';
test('new project/section/task names resolve as one atomic draft, including temporary model references',()=>{
  const db=new PlannerDatabase(':memory:');try{
    const draft=prepareDraft(db.snapshot(),[],[{action:'create',entity:'project',fields:{title:'School'}},{action:'create',entity:'section',fields:{title:'Homework',projectId:'school-new-id'}},{action:'create',entity:'task',fields:{title:'Math worksheet',sectionId:'homework-new-id',dueDate:'2026-10-10'}}]);
    const staged=db.preview(draft,0);assert.equal(staged.changes[1].fields!.projectId,staged.changes[0].id);assert.equal(staged.changes[2].fields!.projectId,staged.changes[0].id);assert.equal(staged.changes[2].fields!.sectionId,staged.changes[1].id);
    const repeated=prepareDraft(db.snapshot(),staged.changes,[{action:'create',entity:'project',fields:{title:'School'}},{action:'create',entity:'section',fields:{title:'Homework',projectTitle:'School'}},{action:'create',entity:'task',fields:{title:'Math worksheet',sectionTitle:'Homework',dueDate:'2026-10-10'}}]);assert.equal(repeated.length,3);db.preview(repeated,0);
  }finally{db.close();}
});
test('duplicate project names cannot resolve arbitrarily, and search ignores command words',()=>{
  const db=new PlannerDatabase(':memory:');try{db.mutate({changes:[{action:'create',entity:'project',id:'one',fields:{title:'School'}},{action:'create',entity:'project',id:'two',fields:{title:'School'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});assert.throws(()=>prepareDraft(db.snapshot(),[],[{action:'create',entity:'task',fields:{title:'Homework',projectTitle:'School'}}]),/Several projects/);assert.deepEqual(searchWords('Mark Walls done'),['walls']);}finally{db.close();}
});
