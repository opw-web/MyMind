
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'bloom-calendar-drag-'));
const {todayIn,shiftDate}=require('../dist/shared/dates.js');
const env={...process.env,MYMIND_TEST_MODE:'1',MYMIND_SKIP_OLLAMA:'1',MYMIND_DATA_DIR:path.join(out,'data')};
delete env.ELECTRON_RUN_AS_NODE;

(async()=>{
 let app;
 try {
  app=await electron.launch({executablePath:require('electron'),args:[root],env});
  const page=await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByTestId('calendar').waitFor();
  const today=todayIn(),next=shiftDate(today,1);
  await page.evaluate(({today,next})=>window.planner.mutate({
   changes:[
    {action:'create',entity:'event',id:'overnight',fields:{title:'Overnight drag probe',kind:'actual',startDate:today,endDate:next,startTime:'23:00',endTime:'01:00'}},
    {action:'create',entity:'event',id:'all-day',fields:{title:'All-day drag probe',startDate:today}},
   ],
   label:'Drag fixtures',expectedRevision:0,requestId:'seed',
  }),{today,next});
  const timeColumn=date=>page.locator('.time-column[data-date="'+date+'"]');
  const state=()=>page.evaluate(()=>window.planner.snapshot());
  async function waitForRevision(revision){
   const deadline=Date.now()+2500;
   let snapshot=await state();
   while(snapshot.revision<revision&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,25));
    snapshot=await state();
   }
   assert.equal(snapshot.revision,revision);
   return snapshot;
  }
  async function dropAtEight(source,column){
   const transfer=await page.evaluateHandle(()=>new DataTransfer());
   try {
    await source.dispatchEvent('dragstart',{dataTransfer:transfer});
    const clientY=await column.evaluate(el=>el.getBoundingClientRect().top+8*66);
    await column.dispatchEvent('drop',{dataTransfer:transfer,clientY});
   } finally { await transfer.dispose(); }
  }
  const overnightColumn=timeColumn(next);
  await dropAtEight(overnightColumn.locator('[data-event-id="overnight"]'),overnightColumn);
  const overnight=(await waitForRevision(2)).events.find(event=>event.id==='overnight');
  assert.deepEqual([overnight.startDate,overnight.startTime,overnight.endDate,overnight.endTime],[next,'07:00',next,'09:00']);
  const allDay=page.locator('.all-day-cell[data-date="'+today+'"] [data-event-id="all-day"]');
  await dropAtEight(allDay,timeColumn(today));
  const moved=(await waitForRevision(3)).events.find(event=>event.id==='all-day');
  assert.deepEqual([moved.startDate,moved.startTime,moved.endDate,moved.endTime],[today,'08:00',today,null]);
  console.log(JSON.stringify({passed:true,out,overnight,allDay:moved}));
 } finally {await app?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
