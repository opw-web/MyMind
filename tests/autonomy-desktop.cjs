const {_electron:electron}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {todayIn,shiftDate}=require('../dist/shared/dates');const request=require('./autonomy-example.cjs'),root=path.resolve(__dirname,'..');
const executable=process.env.MYMIND_TEST_EXECUTABLE||path.join(process.env.LOCALAPPDATA,'Programs','MYMIND','MYMIND.exe');
const env={...process.env,MYMIND_TEST_MODE:'1',MYMIND_DATA_DIR:path.join(root,'test-results',`autonomy-installed-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;delete env.MYMIND_SKIP_OLLAMA;
let app;
(async()=>{try{
 app=await electron.launch({executablePath:executable,args:[],env,timeout:30000});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByTestId('calendar').waitFor();
 const started=Date.now();while(true){const s=await page.evaluate(()=>window.planner.status());if(s.state==='error')throw new Error(s.message);if(s.state==='ready')break;if(Date.now()-started>240000)throw new Error('The installed model did not become ready.');await page.waitForTimeout(200);}
 await page.getByRole('button',{name:'Show conversation'}).click({timeout:1500}).catch(()=>{});
 console.log(JSON.stringify({stage:'ready',runtime:await page.locator('.runtime-line').innerText(),status:(await page.evaluate(()=>window.planner.status())).state}));
 await page.getByText('Local assistant',{exact:true}).waitFor({timeout:30000});
 await page.getByLabel('Message local assistant').fill(request);
 console.log(JSON.stringify({stage:'filled',characters:(await page.getByLabel('Message local assistant').inputValue()).length,sendEnabled:await page.getByRole('button',{name:'Send message',exact:true}).isEnabled()}));
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await page.getByRole('region',{name:'Review proposed changes'}).waitFor({timeout:240000});
 await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
 assert.equal((await page.evaluate(()=>window.planner.snapshot())).tasks.length,0);
 if(await page.getByRole('button',{name:'Hide conversation',exact:true}).count())await page.getByRole('button',{name:'Hide conversation',exact:true}).last().click();
 await page.getByRole('button',{name:'Apply',exact:true}).click();
 await page.waitForFunction(()=>window.planner.snapshot().then(snapshot=>snapshot.revision===1));
 const state=await page.evaluate(()=>window.planner.snapshot());assert.equal(state.tasks.length,5,JSON.stringify(state.tasks.map(t=>t.title)));assert.equal(state.events.length,0);assert.ok(state.tasks.every(t=>t.scheduledDate===null&&t.dueDate===shiftDate(todayIn(),7)));assert.ok(state.tasks.some(t=>/portfolio/i.test(t.title)&&/refresh|update|revise/i.test(t.title)));
 const reply=await page.locator('.chat-message.assistant').last().innerText();assert.doesNotMatch(reply,/would you like|before committing|should i (?:add|proceed)/i);
 await page.getByRole('button',{name:'Undo last change',exact:true}).click();
 const undoStarted=Date.now();while((await page.evaluate(()=>window.planner.snapshot())).tasks.length){if(Date.now()-undoStarted>30000)throw new Error('Undo did not restore the fixture.');await page.waitForTimeout(100);}assert.deepEqual(errors,[]);
 const report={passed:true,executable,version:await app.evaluate(({app})=>app.getVersion()),context:(await page.evaluate(()=>window.planner.status())).context,tasksSaved:5,calendarEvents:0,deadlineOnly:true,confirmationRequired:false,undoPassed:true,dataDir:env.MYMIND_DATA_DIR};fs.writeFileSync(path.join(root,'test-results','autonomy-installed-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
