const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { todayIn, shiftDate } = require('../dist/shared/dates');
const root=path.resolve(__dirname,'..'),today=todayIn();
const dataDir=path.join(root,'test-results',`desktop-${Date.now()}`);
const env={...process.env,MYMIND_DATA_DIR:dataDir,MYMIND_SKIP_OLLAMA:'1',MYMIND_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app;
async function state(page){return page.evaluate(()=>window.planner.snapshot());}
async function seed(page,changes){const snapshot=await state(page);return page.evaluate(input=>window.planner.mutate(input),{changes,label:'UI verification fixtures',expectedRevision:snapshot.revision,requestId:crypto.randomUUID()});}
async function launch(){app=await electron.launch({args:[root],env,timeout:30000});const page=await app.firstWindow();await page.getByRole('heading',{name:'Your calendar.'}).waitFor();return page;}
(async()=>{
  try{
    let page=await launch();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    assert.equal((await state(page)).events.length,0);
    await page.getByRole('button',{name:'New event',exact:true}).click();
    await page.getByLabel('Title',{exact:true}).fill('Design review');
    await page.getByLabel('Start date',{exact:true}).fill(today);
    await page.getByLabel('End date',{exact:true}).fill(shiftDate(today,2));
    await page.getByLabel('Add a time',{exact:true}).check();
    await page.getByLabel('Start time',{exact:true}).fill('10:00');
    await page.getByRole('button',{name:'sky color'}).click();
    await page.getByRole('button',{name:'Add event',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    let snapshot=await state(page);assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].endDate,shiftDate(today,2));assert.equal(snapshot.events[0].startTime,'10:00');
    await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('VIP project');await page.getByRole('button',{name:'Add project',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Add section to VIP project',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Prototype');await page.getByRole('button',{name:'Add section',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'New task',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Cornhole');
    snapshot=await state(page);const vip=snapshot.projects.find(p=>p.title==='VIP project'),prototype=snapshot.sections[0];
    await page.getByLabel('Project',{exact:true}).selectOption(vip.id);await page.getByLabel('Section',{exact:true}).selectOption(prototype.id);await page.getByLabel(/Due date/).fill(today);await page.getByRole('dialog').getByRole('button',{name:'Add task',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    snapshot=await state(page);assert.equal(snapshot.tasks.length,1);assert.equal(snapshot.tasks[0].projectId,vip.id);
    await page.getByRole('button',{name:'Complete Cornhole in calendar',exact:true}).click();await page.getByRole('button',{name:'Reopen Cornhole in calendar',exact:true}).waitFor();assert.equal((await state(page)).tasks[0].completed,true);
    await page.locator('.task-pane .undo-button').click();await page.getByRole('button',{name:'Complete Cornhole in calendar',exact:true}).waitFor();assert.equal((await state(page)).tasks[0].completed,false);
    // Drag a continuation card by two days; preserve the entire event duration.
    const anchor=shiftDate(today,1),target=shiftDate(today,3);
    const source=page.locator(`[data-date="${anchor}"] .event-card`).first(),destination=page.locator(`[data-date="${target}"]`);
    await source.dragTo(destination);await page.waitForFunction(date=>window.planner.snapshot().then(s=>s.events[0].startDate===date),shiftDate(today,2));
    await page.locator('.task-pane .undo-button').click();await page.waitForFunction(date=>window.planner.snapshot().then(s=>s.events[0].startDate===date),today);
    await seed(page,[{action:'create',entity:'event',fields:{title:'Exam',startDate:shiftDate(today,4),color:'lavender'}},{action:'create',entity:'event',fields:{title:'Workshop',startDate:shiftDate(today,-2),color:'amber'}},{action:'create',entity:'event',fields:{title:'School trip',startDate:shiftDate(today,1),color:'sage'}},{action:'create',entity:'task',fields:{title:'Get a packaging quote',dueDate:shiftDate(today,1),projectId:vip.id,color:'coral'}},{action:'create',entity:'task',fields:{title:'Walls',projectId:vip.id,sectionId:prototype.id}},{action:'create',entity:'task',fields:{title:'Create Instagram',projectId:vip.id}},{action:'create',entity:'task',fields:{title:'Pick up materials',dueDate:shiftDate(today,-1),color:'amber'}}]);
    await page.getByRole('button',{name:'Today',exact:true}).first().click();
    await page.waitForTimeout(700);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','desktop.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,800));await page.waitForTimeout(200);await page.screenshot({path:path.join(root,'test-results','desktop-1280.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Fit month',exact:true}).click();
    await page.waitForTimeout(200);assert.equal(await page.getByTestId('calendar').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.getByLabel('Calendar zoom').fill('132');
    await page.locator('.task-tabs button').filter({hasText:'Today'}).click();await page.getByRole('heading',{name:/Overdue/}).waitFor();
    await page.locator('.task-tabs button').filter({hasText:'All tasks'}).click();
    await page.getByRole('button',{name:'Edit section Prototype',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal((await state(page)).tasks.find(t=>t.title==='Cornhole').projectId,'inbox');
    await page.locator('.task-pane .undo-button').click();assert.equal((await state(page)).tasks.find(t=>t.title==='Cornhole').sectionId,prototype.id);
    const saved=await state(page);await app.close();app=undefined;page=await launch();const reopened=await state(page);assert.deepEqual(reopened.events,saved.events);assert.deepEqual(reopened.tasks,saved.tasks);
    await page.getByRole('button',{name:'Next year',exact:true}).click();assert.equal(await page.getByTestId('calendar-year').textContent(),String(Number(today.slice(0,4))+1));
    await page.getByRole('button',{name:'Today',exact:true}).first().click();assert.equal(await page.getByTestId('calendar-year').textContent(),today.slice(0,4));
    await page.getByRole('button',{name:/A little help/}).click();await page.getByLabel('Message local assistant').waitFor();
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,events:reopened.events.length,tasks:reopened.tasks.length,dataDir,screenshots:['test-results/desktop.png','test-results/desktop-1280.png']},null,2));
  }finally{if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
