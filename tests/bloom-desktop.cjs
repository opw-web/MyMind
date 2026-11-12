// Bloom UI regression: real Electron and SQLite, no local model. Covers shell, calendar, tasks, composer, dialogs and layout.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const out=process.env.MYMIND_BLOOM_EVIDENCE||path.join(root,'test-results',`bloom-${Date.now()}`);
const dataDir=path.join(out,`data-${Date.now()}`),env={...process.env,MYMIND_DATA_DIR:dataDir,MYMIND_TEST_MODE:'1',MYMIND_SKIP_OLLAMA:'1'};delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(out,{recursive:true});
let app,page;const errors=[],checks=[];
const snap=()=>page.evaluate(()=>window.planner.snapshot());
const button=name=>page.getByRole('button',{name,exact:true});
const size=(w,h)=>app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setSize(w,h),[w,h]);
const noOverflow=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.body.scrollHeight<=innerHeight+1);
async function check(name,run){try{await run();}catch(e){await shot('fail-'+name.slice(0,20).replace(/W+/g,'-')).catch(()=>{});throw e;}checks.push(name);console.log('PASS '+name);}
async function shot(name){await page.screenshot({path:path.join(out,name+'.png')});}
async function seed(changes){const s=await snap();await page.evaluate(([revision,changes])=>window.planner.mutate({changes,label:'seed',expectedRevision:revision,requestId:crypto.randomUUID()}),[s.revision,changes]);await page.waitForTimeout(400);}
(async()=>{try{
  app=await electron.launch({executablePath:process.env.MYMIND_TEST_EXECUTABLE||require('electron'),args:['--force-device-scale-factor=1',...(process.env.MYMIND_TEST_EXECUTABLE?[]:[root])],env});
  page=await app.firstWindow();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const timer=setInterval(()=>{if(!w.isDestroyed())void w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>{});},150);timer.unref();});
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await size(1280,800);await page.getByTestId('calendar').waitFor();
  const today=await page.evaluate(()=>window.planner.snapshot().then(s=>new Intl.DateTimeFormat('en-CA',{timeZone:s.preferences.timezone}).format(new Date())));
  const categoryId=(await snap()).categories[0]?.id;
  await seed([
    {action:'create',entity:'event',fields:{title:'Team sync',startDate:today,endDate:today,startTime:'10:00',endTime:'11:00',notes:'',color:'lavender'}},
    {action:'create',entity:'event',fields:{title:'Deep work',startDate:today,endDate:today,startTime:'10:30',endTime:'12:00',notes:'',color:'sage',...(categoryId?{categoryId}:{})}},
    {action:'create',entity:'event',fields:{title:'Conference trip',startDate:today,endDate:today,notes:'',color:'coral'}},
    {action:'create',entity:'task',fields:{title:'Write proposal',notes:'',projectId:'inbox',dueDate:today,steps:[{id:crypto.randomUUID(),title:'Outline',completed:false},{id:crypto.randomUUID(),title:'Draft',completed:false}]}}
  ]);

  await check('Shell shows Bloom sidebar and Calendar is current',async()=>{
    assert.equal(await button('Calendar view').getAttribute('aria-current'),'page');
    assert.equal(await button('Tasks view').getAttribute('aria-current'),null);
    assert.ok(await page.locator('.sidebar').isVisible());
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor!==''&&getComputedStyle(document.querySelector('.app-shell')).backgroundColor),'rgb(255, 248, 240)');
    assert.ok((await page.evaluate(()=>getComputedStyle(document.querySelector('.title-wrap h1')).fontFamily)).includes('Bloom Pixel'));
  });

  await check('Hour grid starts at today with seven readable days',async()=>{
    await page.locator('.day-header.is-today').waitFor();
    const left=await page.locator('.day-header.is-today').evaluate(e=>e.getBoundingClientRect().left),gutter=await page.locator('.corner-label').evaluate(e=>e.getBoundingClientRect().right);
    assert.ok(Math.abs(left-gutter)<=2,'today is the leftmost day');
    const widths=await page.locator('.day-header').evaluateAll(n=>n.slice(0,7).map(e=>Math.round(e.getBoundingClientRect().width)));
    assert.ok(widths.every(w=>w>=148));
    assert.ok(await page.locator('.weekday').first().isVisible());
    assert.match(await page.getByTestId('calendar-year').innerText(),/\d{4}/);
  });

  await check('Timed events share columns, all-day events sit in the all-day row',async()=>{
    const sync=page.locator('.event-block',{hasText:'Team sync'}),deep=page.locator('.event-block',{hasText:'Deep work'});
    await sync.waitFor();await deep.waitFor();
    const a=await sync.boundingBox(),b=await deep.boundingBox();
    assert.ok(a.x+a.width<=b.x+1||b.x+b.width<=a.x+1,'overlapping events sit side by side');
    assert.ok(await page.locator('.all-day-cell .event-card',{hasText:'Conference trip'}).isVisible());
    assert.ok(await page.locator('.now-line').count()>=1);
  });

  await check('Standalone events omit completion; linked work uses its task completion',async()=>{
    assert.equal(await button('Complete Team sync in calendar').count(),0);
    const task=(await snap()).tasks.find(t=>t.title==='Write proposal');
    await seed([{action:'update',entity:'event',id:(await snap()).events.find(e=>e.title==='Team sync').id,fields:{linkedTaskId:task.id}}]);
    await page.locator('.event-block',{hasText:'Team sync'}).hover();await button('Complete Team sync in calendar').click();
    await page.waitForFunction(()=>window.planner.snapshot().then(s=>s.tasks.find(t=>t.title==='Write proposal').completed));
    await button('Reopen Team sync in calendar').click();
  });

  await check('New event dialog saves to the planner',async()=>{
    await button('New event').click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Title').fill('Bloom lunch');await dialog.getByRole('button',{name:'Add event'}).click();
    await page.waitForFunction(()=>window.planner.snapshot().then(s=>s.events.some(e=>e.title==='Bloom lunch')));
  });

  await check('Dragging across a day column opens a timed event',async()=>{
    await button('Today').click();await page.waitForTimeout(900);await page.locator('.calendar-panel').evaluate(e=>{e.scrollTop=800;});
    const column=page.locator('.time-column.time-today'),box=await column.boundingBox();
    const y=await page.evaluate(()=>document.querySelector('.time-column.time-today').getBoundingClientRect().top);
    await page.mouse.move(box.x+box.width/2,y+14*66+5);await page.mouse.down();await page.mouse.move(box.x+box.width/2,y+15*66+5,{steps:6});await page.mouse.up();
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Start time').inputValue(),'14:00');
    await dialog.getByRole('button',{name:'Close editor'}).click();
  });

  await check('Calendars popover hides a category from the grid',async()=>{
    if(!categoryId)return;
    await button('Calendars').click();
    const popover=page.locator('.category-popover');await popover.waitFor();
    const name=(await snap()).categories[0].title;
    await popover.getByRole('checkbox').first().uncheck();
    await page.locator('.event-block',{hasText:'Deep work'}).waitFor({state:'detached'});
    await popover.getByRole('checkbox').first().check();
    await page.locator('.event-block',{hasText:'Deep work'}).waitFor();
    await page.keyboard.press('Escape');await popover.waitFor({state:'detached'});
    assert.ok(name);
  });

  await check('Day header opens the agenda dialog',async()=>{
    await page.locator('.day-header.is-today').click();
    const dialog=page.getByRole('dialog');await dialog.getByText('Team sync').waitFor();
    await dialog.getByRole('button',{name:'Close agenda'}).click();
  });

  await check('Tasks screen shows project panels, steps and completion',async()=>{
    await button('Tasks view').click();
    await page.locator('.task-title-button',{hasText:'Write proposal'}).waitFor();
    assert.ok(await page.locator('.project-panel').first().isVisible());
    await page.getByLabel('Complete step Outline').filter({visible:true}).check();
    await page.waitForFunction(()=>window.planner.snapshot().then(s=>s.tasks.find(t=>t.title==='Write proposal').steps[0].completed));
    await button('Complete Write proposal').click();
    await page.waitForFunction(()=>window.planner.snapshot().then(s=>s.tasks.find(t=>t.title==='Write proposal').completed));
    await button('Archived').click();await button('All').click();
    assert.ok((await page.locator('.mini-progress').count())>=1);
  });

  await check('New task dialog and flowchart toggle work',async()=>{
    await button('New task').click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Title').fill('Plan trip');await dialog.getByRole('button',{name:'Add task'}).click();
    await page.waitForFunction(()=>window.planner.snapshot().then(s=>s.tasks.some(t=>t.title==='Plan trip')));
    await button('Flowchart').click();await page.getByLabel('Task flowchart',{exact:true}).waitFor();
    await button('Checklist').click();
  });

  await check('Composer opens a conversation sheet and keeps the planner reachable',async()=>{
    assert.ok(await page.getByLabel('Message local assistant').isVisible());
    await button('Show conversation').click();
    const sheet=page.locator('.chat-sheet');await sheet.waitFor();
    assert.ok(await sheet.getByText('TRY A COMMAND').isVisible());
    await sheet.getByRole('button',{name:'What do I need to do today?'}).click();
    assert.equal(await page.getByLabel('Message local assistant').inputValue(),'What do I need to do today?');
    await button('Hide conversation').first().click();await sheet.waitFor({state:'detached'});
    await page.getByLabel('Message local assistant').fill('');
  });

  await check('Settings open as a dialog',async()=>{
    await button('Assistant settings').click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Ollama model').waitFor();
    await shot('settings');
    await button('Close settings').click();await dialog.waitFor({state:'detached'});
  });

  await check('No horizontal overflow and reachable composer at common sizes',async()=>{
    for(const view of ['Calendar view','Tasks view'])for(const [w,h] of [[1440,900],[1280,800],[1000,650],[800,600]]){
      await button(view).click();await size(w,h);await page.waitForTimeout(250);
      assert.equal(await noOverflow(),true,`${view} overflows at ${w}x${h}`);
      const rect=await page.getByLabel('Message local assistant').evaluate(e=>e.getBoundingClientRect().toJSON());
      assert.ok(rect.bottom<=h&&rect.top>=0,`composer reachable at ${w}x${h}`);
    }
    await size(1280,800);await button('Calendar view').click();await shot('calendar-final');
  });

  assert.deepEqual(errors.filter(e=>!/ResizeObserver|Autofill/.test(e)),[]);
  fs.writeFileSync(path.join(out,'bloom-report.json'),JSON.stringify({passed:true,checks},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length}));
}finally{await app?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
