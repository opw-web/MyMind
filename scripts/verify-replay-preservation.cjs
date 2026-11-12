// Compare protected planner data with the pre-reset backup. The failed batch
// was explicitly cleared; its full snapshot and Undo remain recoverable.
const {DatabaseSync}=require('node:sqlite'),{PlannerDatabase}=require('../dist/main/database'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const folder=path.resolve('test-results/upgrade-2.3.0'),source=path.join(process.env.LOCALAPPDATA,'MYMIND'),db=new PlannerDatabase(path.join(source,'planner.sqlite')),backup=new DatabaseSync(path.join(folder,'planner-before.sqlite'),{readOnly:true});
function rows(connection,table){return connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();}
try{
 const current=db.snapshot();for(const table of ['events','projects','sections']){const before=rows(backup,table).map(row=>JSON.parse(row.body));assert.deepEqual(current[table],before,`${table} must survive the authorized reset/replay.`);}
 const preferences=JSON.parse(backup.prepare("SELECT value FROM meta WHERE key='preferences'").get().value);const {taskLayout:_layout,...actual}=current.preferences;const {taskLayout:_oldLayout,...expected}=preferences;assert.deepEqual(actual,expected);
 const fingerprint=filename=>{const connection=new DatabaseSync(filename,{readOnly:true});try{const names=connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);return crypto.createHash('sha256').update(JSON.stringify(names.map(name=>connection.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()))).digest('hex');}finally{connection.close();}};
 assert.equal(fingerprint(path.join(source,'dictation.sqlite')),fingerprint(path.join(folder,'dictation-before.sqlite')),'Recoverable dictation drafts must survive.');
 assert.ok(db.receipt('reset-failed-dictation-23184a67'));assert.ok(current.canUndo);
 const report={passed:true,settingsPreserved:true,eventsPreserved:true,projectsPreserved:true,sectionsPreserved:true,dictationDraftsPreserved:true,failedBatchBackedUp:true,undoAvailable:true,tasks:current.tasks.length};fs.writeFileSync(path.join(folder,'replay-preservation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{db.close();backup.close();}
