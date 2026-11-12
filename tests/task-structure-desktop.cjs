const {_electron:electron}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {todayIn}=require('../dist/shared/dates');
const root=path.resolve(__dirname,'..'),dataDir=path.join(root,'test-results',`task-structure-${Date.now()}`),env={...process.env,MYMIND_DATA_DIR:dataDir,MYMIND_SKIP_OLLAMA:'1',MYMIND_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app;const errors=[];
async function launch(){app=await electron.launch({executablePath:process.env.MYMIND_TEST_EXECUTABLE||require('electron'),args:process.env.MYMIND_TEST_EXECUTABLE?[]:[root],env});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByTestId('calendar').waitFor();return page;}
const state=page=>page.evaluate(()=>window.planner.snapshot());
async function capture(file){await new Promise(resolve=>setTimeout(resolve,250));const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));fs.writeFileSync(path.join(root,'test-results',file),Buffer.from(png,'base64'));}
(async()=>{try{
 let page=await launch();await page.evaluate(async()=>{await window.planner.mutate({changes:[{action:'create',entity:'task',id:'prep',fields:{title:'Prepare career profile'}}],label:'Fixture',expectedRevision:0,requestId:'fixture'});});
 await page.getByRole('button',{name:'Tasks view',exact:true}).click();await page.getByRole('button',{name:'New task',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Title',{exact:true}).fill('Update LinkedIn profile');
 await dialog.getByRole('button',{name:'Add step',exact:true}).click();await dialog.getByLabel('Step 1 title').fill('Update headline');
 await dialog.getByRole('button',{name:'Add step',exact:true}).click();await dialog.getByLabel('Step 2 title').fill('Update experience');
 await dialog.getByRole('button',{name:'Move step 2 up',exact:true}).click();assert.equal(await dialog.getByLabel('Step 1 title').inputValue(),'Update experience');
 await dialog.getByLabel('Search prerequisite tasks').fill('career');await dialog.getByRole('button',{name:'Prepare career profile',exact:true}).click();await dialog.getByText(/Blocked by unfinished prerequisites/).waitFor();
 await dialog.getByLabel('Deadline',{exact:true}).fill(todayIn());await dialog.getByRole('button',{name:'Add task',exact:true}).click();await dialog.waitFor({state:'hidden'});
 let saved=await state(page),output=saved.tasks.find(t=>/LinkedIn/.test(t.title));assert.deepEqual(output.dependsOnIds,['prep']);assert.equal(output.steps.length,2);const ids=output.steps.map(s=>s.id);
 const row=page.locator('.checklist-view .task-row').filter({has:page.getByRole('button',{name:'Update LinkedIn profile',exact:true})}),hiddenFlowNode=page.locator(`.flow-node[data-task-id="${output.id}"]`);await row.getByText(/Blocked by/).waitFor();await hiddenFlowNode.getByLabel('Complete step Update experience').waitFor({state:'attached'});assert.equal(await hiddenFlowNode.isVisible(),false);
 await row.getByLabel('Complete step Update experience').check();await page.waitForFunction(id=>window.planner.snapshot().then(s=>s.tasks.find(t=>t.id===id).steps[0].completed),output.id);
 assert.equal((await state(page)).tasks.find(t=>t.id===output.id).completed,false);
 await page.locator('.task-tabs').getByRole('button',{name:'Blocked',exact:true}).click();assert.equal(await page.locator('.checklist-view .task-row').count(),1);
 await page.getByRole('button',{name:'Complete Update LinkedIn profile',exact:true}).click();await page.waitForFunction(id=>window.planner.snapshot().then(s=>s.tasks.find(t=>t.id===id).completed),output.id);
 await page.getByRole('button',{name:'Undo last change',exact:true}).click();await page.locator('.task-tabs').getByRole('button',{name:'All',exact:true}).click();
 await row.getByRole('button',{name:'Prepare career profile',exact:true}).click();await page.getByRole('dialog').getByLabel('Title',{exact:true}).waitFor();await page.getByRole('button',{name:'Close editor',exact:true}).click();
 await page.getByRole('button',{name:'Complete Prepare career profile',exact:true}).click();await row.getByText(/Blocked by/).waitFor({state:'hidden'});await page.locator('.task-tabs').getByRole('button',{name:'Ready',exact:true}).click();assert.equal(await page.locator('.checklist-view .task-row').count(),1);
 await page.locator('.task-tabs').getByRole('button',{name:'All',exact:true}).click();await page.getByRole('button',{name:'Reopen Prepare career profile',exact:true}).click();await row.getByText(/Blocked by/).waitFor();
 await page.getByRole('button',{name:'Edit task Update LinkedIn profile',exact:true}).click();await dialog.getByLabel('Step 1 title').fill('Refresh experience');await dialog.getByRole('button',{name:'Delete step 2',exact:true}).click();await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await dialog.waitFor({state:'hidden'});output=(await state(page)).tasks.find(t=>t.id===output.id);assert.equal(output.steps[0].id,ids[0]);assert.equal(output.steps.length,1);
 await page.getByRole('button',{name:'Undo last change',exact:true}).click();output=(await state(page)).tasks.find(t=>t.id===output.id);assert.deepEqual(output.steps.map(s=>s.id),ids);
 await row.getByRole('button',{name:'Toggle steps for Update LinkedIn profile',exact:true}).filter({hasText:/1\/2 steps done/}).waitFor();await capture('task-structure-list.png');await page.getByRole('button',{name:'Edit task Update LinkedIn profile',exact:true}).click();await dialog.getByLabel('Search prerequisite tasks').scrollIntoViewIfNeeded();await capture('task-structure-editor.png');await page.getByRole('button',{name:'Close editor',exact:true}).click();
 await page.getByRole('button',{name:'Calendar view',exact:true}).click();await page.locator(`.all-day-chip[data-entry-type="deadline"][data-linked-task="${output.id}"]`).waitFor();
 saved=await state(page);await app.close();app=undefined;page=await launch();assert.deepEqual((await state(page)).tasks,saved.tasks);
 assert.deepEqual(errors,[]);const report={passed:true,dataDir,steps:true,prerequisites:true,softCompletion:true,filters:true,restart:true,undo:true};fs.writeFileSync(path.join(root,'test-results','task-structure-desktop-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
