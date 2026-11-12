import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DictationDrafts} from '../src/main/dictation-drafts';
import {LiveTranscript} from '../src/renderer/live-transcript';
const audio=(...bytes:number[])=>Uint8Array.from(bytes).buffer;
test('audio chunks are durable, ordered and idempotent across reopening',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'mymind-dictation-')),'dictation.sqlite'),generation=randomUUID();
  let db=new DictationDrafts(path);const draft=db.create({generation,prefix:'Typed prefix'});
  const first={draftId:draft.id,generation,sequence:0,audio:audio(1,2,3),seconds:1};
  db.append(first);db.append(first);
  assert.throws(()=>db.append({...first,audio:audio(9)}),/different content/);
  assert.throws(()=>db.append({...first,sequence:2}),/missing/);
  db.append({...first,sequence:1,audio:audio(4,5),seconds:2});
  db.checkpoint({draftId:draft.id,generation,liveText:'Opening words and closing words',reviewText:'Typed prefix Opening words and closing words'});
  db.close();db=new DictationDrafts(path);
  try{assert.equal(db.list().length,1);assert.equal(db.get(draft.id).bytes,5);assert.equal(db.get(draft.id).nextSequence,2);assert.deepEqual([...new Uint8Array(db.audio(draft.id,generation))],[1,2,3,4,5]);assert.match(db.get(draft.id).reviewText,/closing words/);}finally{db.close();}
});
test('empty results and final results arriving after edits preserve review text',()=>{
  const db=new DictationDrafts(':memory:'),generation=randomUUID(),draft=db.create({generation,prefix:''});
  try{
    const live=db.checkpoint({draftId:draft.id,generation,liveText:'Complete live text',reviewText:'Complete live text'});
    db.final(draft.id,generation,'',live.revision);assert.equal(db.get(draft.id).reviewText,'Complete live text');
    db.checkpoint({draftId:draft.id,generation,reviewText:'My edited review'});
    db.final(draft.id,generation,'Final recognized text',live.revision);
    assert.equal(db.get(draft.id).reviewText,'My edited review');assert.equal(db.get(draft.id).finalText,'Final recognized text');
    const current=db.get(draft.id);db.final(draft.id,generation,'Approved final text',current.revision);assert.equal(db.get(draft.id).reviewText,'Approved final text');db.progress(draft.id,generation,'Incomplete retry');db.final(draft.id,generation,'');assert.equal(db.get(draft.id).finalText,'Approved final text');assert.equal(db.get(draft.id).partialText,'Incomplete retry');
  }finally{db.close();}
});
test('restoring a draft invalidates old session writes and Discard removes its audio',()=>{
  const db=new DictationDrafts(':memory:'),generation=randomUUID(),draft=db.create({generation,prefix:'Safe'});
  try{db.append({draftId:draft.id,generation,sequence:0,audio:audio(1),seconds:1});const next=randomUUID();db.bind(draft.id,next);assert.throws(()=>db.final(draft.id,generation,'stale'),/earlier session/);assert.throws(()=>db.append({draftId:draft.id,generation,sequence:1,audio:audio(2),seconds:2}),/earlier session/);assert.equal(db.get(draft.id).reviewText,'Safe');db.discard(draft.id);assert.deepEqual(db.list(),[]);assert.throws(()=>db.get(draft.id),/no longer/);}finally{db.close();}
});
test('overlapping previews retain the opening, revise the tail and preserve repeats through silence',()=>{
  const live=new LiveTranscript(),words=(text:string,offset:number)=>text.split(' ').map((text,i)=>({text,start:offset+i,end:offset+i+.8}));
  live.merge(words('Opening words I really really want to',0),0);
  live.merge(words('I really really want to finish this draft',2),2);
  assert.equal(live.text,'Opening words I really really want to finish this draft');
  live.merge([],30);assert.match(live.text,/Opening words/);
  live.merge(words('Closing words',40),38);assert.match(live.text,/draft Closing words$/);
});
