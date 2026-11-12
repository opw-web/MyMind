import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {preferenceSchema} from '../src/shared/validation';
import {PlannerAssistant} from '../src/main/assistant';
import {previewSnapshot} from '../src/renderer/preview-state';

test('existing preferences default Light, persist appearance, and pending projection keeps live preferences',()=>{
 const db=new PlannerDatabase(':memory:');try{assert.equal(db.snapshot().preferences.appearance,'light');
 const assistant=new PlannerAssistant(db,{} as any,()=>{});const turn=assistant.drafts.begin('theme');assistant.drafts.stage(turn,[{action:'create',entity:'task',fields:{title:'Pending'}}]);assistant.drafts.end(turn);
 for(const appearance of ['dark','system','light'] as const){db.preferences({appearance});assert.equal(previewSnapshot(db.snapshot(),assistant.getDraft()).preferences.appearance,appearance);}
 assert.equal(db.revision,0);assert.equal(preferenceSchema.safeParse({appearance:'invalid'}).success,false);
 }finally{db.close();}
});
