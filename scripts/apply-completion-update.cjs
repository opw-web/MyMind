// Apply this explicitly requested update and reset only after desktop validation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
if(process.argv[2]!=='--apply')throw new Error('Expected --apply for the authorized update and reset.');
const root=path.resolve(__dirname,'..');
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'test-results','completion-desktop-report.json'),'utf8')).passed,true);
const closed=spawnSync('powershell.exe',['-NoProfile','-Command',"$plannerProcesses=Get-Process MYMIND -ErrorAction SilentlyContinue; foreach ($plannerProcess in $plannerProcesses) { if ($plannerProcess.MainWindowHandle -ne 0) { [void]$plannerProcess.CloseMainWindow() } }; $plannerDeadline=(Get-Date).AddSeconds(15); while ((Get-Process MYMIND -ErrorAction SilentlyContinue) -and (Get-Date) -lt $plannerDeadline) { Start-Sleep -Milliseconds 250 }; if (Get-Process MYMIND -ErrorAction SilentlyContinue) { exit 1 }"],{windowsHide:true});
assert.equal(closed.status,0,'MYMIND did not close gracefully; no update or reset applied.');
const dataDir=path.resolve(process.env.LOCALAPPDATA,'MYMIND'),file=path.join(dataDir,'planner.sqlite'),installedApp=path.resolve(process.env.LOCALAPPDATA,'Programs','MYMIND','resources','app');
assert.ok(fs.existsSync(file));assert.ok(fs.existsSync(path.join(installedApp,'package.json')));
const backupDir=path.resolve(process.env.LOCALAPPDATA,'MYMIND-backups',`completion-update-${new Date().toISOString().replace(/[:.]/g,'-')}`);fs.mkdirSync(backupDir,{recursive:true});
const source=new DatabaseSync(file);try{source.prepare('VACUUM INTO ?').run(path.join(backupDir,'planner.sqlite'));}finally{source.close();}
fs.cpSync(path.join(installedApp,'dist'),path.join(backupDir,'app-dist'),{recursive:true});
fs.cpSync(path.join(root,'dist'),path.join(installedApp,'dist'),{recursive:true,force:true});
const {PlannerDatabase}=require('../dist/main/database'),db=new PlannerDatabase(file);
try{
 const before=db.snapshot(),protectedState=state=>JSON.stringify({projects:state.projects,sections:state.sections,categories:state.categories,preferences:state.preferences});
 const receipt=db.clearTasksAndEvents('explicit-completion-reset-2026-10-13'),after=db.snapshot();
 assert.equal(after.tasks.length,0);assert.equal(after.events.length,0);assert.equal(protectedState(after),protectedState(before));
 if(before.tasks.length||before.events.length)assert.equal(after.canUndo,true);
 assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 const report={passed:true,backupDir,installedApp,tasksCleared:before.tasks.length,eventsCleared:before.events.length,undoAvailable:after.canUndo,revision:receipt?.revision??after.revision};
 fs.writeFileSync(path.join(root,'test-results','completion-update-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{db.close();}
