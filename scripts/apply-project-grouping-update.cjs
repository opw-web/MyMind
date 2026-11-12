// Update only the assistant modules, preserving planner data and runtime settings.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawnSync,spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
if(process.argv[2]!=='--apply')throw new Error('Expected --apply for the requested installed-app update.');
const root=path.resolve(__dirname,'..'),dataDir=path.resolve(process.env.LOCALAPPDATA,'MYMIND'),installedApp=path.resolve(process.env.LOCALAPPDATA,'Programs','MYMIND','resources','app'),executable=path.resolve(installedApp,'../..','MYMIND.exe');
assert.equal(JSON.parse(fs.readFileSync(path.join(installedApp,'package.json'),'utf8')).name,'mymind');
assert.ok(fs.existsSync(executable));
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'test-results','project-grouping-model-report.json'),'utf8')).passed,true);
if(fs.existsSync(path.join(root,'test-results','mixed-project-model-report.json')))assert.equal(JSON.parse(fs.readFileSync(path.join(root,'test-results','mixed-project-model-report.json'),'utf8')).passed,true);
const files=['assistant.js','capabilities.js','project-grouping.js'];
for(const file of files)assert.ok(fs.existsSync(path.join(root,'dist','main',file)));
const backupDir=path.resolve(process.env.LOCALAPPDATA,'MYMIND-backups',`project-grouping-${new Date().toISOString().replace(/[:.]/g,'-')}`);
fs.mkdirSync(backupDir,{recursive:true});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function logicalState(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return JSON.stringify(Object.fromEntries(tables.map(({name})=>{assert.match(name,/^[a-z_]+$/i);return [name,db.prepare(`SELECT * FROM "${name}"`).all().map(row=>JSON.stringify(row)).sort()];})));
  }finally{db.close();}
}
async function preserveVisibleChat(){
  const portFile=path.join(dataDir,'DevToolsActivePort');if(!fs.existsSync(portFile))return;
  const port=Number(fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0]);if(!Number.isInteger(port)||port<1||port>65535)return;
  let pages;try{const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)});pages=await response.json();}catch{return;}
  const page=pages.find(p=>p.type==='page'&&p.url.startsWith('file:')&&decodeURIComponent(p.url).replace(/\\/g,'/').toLowerCase().includes('/mymind/resources/app/'));
  if(!page)return;
  const result=await new Promise((resolve,reject)=>{
    const socket=new WebSocket(page.webSocketDebuggerUrl),timer=setTimeout(()=>{socket.close();reject(new Error('Could not preserve the open MYMIND chat.'));},5000);
    socket.onopen=()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`JSON.stringify({draft:document.querySelector('#assistant-input')?.value??'',chat:document.querySelector('.chat-panel')?.innerText??'',busy:!!document.querySelector('button[aria-label="Stop response"]'),recording:!!document.querySelector('#assistant-input')?.readOnly})`,returnByValue:true}}));
    socket.onmessage=event=>{const reply=JSON.parse(event.data);if(reply.id!==1)return;clearTimeout(timer);socket.close();if(reply.error||reply.result?.exceptionDetails)reject(new Error('Could not preserve the open MYMIND chat.'));else resolve(JSON.parse(reply.result.result.value));};
    socket.onerror=()=>{clearTimeout(timer);socket.close();reject(new Error('Could not inspect the running MYMIND app.'));};
  });
  fs.writeFileSync(path.join(backupDir,'open-chat.json'),JSON.stringify(result,null,2));
  assert.ok(!result.busy&&!result.recording,'MYMIND is still replying or recording. Finish that interaction before updating.');
}
function backupSqlite(file,directory=backupDir){
  const db=new DatabaseSync(file,{readOnly:true});try{db.prepare('VACUUM INTO ?').run(path.join(directory,path.basename(file)));}finally{db.close();}
}
(async()=>{
  let closedApp=false;
  try{
  if(process.argv.includes('--restart-processes')){
    const recovery=path.join(backupDir,'before-restart');fs.mkdirSync(recovery);
    backupSqlite(path.join(dataDir,'planner.sqlite'),recovery);backupSqlite(path.join(dataDir,'dictation.sqlite'),recovery);
    fs.copyFileSync(path.join(dataDir,'assistant-settings.json'),path.join(recovery,'assistant-settings.json'));
    const stopped=spawnSync('powershell.exe',['-NoProfile','-Command',"$plannerExecutable=Join-Path $env:LOCALAPPDATA 'Programs\\MYMIND\\MYMIND.exe'; $plannerTargets=Get-CimInstance Win32_Process -Filter \"name = 'MYMIND.exe'\" | Where-Object { $_.ExecutablePath -eq $plannerExecutable }; foreach ($plannerTarget in $plannerTargets) { Stop-Process -Id $plannerTarget.ProcessId -ErrorAction SilentlyContinue }; $plannerDeadline=(Get-Date).AddSeconds(10); while ((Get-Process MYMIND -ErrorAction SilentlyContinue) -and (Get-Date) -lt $plannerDeadline) { Start-Sleep -Milliseconds 250 }; if (Get-Process MYMIND -ErrorAction SilentlyContinue) { exit 1 }"],{windowsHide:true});
    assert.equal(stopped.status,0,'The verified MYMIND processes did not stop. No installed files were changed.');
    process.argv.push('--already-closed');
  }
  if(!process.argv.includes('--already-closed'))await preserveVisibleChat();
  const closeCommand=process.argv.includes('--already-closed')?'if (Get-Process MYMIND -ErrorAction SilentlyContinue) { exit 1 }':"$plannerProcesses=Get-Process MYMIND -ErrorAction SilentlyContinue; foreach ($plannerProcess in $plannerProcesses) { if ($plannerProcess.MainWindowHandle -ne 0) { [void]$plannerProcess.CloseMainWindow() } }; $plannerDeadline=(Get-Date).AddSeconds(15); while ((Get-Process MYMIND -ErrorAction SilentlyContinue) -and (Get-Date) -lt $plannerDeadline) { Start-Sleep -Milliseconds 250 }; if (Get-Process MYMIND -ErrorAction SilentlyContinue) { exit 1 }";
  const closed=spawnSync('powershell.exe',['-NoProfile','-Command',closeCommand],{windowsHide:true});
  assert.equal(closed.status,0,'MYMIND did not close gracefully. No installed files were changed.');
  closedApp=true;
  const planner=path.join(dataDir,'planner.sqlite'),dictation=path.join(dataDir,'dictation.sqlite'),settings=path.join(dataDir,'assistant-settings.json');
  const before={planner:logicalState(planner),dictation:logicalState(dictation),settings:digest(settings)};
  backupSqlite(planner);backupSqlite(dictation);fs.copyFileSync(settings,path.join(backupDir,'assistant-settings.json'));
  const manifest=files.map(file=>{const target=path.resolve(installedApp,'dist','main',file);assert.ok(target.startsWith(installedApp+path.sep));const existed=fs.existsSync(target);if(existed)fs.copyFileSync(target,path.join(backupDir,file));return {file,target,existed};});
  try{
    for(const {file,target} of manifest){fs.copyFileSync(path.join(root,'dist','main',file),target+'.new');fs.renameSync(target+'.new',target);}
    for(const {file,target} of manifest)assert.equal(digest(target),digest(path.join(root,'dist','main',file)));
    const {PlannerDatabase}=require(path.join(installedApp,'dist','main','database.js')),{PlannerAssistant}=require(path.join(installedApp,'dist','main','assistant.js')),{todayIn}=require(path.join(installedApp,'dist','shared','dates.js'));
    const db=new PlannerDatabase(':memory:');try{
      db.mutate({label:'Installed validation fixture',expectedRevision:0,requestId:'fixture',changes:Array.from({length:3},(_,i)=>({action:'create',entity:'task',id:`fixture-${i}`,fields:{title:`Test work ${i}`,scheduledDate:todayIn(),notes:'Preserve this'}}))});
      const original=db.snapshot();let calls=0;
      const assistant=new PlannerAssistant(db,{status:{state:'ready',context:32768},model:'test',call:async()=>{calls++;throw new Error('This grouping must not need inference.');}},()=>{});
      const result=await assistant.chat({text:'the 3 events for today on the calendar are connected to 3 tasks, and i want the 3 tasks in a project and i want to name the project to be VIP project',requestId:'installed-group'});
      assert.ok(result.receipt);assert.equal(calls,0);assert.equal(db.snapshot().projects.filter(p=>p.title==='VIP project').length,1);assert.deepEqual(db.snapshot().events,original.events);
      assert.match(result.content,/Moved 3 tasks/);db.undo();assert.deepEqual(db.snapshot().tasks,original.tasks);assert.deepEqual(db.snapshot().events,original.events);
    }finally{db.close();}
    assert.equal(logicalState(planner),before.planner);assert.equal(logicalState(dictation),before.dictation);assert.equal(digest(settings),before.settings);
  }catch(error){
    for(const {file,target,existed} of manifest){if(existed)fs.copyFileSync(path.join(backupDir,file),target);else if(fs.existsSync(target))fs.unlinkSync(target);}
    throw error;
  }
  const report={passed:true,installedApp,backupDir,updatedModules:files,plannerPreserved:true,dictationPreserved:true,settingsPreserved:true,installedExactRequestPassed:true};
  fs.writeFileSync(path.join(root,'test-results','project-grouping-update-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{
    if(closedApp){
      const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.MYMIND_TEST_MODE;delete env.MYMIND_SKIP_OLLAMA;delete env.MYMIND_DATA_DIR;
      const child=spawn(executable,[],{detached:true,stdio:'ignore',windowsHide:true,env});child.unref();
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
