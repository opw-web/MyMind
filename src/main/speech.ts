import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { z } from 'zod';
import { WindowsJob } from './windows-job';
import { SpeechStatus } from '../shared/model';

export class SpeechRuntime {
  status: SpeechStatus = {state:'idle',message:'Local dictation'};
  private job?:WindowsJob;
  private token='';
  private starting?:Promise<SpeechStatus>;
  private controller=new AbortController();
  private stopped=false;
  constructor(private resourceRoot:string,private hints:()=>string){}
  async start():Promise<SpeechStatus>{
    if(this.stopped)throw new Error('MYMIND is closing.');
    if(this.status.state==='ready'&&this.job?.alive)return this.status;
    if(this.starting)return this.starting;
    const pending=this.initialize();this.starting=pending;void pending.finally(()=>{if(this.starting===pending)this.starting=undefined;}).catch(()=>{});return pending;
  }
  private async initialize():Promise<SpeechStatus>{
    const signal=this.controller.signal;let ownedJob:WindowsJob|undefined;
    this.status={state:'loading',message:'Loading local dictation…'};
    try{
      const executable=join(this.resourceRoot,'mymind-whisper','mymind-whisper.exe'),model=join(this.resourceRoot,'model');
      if(!existsSync(executable)||!existsSync(join(model,'model.bin')))throw new Error('The dictation runtime is missing. Reinstall the latest MYMIND installer.');
      const port=await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as {port:number}).port;server.close(()=>resolve(port));});});
      if(this.stopped||signal.aborted)throw new Error('Dictation cancelled.');
      this.token=randomUUID();
      this.job=new WindowsJob(executable,{...process.env,MYMIND_SPEECH_TOKEN:this.token,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'},[String(port),model],'dictation');
      ownedJob=this.job;
      this.status={...this.status,port,pid:this.job.pid};
      const end=Date.now()+60000;
      while(Date.now()<end){
        signal.throwIfAborted();
        if(!this.job?.alive)throw new Error('Local dictation stopped during startup. Try the microphone again.');
        try{const result=await this.request('/health',undefined,2000);if(result.state==='error')throw new Error(result.message);if(result.state==='ready'){this.status={...this.status,state:'ready',message:'Local dictation ready'};return this.status;}}catch(error){if(error instanceof Error&&error.message.startsWith('Could not load'))throw error;}
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      throw new Error('Local dictation took too long to start. Try again.');
    }catch(error){ownedJob?.close();if(this.controller.signal===signal){this.job=undefined;this.status={state:'error',message:error instanceof Error?error.message:'Dictation unavailable'};}throw error;}
  }
  private async request(path:string,body?:unknown,timeout=45000):Promise<any>{
    const response=await fetch(`http://127.0.0.1:${this.status.port}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(timeout)])});
    const result:any=await response.json();if(!response.ok)throw new Error(result.error||'Dictation failed.');return result;
  }
  async transcribe(input:{pcm:ArrayBuffer;final:boolean}):Promise<{text:string}>{
    const parsed=z.object({pcm:z.instanceof(ArrayBuffer).refine(pcm=>pcm.byteLength>=3200&&pcm.byteLength<=1440000&&pcm.byteLength%2===0,'Invalid audio length'),final:z.boolean()}).strict().parse(input);
    await this.start();const result=await this.request('/transcribe',{pcm:Buffer.from(parsed.pcm).toString('base64'),final:parsed.final,hints:this.hints().slice(0,1500)});return {text:String(result.text??'').slice(0,4000)};
  }
  cancel():void{this.controller.abort();this.job?.close();this.job=undefined;this.starting=undefined;this.controller=new AbortController();this.status={state:'idle',message:'Local dictation'};}
  stop():void{this.stopped=true;this.cancel();this.status={state:'stopped',message:'Dictation stopped'};}
}
