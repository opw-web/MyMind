// Explicit user-requested reset of the backed-up failed dictation batch.
// One normal mutation retains a complete Undo record; drafts/settings stay.
const {PlannerDatabase}=require('../dist/main/database'),{DatabaseSync}=require('node:sqlite'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const backupPath=path.resolve('test-results/upgrade-2.3.0/planner-before.sqlite');assert.ok(fs.existsSync(backupPath),'Create the WAL-safe backup first.');
const backup=new DatabaseSync(backupPath,{readOnly:true}),ids=backup.prepare('SELECT id FROM tasks').all().map(r=>r.id),categoryIds=backup.prepare('SELECT id FROM categories').all().map(r=>r.id);backup.close();
const db=new PlannerDatabase(path.join(process.env.LOCALAPPDATA,'MYMIND','planner.sqlite')),requestId='reset-failed-dictation-23184a67';
try{
 if(db.receipt(requestId)){console.log(JSON.stringify({passed:true,alreadyReset:true}));process.exitCode=0;}
 else{
  const before=db.snapshot();assert.deepEqual(before.tasks.map(t=>t.id).sort(),[...ids].sort(),'Planner tasks changed after the backup; do not clear a different batch.');
  const protectedState=s=>JSON.stringify({events:s.events,projects:s.projects,sections:s.sections,preferences:s.preferences});
  const hash=crypto.createHash('sha256').update(protectedState(before)).digest('hex');
  const changes=[...ids.map(id=>({action:'delete',entity:'task',id})),...categoryIds.map(id=>({action:'delete',entity:'category',id}))];
  const receipt=db.mutate({changes,label:'Reset failed dictated workload',expectedRevision:before.revision,requestId});
  const after=db.snapshot();assert.equal(after.tasks.length,0);assert.equal(protectedState(after),protectedState(before));assert.equal(after.canUndo,true);
  const report={passed:true,tasksCleared:ids.length,categoriesCleared:categoryIds.length,undoAvailable:true,protectedStateHash:hash,revision:receipt.revision};fs.writeFileSync('test-results/failed-dictation-reset-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }
}finally{db.close();}
