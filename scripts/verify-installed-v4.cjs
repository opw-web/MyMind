// Explicit post-upgrade launch. Reports counts only; constructor migration is
// the only planner change, and the companion SQLite verifier checks its data.
const {_electron:electron}=require('playwright'),path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const executable=path.join(process.env.LOCALAPPDATA,'Programs','MYMIND','MYMIND.exe');
const env={...process.env,MYMIND_TEST_MODE:'1',MYMIND_SKIP_OLLAMA:'1'};delete env.MYMIND_DATA_DIR;delete env.ELECTRON_RUN_AS_NODE;
(async()=>{const app=await electron.launch({executablePath:executable,args:[],env});try{
 const page=await app.firstWindow();await page.getByRole('heading',{name:'Calendar',exact:true}).waitFor();
 const version=await app.evaluate(({app})=>app.getVersion());assert.equal(version,require('../package.json').version);
 const result=await page.evaluate(async()=>{const s=await window.planner.snapshot();return {revision:s.revision,events:s.events.length,tasks:s.tasks.length,projects:s.projects.length,sections:s.sections.length,categories:s.categories.length,canUndo:s.canUndo,structurePresent:s.tasks.every(t=>Array.isArray(t.steps)&&Array.isArray(t.dependsOnIds))};});
 assert.equal(result.structurePresent,true);const report={passed:true,version,...result};fs.writeFileSync('test-results/installed-v4-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
