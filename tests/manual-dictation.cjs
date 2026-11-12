const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),env={...process.env,MYMIND_TEST_MODE:'1',MYMIND_SKIP_OLLAMA:'1',MYMIND_DATA_DIR:path.join(root,'test-results',`live-ui-${Date.now()}`)};
delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.MYMIND_TEST_EXECUTABLE||require('electron'),args=process.env.MYMIND_TEST_EXECUTABLE?[]:[root];let app,page;
const checks=[],errors=[];
async function launch(){
 app=await electron.launch({executablePath:executable,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',...args],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByTestId('calendar').waitFor();
 await app.evaluate(({ipcMain,BrowserWindow})=>{
  const test={requests:[],previews:[],cancellations:[],chat:[],mode:'normal',failSave:false,held:new Map()};globalThis.voiceTest=test;
  const get=ipcMain._invokeHandlers.get('dictation:get'),checkpoint=ipcMain._invokeHandlers.get('dictation:checkpoint'),append=ipcMain._invokeHandlers.get('dictation:append');
  for(const name of ['assistant:status','speech:start','speech:preview','speech:cancel','dictation:transcribe','dictation:append','assistant:chat'])ipcMain.removeHandler(name);
  ipcMain.handle('assistant:status',()=>({state:'ready',model:'UI test',context:8192,gpu:'cpu',message:'UI test'}));
  ipcMain.handle('speech:start',()=>({state:'ready',message:'UI test'}));
  ipcMain.handle('dictation:append',(event,input)=>{if(test.failSave)throw new Error('Synthetic disk failure');return append(event,input);});
  ipcMain.handle('speech:preview',(_event,input)=>{test.previews.push({id:input.draftId,offset:input.offset,sequence:input.sequence});return {words:[{text:'Opening',start:0,end:.8},{text:'live',start:.8,end:1.2},{text:'words.',start:1.2,end:1.8}]};});
  ipcMain.handle('dictation:transcribe',async(event,input)=>{
   test.requests.push(input);
   if(test.mode==='fail'){test.mode='normal';throw new Error('Synthetic transcription failure');}
   if(test.mode==='empty')return {text:'',confidence:0};
   if(test.mode==='hold'){BrowserWindow.getAllWindows()[0].webContents.send('speech:progress',{...input,text:'Final text in progress',seconds:5});return new Promise(resolve=>test.held.set(input.requestId,resolve));}
   const draft=await get(event,input.draftId),unedited=draft.reviewText.trim()===[draft.prefix.trim(),draft.liveText.trim()].filter(Boolean).join(' ');
   if(unedited)await checkpoint(event,{draftId:draft.id,generation:draft.generation,reviewText:[draft.prefix,'A complete transcript.'].filter(Boolean).join(' ')});
   return {text:'A complete transcript.',confidence:.9};
  });
  ipcMain.handle('speech:cancel',(_event,id)=>{test.cancellations.push(id);test.held.get(id)?.({text:'Late cancelled transcript.'});test.held.delete(id);});
  ipcMain.handle('assistant:chat',(_event,input)=>{test.chat.push(input);if(test.mode==='rejectChat'){test.mode='normal';throw new Error('Please split this message.');}return {content:'Test reply.'};});
 });
 await page.reload();await page.getByRole('button',{name:'Show conversation'}).click({timeout:1500}).catch(()=>{});return page;
}
const input=()=>page.getByLabel('Message local assistant');
const probe=()=>app.evaluate(()=>({requests:voiceTest.requests,previews:voiceTest.previews,chat:voiceTest.chat}));
const mode=value=>app.evaluate((_api,value)=>{voiceTest.mode=value;},value);
async function start(){await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByLabel('Recording duration').waitFor();}
async function stop(){await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor();}
async function newChat(){await page.getByRole('button',{name:'New chat',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#assistant-input').value);}
(async()=>{try{
 await launch();await input().fill('Typed prefix');await start();await page.waitForFunction(()=>document.querySelector('#assistant-input').value.includes('Opening live words'));
 assert.equal((await probe()).requests.length,0);assert.equal((await probe()).chat.length,0);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('button',{name:'Tasks view',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();await page.getByRole('button',{name:'Show conversation'}).click({timeout:1500}).catch(()=>{});
 assert.match(await input().inputValue(),/Typed prefix Opening/);await page.evaluate(()=>{document.querySelector('.mic-button').click();document.querySelector('.mic-button').click();});await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor();
 assert.equal((await probe()).requests.length,1);assert.equal((await probe()).chat.length,0);assert.equal(await input().inputValue(),'Typed prefix A complete transcript.');checks.push('Live text, focus changes, layout changes, repeated Stop, and explicit review');
 await newChat();await mode('empty');await start();await page.waitForFunction(()=>document.querySelector('#assistant-input').value.includes('Opening'));await stop();assert.match(await input().inputValue(),/Opening live words/);assert.ok((await page.evaluate(()=>window.planner.listDictations())).some(d=>d.bytes&&d.liveText));checks.push('Empty final result retains live text and audio');
 await mode('fail');await page.getByRole('button',{name:'Retry transcription',exact:true}).click();await page.getByText(/Synthetic transcription failure/).waitFor();await input().fill('My edited transcript stays intact');await page.getByRole('button',{name:'Retry transcription',exact:true}).click();await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor();assert.equal(await input().inputValue(),'My edited transcript stays intact');const attempts=(await probe()).requests;assert.equal(attempts.at(-1).draftId,attempts.at(-2).draftId);checks.push('Retry reuses audio and preserves review edits');
 await newChat();await mode('hold');await start();await page.waitForTimeout(400);await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await page.getByText(/Final transcription progress/).waitFor();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor();assert.doesNotMatch(await input().inputValue(),/Late cancelled/);checks.push('Final progress and cancellation reject late results');
 await mode('hold');await page.getByRole('button',{name:'Retry transcription',exact:true}).click();await page.getByRole('button',{name:'Cancel dictation',exact:true}).waitFor();await newChat();assert.equal(await input().inputValue(),'');assert.doesNotMatch(await input().inputValue(),/Late cancelled/);checks.push('New chat detaches and preserves the old draft');
 await mode('normal');await page.evaluate(()=>{const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.releaseMic=()=>{};navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.releaseMic=async()=>{const stream=await get({audio:true});window.lateTracks=stream.getTracks();resolve(stream);};});window.originalMic=get;});
 await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();await page.evaluate(async()=>{await window.releaseMic();navigator.mediaDevices.getUserMedia=window.originalMic;});await page.waitForFunction(()=>window.lateTracks?.every(t=>t.readyState==='ended'));checks.push('Cancel during microphone startup releases late devices');
 await newChat();await app.evaluate(()=>{voiceTest.failSave=true;});await start();await page.getByText(/Synthetic disk failure/).waitFor();await page.getByRole('button',{name:'Retry transcription',exact:true}).waitFor();await app.evaluate(()=>{voiceTest.failSave=false;});await page.getByRole('button',{name:'Retry transcription',exact:true}).click();await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor();assert.ok((await page.evaluate(()=>window.planner.listDictations())).some(d=>d.bytes));checks.push('Disk failure retains unsaved chunks for retry');
 await input().fill('More than 4000 characters. '+'A long editable thought. '.repeat(190));await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Test reply.',{exact:true}).waitFor();assert.ok((await probe()).chat.at(-1).text.length>4000);
 const oversized='Large thought. '.repeat(6500),before=(await probe()).chat.length;await input().fill(oversized);await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText(/This message is too long/).waitFor();assert.equal(await input().inputValue(),oversized);assert.equal((await probe()).chat.length,before);
 await mode('rejectChat');await input().fill('Backend rejection stays editable');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText('Please split this message.',{exact:true}).waitFor();assert.equal(await input().inputValue(),'Backend rejection stays editable');checks.push('Long messages and rejected Send retain complete drafts');
 await newChat();await start();await page.waitForFunction(()=>document.querySelector('#assistant-input').value.includes('Opening'));const beforeQuit=await page.evaluate(()=>window.planner.listDictations());await app.close();app=undefined;
 await launch();const saved=await page.evaluate(()=>window.planner.listDictations());assert.ok(saved.length>=beforeQuit.length);const last=saved[0];assert.ok(last.bytes>0);assert.match(last.liveText,/Opening live words/);await page.getByText(/saved dictations available/).waitFor();await page.evaluate(async id=>{await window.planner.getDictation(id);},last.id);checks.push('Normal quit flushes audio and restart exposes recoverable drafts');
 await start();await page.waitForTimeout(2400);const committed=await page.evaluate(()=>window.planner.listDictations());const pid=await app.evaluate(()=>process.pid),closed=app.waitForEvent('close');process.kill(pid,'SIGKILL');await closed;app=undefined;
 await launch();const recovered=await page.evaluate(()=>window.planner.listDictations());assert.equal(recovered[0].id,committed[0].id);assert.ok(recovered[0].bytes>=committed[0].bytes);checks.push('Forced termination preserves committed audio and transcript');
 const report={passed:true,checks,dataDir:env.MYMIND_DATA_DIR,executable,errors};assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'test-results','manual-dictation-ui-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
