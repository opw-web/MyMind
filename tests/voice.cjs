const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'..'),fixture=path.join(root,'test-results','voice-command.wav');
const env={...process.env,MYMIND_DATA_DIR:path.join(root,'test-results',`voice-${Date.now()}`),MYMIND_TEST_MODE:'1'};delete env.ELECTRON_RUN_AS_NODE;if(process.env.MYMIND_VOICE_UI_ONLY==='1')env.MYMIND_SKIP_OLLAMA='1';
const executable=process.env.MYMIND_TEST_EXECUTABLE||require('electron'),appArgs=process.env.MYMIND_TEST_EXECUTABLE?[]:[root];let app;
(async()=>{try{
  app=await electron.launch({executablePath:executable,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${fixture}`,...appArgs],env,timeout:30000});
  const page=await app.firstWindow();await page.getByRole('heading',{name:'Your calendar.'}).waitFor();
  await page.getByRole('button',{name:/A little help/}).click();
  await page.getByLabel('Send after a pause').uncheck();
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();
  await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();
  await page.waitForFunction(()=>/exam/i.test(document.querySelector('#assistant-input').value),{},{timeout:60000});
  const live=await page.getByLabel('Message local assistant').inputValue();console.log(JSON.stringify({live}));assert.match(live,/exam/i);
  await page.getByRole('button',{name:'Start dictation',exact:true}).waitFor({timeout:60000});
  const final=await page.getByLabel('Message local assistant').inputValue();assert.match(final,/exam.*(?:next )?Friday/i);console.log(JSON.stringify({final,speech:await page.evaluate(()=>window.planner.speechStatus())}));
  await page.screenshot({path:path.join(root,'test-results','voice.png')});
  if(process.env.MYMIND_VOICE_UI_ONLY!=='1'){
    await page.waitForFunction(()=>window.planner.status().then(status=>status.state==='ready'),{},{timeout:180000});
    await page.getByRole('button',{name:'Send message',exact:true}).click();await page.locator('.chat-message.assistant').filter({hasText:'Added event: Exam'}).waitFor({timeout:120000});assert.equal((await page.evaluate(()=>window.planner.snapshot())).events.length,1);
    await page.getByLabel('Message local assistant').focus();await page.keyboard.press('Control+z');await page.waitForFunction(()=>window.planner.snapshot().then(state=>state.events.length===0));
    await page.getByLabel('Send after a pause').check();await page.getByRole('button',{name:'Start dictation',exact:true}).click();
    await page.waitForFunction(()=>window.planner.snapshot().then(state=>state.events.length===1),{},{timeout:120000});
    await page.getByRole('button',{name:'Undo last change',exact:true}).click();await page.waitForFunction(()=>window.planner.snapshot().then(state=>state.events.length===0));
  }
  await page.getByLabel('Message local assistant').fill('Keep this typed prefix');
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();assert.equal(await page.getByLabel('Message local assistant').inputValue(),'Keep this typed prefix');assert.equal((await page.evaluate(()=>window.planner.speechStatus())).state,'idle');
  await page.getByRole('button',{name:'Start dictation',exact:true}).click();await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();await page.getByRole('button',{name:/A little help/}).click();await page.getByRole('button',{name:/A little help/}).click();assert.equal(await page.getByLabel('Message local assistant').getAttribute('readonly'),null);
  // Both sidecar processes must disappear when the app closes.
  const speech=await page.evaluate(()=>window.planner.startSpeech());const ollama=await page.evaluate(()=>window.planner.status());await app.close();app=undefined;await new Promise(resolve=>setTimeout(resolve,300));
  for(const pid of [speech.pid,ollama.pid].filter(Boolean)){let alive=false;try{process.kill(pid,0);alive=true;}catch{}assert.equal(alive,false);}
  fs.writeFileSync(path.join(root,'test-results','voice-report.json'),JSON.stringify({passed:true,live,final,mode:process.env.MYMIND_VOICE_UI_ONLY==='1'?'transcription UI':'voice to real planner + Ctrl Z',speechPid:speech.pid,ollamaPid:ollama.pid},null,2));console.log('Voice, cancellation, transcript preview, and process cleanup passed.');
}catch(error){if(app){try{const page=await app.firstWindow();console.log({speech:await page.evaluate(()=>window.planner.speechStatus()),caption:await page.locator('.dictation-strip').innerText(),input:await page.getByLabel('Message local assistant').inputValue()});await page.screenshot({path:path.join(root,'test-results','voice-error.png')});}catch{}}throw error;}finally{if(app)await app.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
