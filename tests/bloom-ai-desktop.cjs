// Electron composer regression using real persisted action receipts, no model or microphone.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=process.env.MYMIND_BLOOM_EVIDENCE||path.join(root,'test-results',`bloom-ai-${Date.now()}`),data=path.join(out,'data');
fs.mkdirSync(data,{recursive:true});
const {PlannerDatabase}=require('../dist/main/database.js');
const db=new PlannerDatabase(path.join(data,'planner.sqlite'));
const request=randomUUID();db.beginChat({text:'Create two tasks',requestId:request});
const changes=['Card undo','Card conflict'].map(title=>({entity:'task',action:'create',id:randomUUID(),fields:{title,categoryId:null}}));
const day=new Date().toLocaleDateString('en-CA');changes.push({entity:'event',action:'create',id:randomUUID(),fields:{title:'Preview event',startDate:day,endDate:day,startTime:'10:00',endTime:'11:00',categoryId:null}});
changes[0].fields.dueDate=day;
const revision=db.revision,batch=db.previewBatch({changes,expectedRevision:revision});
db.applyBatch(batch,{draftId:randomUUID(),version:1,expectedRevision:revision,requestId:request},{chatRequestId:request,content:'Created both tasks.'});
db.mutate({changes:[{entity:'task',action:'update',id:changes[1].id,fields:{title:'Card conflict edited'}}],expectedRevision:db.revision,label:'Manual edit',requestId:randomUUID()});db.close();
const env={...process.env,MYMIND_DATA_DIR:data,MYMIND_TEST_MODE:'1',MYMIND_SKIP_OLLAMA:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app; (async()=>{try{
 app=await electron.launch({executablePath:require('electron'),args:['--force-device-scale-factor=1','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',root],env});const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const timer=setInterval(()=>{if(!w.isDestroyed())void w.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).catch(()=>{});},150);timer.unref();});page.setDefaultTimeout(15000);
 const resize=(w,h)=>app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[w,h]);
 await page.getByLabel('Message local assistant').waitFor();
 await app.evaluate(({ipcMain,BrowserWindow})=>{
  const status={state:'ready',message:'Local model ready',model:'first:latest',context:32768,gpu:'cpu'};
  globalThis.settingsProbe={model:status.model,context:status.context,activeContext:status.context,applied:null};
  ipcMain.removeHandler('assistant:settings');ipcMain.removeHandler('assistant:configure');
  ipcMain.handle('assistant:settings',()=>({...globalThis.settingsProbe,models:['first:latest','second:latest']}));
  ipcMain.handle('assistant:configure',(_event,selection)=>{
   Object.assign(globalThis.settingsProbe,selection,{activeContext:selection.context,applied:selection});
   BrowserWindow.getAllWindows()[0].webContents.send('assistant:status',{...status,...selection});
  });
  BrowserWindow.getAllWindows()[0].webContents.send('assistant:status',status);
 });
 for(const [w,h,name] of [[1440,900,'desktop'],[390,844,'mobile']]){await resize(w,h);await page.waitForTimeout(300);await page.screenshot({path:path.join(out,`${name}.png`)});assert.ok(await page.getByLabel('Message local assistant').isVisible());assert.ok(await page.getByRole('button',{name:'Settings',exact:true}).isVisible());}
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const settings=page.getByRole('dialog',{name:'Settings'});
 await settings.getByText('first:latest · 32,768 active tokens').waitFor();
 await settings.getByLabel('Ollama model').selectOption('second:latest');
 await settings.getByLabel('Context length',{exact:true}).press('ArrowRight');
 assert.equal(await settings.getByLabel('Context length',{exact:true}).getAttribute('aria-valuetext'),'65,536 tokens');
 await app.evaluate(()=>{globalThis.settingsProbe.activeContext=null;});
 await settings.getByRole('button',{name:'Refresh',exact:true}).click();
 await settings.getByText('Not loaded',{exact:true}).waitFor();
 assert.equal(await settings.getByLabel('Ollama model').inputValue(),'second:latest');
 await settings.getByRole('button',{name:'Apply and reload'}).click();
 await settings.getByText('second:latest · 65,536 active tokens').waitFor();
 assert.deepEqual(await app.evaluate(()=>globalThis.settingsProbe.applied),{model:'second:latest',context:65536});
 await page.screenshot({path:path.join(out,'settings.png')});
 assert.ok(await page.getByLabel('Edit before Send').isChecked());await page.getByLabel('Send on stop').check();assert.equal((await page.evaluate(()=>window.planner.snapshot())).preferences.voiceAutoSend,true);await page.keyboard.press('Escape');
 await resize(1440,900);await page.getByRole('button',{name:'Tasks',exact:true}).click();await page.getByRole('button',{name:'Open conversation'}).click();const card=page.locator('.bloom-action',{hasText:'Card undo'});await card.hover();await page.locator('.task-entry.bloom-preview-focus',{hasText:'Card undo'}).waitFor();await card.getByRole('button',{name:/Card undo/}).first().focus();assert.equal(await card.getByRole('button',{name:/Card undo/}).first().getAttribute('aria-expanded'),'true');
 await card.getByRole('button',{name:/Show Card undo on Calendar/}).hover();
 await page.locator('.all-day-chip.bloom-preview-focus',{hasText:'Card undo'}).waitFor();
 await card.locator('.bloom-action-title').hover();
 await page.locator('.task-entry.bloom-preview-focus',{hasText:'Card undo'}).waitFor();
 const before=(await page.evaluate(()=>window.planner.snapshot())).revision;await card.getByRole('button',{name:'Mark Card undo acknowledged'}).click();assert.equal((await page.evaluate(()=>window.planner.snapshot())).revision,before);
 await card.getByRole('button',{name:'Undo Card undo'}).click();await card.waitFor({state:'detached'});assert.ok(!(await page.evaluate(()=>window.planner.snapshot())).tasks.some(t=>t.title==='Card undo'));
 const conflict=page.locator('.bloom-action',{hasText:'Card conflict'});await page.keyboard.press('Tab');await conflict.getByRole('button',{name:/Card conflict/}).first().focus();await conflict.getByRole('button',{name:'Undo Card conflict'}).click();await conflict.getByRole('alert').waitFor();assert.ok(await conflict.getByRole('alert').isVisible());assert.ok(await conflict.isVisible());await page.keyboard.press('Escape');assert.equal(await conflict.getByRole('button',{name:/Card conflict/}).first().getAttribute('aria-expanded'),'false');
 await page.screenshot({path:path.join(out,'cards.png')});
 // Pointer exit clears preview even when the clicked control retains mouse focus.
 await conflict.getByRole('button',{name:/Card conflict/}).first().click();await page.mouse.move(100,100);await page.waitForFunction(()=>!document.querySelector('.task-entry.bloom-preview-focus'));
 await page.getByRole('button',{name:'Calendar',exact:true}).click();await resize(390,844);await page.getByRole('button',{name:'Open conversation'}).click();const eventCard=page.locator('.bloom-action',{hasText:'Preview event'});await eventCard.scrollIntoViewIfNeeded();await eventCard.getByRole('button',{name:/Preview event/}).first().click();const highlighted=page.locator('.event-block.bloom-preview-focus');await highlighted.waitFor();const highlightStyle=await highlighted.evaluate(e=>({outline:getComputedStyle(e).outlineStyle,translate:getComputedStyle(e).translate}));assert.equal(highlightStyle.outline,'dotted');assert.notEqual(highlightStyle.translate,'none');const bounds=await highlighted.boundingBox(),panel=await page.locator('.bloom-chat').boundingBox();assert.ok(bounds.y+bounds.height<=panel.y,`highlighted event overlaps chat: ${JSON.stringify({bounds,panel})}`);await page.screenshot({path:path.join(out,'mobile-preview.png')});await resize(1440,900);
 // Stop a pending request through the actual preload IPC bridge.
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('assistant:chat');ipcMain.removeHandler('assistant:cancel');globalThis.cancelProbe={calls:0,resolve:null};ipcMain.handle('assistant:chat',()=>new Promise(resolve=>{globalThis.cancelProbe.resolve=resolve;}));ipcMain.handle('assistant:cancel',()=>{globalThis.cancelProbe.calls++;globalThis.cancelProbe.resolve?.({content:'Cancelled'});});});
 await page.getByLabel('Message local assistant').fill('A slow request');await page.getByRole('button',{name:'Send message'}).click();await page.getByRole('button',{name:'Stop',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).waitFor({state:'detached'});assert.equal((await app.evaluate(()=>globalThis.cancelProbe.calls)),1);assert.equal(await page.getByLabel('Message local assistant').inputValue(),'A slow request');await page.getByLabel('Message local assistant').fill('');
 // Mock the speech and chat IPC boundaries while retaining real recording/draft persistence.
 await app.evaluate(({ipcMain})=>{globalThis.voiceCalls={transcribe:0,chat:0,final:false};for(const name of ['speech:start','speech:preview','dictation:transcribe','assistant:chat'])ipcMain.removeHandler(name);ipcMain.handle('speech:start',()=>({state:'ready',message:'Mock speech'}));ipcMain.handle('speech:preview',()=>({words:[]}));ipcMain.handle('dictation:transcribe',()=>{globalThis.voiceCalls.transcribe++;globalThis.voiceCalls.final=true;return {text:'Voice test command'};});ipcMain.handle('assistant:chat',()=>{globalThis.voiceCalls.chat++;return {content:'Mock response'};});const get=ipcMain._invokeHandlers.get('dictation:get');ipcMain.removeHandler('dictation:get');ipcMain.handle('dictation:get',async(...args)=>{const draft=await get(...args);return globalThis.voiceCalls.final?{...draft,reviewText:'Voice test command',finalText:'Voice test command'}:draft;});});
 await page.getByRole('button',{name:'Close conversation'}).click();await page.getByRole('button',{name:'Start dictation'}).click();await page.getByRole('button',{name:'Stop dictation'}).waitFor();await page.waitForTimeout(1200);await page.getByRole('button',{name:'Stop dictation'}).click();await page.waitForFunction(()=>window.planner.chatHistory().then(()=>true));await page.waitForTimeout(1000);const voice=await app.evaluate(()=>globalThis.voiceCalls);assert.equal(voice.transcribe,1);assert.equal(voice.chat,1);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Edit before Send').check();await page.keyboard.press('Escape');await app.evaluate(()=>{globalThis.voiceCalls.final=false;});await page.getByRole('button',{name:'Start dictation'}).click();await page.getByRole('button',{name:'Stop dictation'}).waitFor();await page.waitForTimeout(1200);await page.getByRole('button',{name:'Stop dictation'}).click();await page.getByRole('button',{name:'Start dictation'}).waitFor();assert.equal((await app.evaluate(()=>globalThis.voiceCalls)).chat,1);assert.equal(await page.getByLabel('Message local assistant').inputValue(),'Voice test command');await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('assistant:chat');ipcMain.handle('assistant:chat',()=>({content:'Runtime failed',status:'failed'}));});await page.getByRole('button',{name:'Send message'}).click();await page.getByText('Runtime failed').waitFor();assert.equal(await page.getByLabel('Message local assistant').inputValue(),'Voice test command');assert.ok((await page.evaluate(()=>window.planner.listDictations())).length>0);
 await app.close();app=undefined;app=await electron.launch({executablePath:require('electron'),args:[root],env});let reopened=await app.firstWindow();await reopened.getByLabel('Message local assistant').waitFor();assert.equal((await reopened.evaluate(()=>window.planner.chatHistory())).length,0);const fixture=new PlannerDatabase(path.join(data,'planner.sqlite'));fixture.beginChat({text:'Interrupted voice test',requestId:'crash-test'});fixture.close();const pid=await app.evaluate(()=>process.pid),closed=app.waitForEvent('close');process.kill(pid,'SIGKILL');await closed;app=undefined;app=await electron.launch({executablePath:require('electron'),args:[root],env});reopened=await app.firstWindow();await reopened.getByLabel('Message local assistant').waitFor();assert.ok((await reopened.evaluate(()=>window.planner.chatHistory())).some(m=>/interrupted/i.test(m.content)));
 console.log('PASS Bloom composer settings, card acknowledgement, undo, conflict, and desktop/mobile layout');
 }finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
