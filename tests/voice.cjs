const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {wavData}=require('./audio.cjs');
const root=path.resolve(__dirname,'..'),fixture=path.join(root,'test-results','voice-long.wav'),duration=wavData(fixture).seconds;
const env={...process.env,MYMIND_DATA_DIR:path.join(root,'test-results',`voice-${Date.now()}`),MYMIND_TEST_MODE:'1'};
delete env.ELECTRON_RUN_AS_NODE;if(process.env.MYMIND_VOICE_UI_ONLY==='1')env.MYMIND_SKIP_OLLAMA='1';
const executable=process.env.MYMIND_TEST_EXECUTABLE||require('electron'),appArgs=process.env.MYMIND_TEST_EXECUTABLE?[]:[root];let app;
(async()=>{try{
  app=await electron.launch({executablePath:executable,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`,...appArgs],env,timeout:30000});
  const page=await app.firstWindow();await page.getByTestId('calendar').waitFor();
  await app.evaluate(({ipcMain})=>{
    const original=ipcMain._invokeHandlers.get('dictation:transcribe');ipcMain.removeHandler('dictation:transcribe');
    globalThis.voiceProbe={calls:0,previewTimes:[],firstWordsAt:undefined};
    const preview=ipcMain._invokeHandlers.get('speech:preview');ipcMain.removeHandler('speech:preview');ipcMain.handle('speech:preview',async(event,input)=>{const started=Date.now(),result=await preview(event,input);if(result.words.length){globalThis.voiceProbe.firstWordsAt??=Date.now();globalThis.voiceProbe.previewTimes.push(Date.now()-started);}return result;});
    ipcMain.handle('dictation:transcribe',(event,input)=>{globalThis.voiceProbe.calls++;return original(event,input);});
  });
  await page.getByRole('button',{name:'Show conversation'}).click({timeout:1500}).catch(()=>{});
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByLabel('Recording duration').waitFor();
  const captureStarted=Date.now();
  await page.waitForTimeout(11000);assert.equal(await app.evaluate(()=>globalThis.voiceProbe.calls),0);assert.equal(await page.getByLabel('Message local assistant').inputValue(),'');
  await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();console.log('Initial silence does not stop recording.');
  await page.screenshot({path:path.join(root,'test-results','manual-recording.png')});
  await page.waitForTimeout(40000);assert.match(await page.getByLabel('Message local assistant').inputValue(),/exam.*Friday/i);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('button',{name:'Tasks view',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();await page.getByRole('button',{name:'Show conversation'}).click({timeout:1500}).catch(()=>{});await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();assert.equal(await app.evaluate(()=>globalThis.voiceProbe.calls),0);
  console.log('Recording continues past 45 seconds and through a long pause.');
  await page.waitForTimeout(Math.max(0,duration*1000+500-(Date.now()-captureStarted)));
  await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
  await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor({timeout:180000});
  const final=await page.getByLabel('Message local assistant').inputValue();
  assert.match(final,/exam.*Friday/i);assert.match(final,/buy notebooks/i);assert.equal(await app.evaluate(()=>globalThis.voiceProbe.calls),1);
  assert.equal(await page.locator('.chat-message').count(),0);console.log(JSON.stringify({durationSeconds:duration,final}));
  if(process.env.MYMIND_VOICE_UI_ONLY!=='1'){
    await page.waitForFunction(()=>window.planner.status().then(status=>status.state==='ready'),{},{timeout:180000});
    // Review and edit the captured multi-sentence draft before submitting one clear action.
    await page.getByLabel('Message local assistant').fill('Add an exam next Friday');
    await page.getByRole('button',{name:'Send message',exact:true}).click();await page.locator('.chat-message.assistant').filter({hasText:'Added event: Exam'}).waitFor({timeout:120000});
    assert.equal((await page.evaluate(()=>window.planner.snapshot())).events.length,1);
    await page.getByLabel('Message local assistant').focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>window.planner.snapshot().then(state=>state.events.length===0));
  }
  const speech=await page.evaluate(()=>window.planner.startSpeech());
  await page.getByLabel('Message local assistant').fill('Keep this typed prefix');
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();
  assert.equal(await page.getByLabel('Message local assistant').inputValue(),'Keep this typed prefix');assert.equal((await page.evaluate(()=>window.planner.startSpeech())).pid,speech.pid);
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByLabel('Recording duration').waitFor();
  await page.getByRole('button',{name:'New chat',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#assistant-input').value==='');
  const ollama=await page.evaluate(()=>window.planner.status()),metrics=await app.evaluate(()=>globalThis.voiceProbe);await app.close();app=undefined;await new Promise(resolve=>setTimeout(resolve,300));
  for(const pid of [speech.pid,ollama.pid].filter(Boolean)){let alive=false;try{process.kill(pid,0);alive=true;}catch{}assert.equal(alive,false);}
  const report={passed:true,durationSeconds:duration,final,transcriptionsBeforeStop:0,liveTextBeforeStop:true,backgroundRecordingPassed:true,firstCaptionSeconds:(metrics.firstWordsAt-captureStarted)/1000,initialSilenceSeconds:12,nonemptyPreviewTimesMs:metrics.previewTimes,transcriptionsAfterStop:1,workerReused:true,speechPid:speech.pid,ollamaPid:ollama.pid};
  fs.writeFileSync(path.join(root,'test-results','voice-report.json'),JSON.stringify(report,null,2));console.log('Manual long dictation, review, cancellation, and worker cleanup passed.');
}catch(error){if(app){try{const page=await app.firstWindow();console.log({speech:await page.evaluate(()=>window.planner.speechStatus()),caption:await page.locator('.dictation-strip').innerText()});}catch{}}throw error;}finally{if(app)await app.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
