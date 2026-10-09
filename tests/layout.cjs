const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {todayIn}=require('../dist/shared/dates');
const root=path.resolve(__dirname,'..');
(async()=>{for(const scale of [1.25,1.5]){
  const env={...process.env,MYMIND_SKIP_OLLAMA:'1',MYMIND_TEST_MODE:'1',MYMIND_DATA_DIR:path.join(root,'test-results',`layout-${scale}-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[`--force-device-scale-factor=${scale}`,root],env});
  try{const page=await app.firstWindow();await page.getByRole('heading',{name:'Your calendar.'}).waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1280,800));
    await page.evaluate(async today=>{const state=await window.planner.snapshot();await window.planner.mutate({changes:[{action:'create',entity:'task',fields:{title:'A longer task title that should wrap without clipping its checkbox',dueDate:today}},{action:'create',entity:'event',fields:{title:'A longer calendar event title to check readable wrapping',startDate:today}}],label:'Layout fixture',expectedRevision:state.revision,requestId:'layout'});},todayIn());
    await page.getByRole('button',{name:/A little help/}).click();await page.getByLabel('Message local assistant').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'New event',exact:true}).click();await page.getByLabel('Title',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth&&el.getBoundingClientRect().bottom<=innerHeight),true);
    await page.getByRole('button',{name:'Close editor',exact:true}).click();
    await page.screenshot({path:path.join(root,'test-results',`layout-${scale}.png`)});
    console.log(JSON.stringify({scale,passed:true,dpr:await page.evaluate(()=>devicePixelRatio)}));
  }finally{await app.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
