import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {OllamaRuntime} from '../src/main/ollama';

async function main(){
  const runs=[];
  const baselinePath=process.env.MYMIND_BASELINE_RUNTIME;
  const baselineRequire=createRequire(__filename);
  const variants=baselinePath?['baseline','updated']:['updated'];
  for(let index=0;index<3;index++){
   for(const variant of variants){
    const freeMiB=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,encoding:'utf8'}).trim().split(/\s/)[0]);
    const started=performance.now();
    const stages:{state:string;ms:number}[]=[];
    const Runtime:typeof OllamaRuntime=variant==='baseline'?baselineRequire(baselinePath!).OllamaRuntime:OllamaRuntime;
    const runtime=new Runtime(status=>{stages.push({state:status.state,ms:Math.round(performance.now()-started)});});
    try{
      await runtime.start();
      if(runtime.status.state!=='ready')throw new Error(runtime.status.message);
      const run={index,variant,freeMiB,totalMs:Math.round(performance.now()-started),modelMs:stages.find(s=>s.state==='ready')!.ms-stages.find(s=>s.state==='loading')!.ms,gpu:runtime.status.gpu,context:runtime.status.context,stages,...('startup' in runtime.status?{timings:runtime.status.startup}:{})};
      runs.push(run);console.log(JSON.stringify(run));
      if(variant==='updated'&&!process.env.MYMIND_STARTUP_REPORT_FILE?.includes('before')){
        const pid=runtime.status.pid;await runtime.start();
        if(runtime.status.pid!==pid)throw new Error('Starting an already-ready runtime spawned another worker.');
      }
    }finally{runtime.stop();}
    await new Promise(resolve=>setTimeout(resolve,2500));
   }
  }
  mkdirSync('test-results',{recursive:true});
  const summary=variants.map(variant=>({variant,medianMs:runs.filter(r=>r.variant===variant).map(r=>r.totalMs).sort((a,b)=>a-b)[1],medianModelMs:runs.filter(r=>r.variant===variant).map(r=>r.modelMs).sort((a,b)=>a-b)[1]}));
  writeFileSync(process.env.MYMIND_STARTUP_REPORT_FILE||'test-results/startup-after.json',JSON.stringify({runs,summary},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
