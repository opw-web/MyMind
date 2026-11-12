import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerDatabase} from '../src/main/database';
import {layoutTaskFlow} from '../src/shared/task-flow';

test('flow layout places branches and joins after their prerequisites without overlapping siblings',()=>{
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:[{action:'create',entity:'task',id:'a',fields:{title:'Prototype'}},{action:'create',entity:'task',id:'b',fields:{title:'Box quote',dependsOnIds:['a']}},{action:'create',entity:'task',id:'c',fields:{title:'Sticker quote',dependsOnIds:['a']}},{action:'create',entity:'task',id:'d',fields:{title:'Order packaging',dependsOnIds:['b','c']}}],expectedRevision:0,label:'Fixture',requestId:'fixture'});
    const tasks=db.snapshot().tasks,layout=layoutTaskFlow(tasks,tasks),nodes=new Map(layout.nodes.map(n=>[n.task.id,n]));
    assert.equal(layout.edges.length,4);assert.ok(nodes.get('a')!.x<nodes.get('b')!.x);assert.equal(nodes.get('b')!.x,nodes.get('c')!.x);assert.ok(nodes.get('b')!.y+nodes.get('b')!.height<nodes.get('c')!.y);assert.ok(nodes.get('d')!.x>nodes.get('c')!.x);
  }finally{db.close();}
});

test('filtered flow shows prerequisite ancestors as context without adding unrelated tasks',()=>{
  const db=new PlannerDatabase(':memory:');try{
    db.mutate({changes:[{action:'create',entity:'task',id:'a',fields:{title:'Prototype',completed:true}},{action:'create',entity:'task',id:'b',fields:{title:'Packaging',dependsOnIds:['a']}},{action:'create',entity:'task',id:'c',fields:{title:'Unrelated'}}],expectedRevision:0,label:'Fixture',requestId:'fixture'});
    const tasks=db.snapshot().tasks,layout=layoutTaskFlow(tasks.filter(t=>t.id==='b'),tasks);
    assert.deepEqual(layout.nodes.map(n=>n.task.id),['a','b']);assert.equal(layout.nodes[0].context,true);assert.equal(layout.nodes[1].context,false);assert.equal(layout.edges.length,1);
  }finally{db.close();}
});
