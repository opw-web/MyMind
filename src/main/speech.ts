import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import { WindowsJob } from './windows-job';
import { SpeechStatus, TranscriptionInput, SpeechPreviewInput, SpeechWord } from '../shared/model';

const transcriptionSchema=z.object({
  audio:z.instanceof(ArrayBuffer).refine(audio=>audio.byteLength>0,'No audio captured.'),
  mimeType:z.enum(['audio/webm;codecs=opus','audio/webm','audio/wav']),
  requestId:z.string().uuid()
}).strict();

export class SpeechRuntime {
  status:SpeechStatus={state:'idle',message:'Local dictation'};
  private job?:WindowsJob;
  private token='';
  private starting?:Promise<SpeechStatus>;
  private controller=new AbortController();
  private requests=new Map<string,AbortController>();
  private stopped=false;
  constructor(private resourceRoot:string,private hints:()=>string){}

  async start():Promise<SpeechStatus>{
    if(this.stopped)throw new Error('MYMIND is closing.');
    if(this.status.state==='ready'&&this.job?.alive)return this.status;
    if(this.starting)return this.starting;
    const pending=this.initialize();this.starting=pending;
    void pending.finally(()=>{if(this.starting===pending)this.starting=undefined;}).catch(()=>{});
    return pending;
  }
  private async initialize():Promise<SpeechStatus>{
    const signal=this.controller.signal;let ownedJob:WindowsJob|undefined;
    this.status={state:'loading',message:'Loading local dictation…'};
    try{
      const executable=join(this.resourceRoot,'python','python.exe'),worker=join(this.resourceRoot,'worker.py'),model=join(this.resourceRoot,'model'),preview=join(this.resourceRoot,'preview-model');
      if(!existsSync(executable)||!existsSync(worker)||!existsSync(join(model,'model.bin'))||!existsSync(join(preview,'model.bin')))throw new Error('The dictation runtime is missing. Reinstall the latest MYMIND installer.');
      const port=await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as {port:number}).port;server.close(error=>error?reject(error):resolve(port));});});
      signal.throwIfAborted();
      this.job?.close();this.token=randomUUID();
      this.job=new WindowsJob(executable,{...process.env,MYMIND_SPEECH_TOKEN:this.token,HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'},['-I','-B',worker,String(port),model,join(this.resourceRoot,'tts'),preview],'dictation');
      ownedJob=this.job;this.status={...this.status,port,pid:this.job.pid};
      const end=Date.now()+60000;
      while(Date.now()<end){
        signal.throwIfAborted();
        if(!ownedJob.alive)throw new Error('Local dictation stopped during startup. Try again.');
        try{
          const result=await this.request('/health',undefined,2000);
          if(result.state==='error')throw new Error(result.message);
          if(result.state==='ready'){
            this.status={...this.status,state:'ready',message:'Local dictation ready'};
            return this.status;
          }
        }catch(error){if(error instanceof Error&&error.message.startsWith('Could not load'))throw error;}
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      throw new Error('Local dictation took too long to start. Try again.');
    }catch(error){
      ownedJob?.close();
      if(!this.stopped){this.job=undefined;this.status={state:'error',message:error instanceof Error?error.message:'Dictation unavailable'};}
      throw error;
    }
  }
  private async request(path:string,body?:unknown,timeout:number|null=45000,signal?:AbortSignal,audio?:ArrayBuffer,headers:Record<string,string>={},progress?:(value:{text:string;seconds:number})=>void):Promise<any>{
    const signals=[this.controller.signal,...(signal?[signal]:[]),...(timeout===null?[]:[AbortSignal.timeout(timeout)])];
    if(audio!==undefined){
      // Native HTTP has no fetch/Undici five-minute header deadline. Long
      // recordings finish when transcription finishes or the user cancels.
      return new Promise((resolve,reject)=>{
        const request=httpRequest({hostname:'127.0.0.1',port:this.status.port,path,method:'POST',headers:{Authorization:`Bearer ${this.token}`,...headers,'Content-Length':audio.byteLength},signal:AbortSignal.any(signals)},response=>{
          let text='',final:any;const streaming=response.headers['content-type']==='application/x-ndjson';
          const line=(value:string)=>{const result=JSON.parse(value);if(result.type==='error')throw new Error(result.error||'Local speech failed.');if(result.type==='progress'){if(typeof result.text!=='string'||!Number.isFinite(result.seconds))throw new Error('Invalid speech progress.');progress?.({text:result.text,seconds:result.seconds});}else final=result;};
          response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;if(streaming){try{let at;while((at=text.indexOf('\n'))>=0){const value=text.slice(0,at);text=text.slice(at+1);if(value)line(value);}}catch(error){request.destroy(error as Error);reject(error);}}});response.on('error',reject);
          response.on('end',()=>{try{if(streaming&&text.trim())line(text);const result=streaming?final:JSON.parse(text);if(!result||response.statusCode!==200)throw new Error(result?.error||'Local speech failed.');resolve(result);}catch(error){reject(error);}});
        });
        request.on('error',reject);request.end(Buffer.from(audio));
      });
    }
    const response=await fetch(`http://127.0.0.1:${this.status.port}${path}`,{
      method:body===undefined&&audio===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json',...headers},
      ...(audio===undefined?(body===undefined?{}:{body:JSON.stringify(body)}):{body:audio}),
      signal:AbortSignal.any(signals)
    });
    const result:any=await response.json();
    if(!response.ok)throw new Error(result.error||'Local speech failed.');
    return result;
  }
  async transcribe(input:TranscriptionInput,progress?:(value:{text:string;seconds:number})=>void):Promise<{text:string;confidence?:number}>{
    const parsed=transcriptionSchema.parse(input);
    if(this.requests.has(parsed.requestId))throw new Error('This recording is already being transcribed.');
    const controller=new AbortController();this.requests.set(parsed.requestId,controller);
    try{
      await this.start();controller.signal.throwIfAborted();
      const result=await this.request('/transcribe',undefined,null,controller.signal,parsed.audio,{
        'Content-Type':parsed.mimeType,'X-Request-Id':parsed.requestId,'X-Speech-Hints':encodeURIComponent(this.hints().slice(0,700)),...(progress?{'X-Stream-Progress':'1'}:{})
      },progress);
      controller.signal.throwIfAborted();
      if(typeof result.text!=='string')throw new Error('Invalid transcription response.');
      return {text:result.text,confidence:typeof result.confidence==='number'?result.confidence:undefined};
    }finally{this.requests.delete(parsed.requestId);}
  }
  async preview(input:SpeechPreviewInput):Promise<{words:SpeechWord[]}>{
    const p=z.object({draftId:z.string().uuid(),generation:z.string().uuid(),requestId:z.string().uuid(),sequence:z.number().int().nonnegative(),pcm:z.instanceof(ArrayBuffer).refine(b=>b.byteLength>0&&b.byteLength%4===0&&b.byteLength<=16000*4*30),sampleRate:z.literal(16000),offset:z.number().nonnegative().finite()}).strict().parse(input);
    if(this.requests.has(p.requestId))throw new Error('Duplicate preview request.');
    const controller=new AbortController();this.requests.set(p.requestId,controller);
    try{
      await this.start();controller.signal.throwIfAborted();
      const result=await this.request('/preview',undefined,null,controller.signal,p.pcm,{'Content-Type':'application/octet-stream','X-Request-Id':p.requestId,'X-Speech-Hints':encodeURIComponent(this.hints().slice(0,700))});
      controller.signal.throwIfAborted();
      const words=z.array(z.object({text:z.string(),start:z.number().nonnegative().finite(),end:z.number().nonnegative().finite()})).parse(result.words);
      return {words:words.map(word=>({...word,start:word.start+p.offset,end:word.end+p.offset}))};
    }finally{this.requests.delete(p.requestId);}
  }
  async speak(input:{text:string}):Promise<{pcm:ArrayBuffer;sampleRate:number}>{
    const {text}=z.object({text:z.string().trim().min(1).max(4000)}).strict().parse(input);
    const requestId=randomUUID(),controller=new AbortController();this.requests.set(requestId,controller);
    try{
      await this.start();controller.signal.throwIfAborted();
      const result=await this.request('/speak',{text,requestId},90000,controller.signal),buffer=Buffer.from(result.pcm,'base64');
      controller.signal.throwIfAborted();
      if(result.sampleRate!==24000||buffer.length>24000*4*300||buffer.length%4)throw new Error('Invalid speech output.');
      return {pcm:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),sampleRate:result.sampleRate};
    }finally{this.requests.delete(requestId);}
  }
  async cancel(requestId?:string):Promise<void>{
    if(requestId!==undefined)z.string().uuid().parse(requestId);
    const ids=requestId===undefined?[...this.requests.keys()]:[requestId];
    for(const id of ids)this.requests.get(id)?.abort();
    if(!this.job?.alive||this.status.state!=='ready'||this.stopped)return;
    // Cancellation belongs to a request. The loaded models live until app exit.
    await Promise.allSettled(ids.map(id=>this.request('/cancel',{requestId:id},2000)));
  }
  stop():void{
    this.stopped=true;this.controller.abort();
    for(const request of this.requests.values())request.abort();
    this.requests.clear();this.job?.close();this.job=undefined;
    this.status={state:'stopped',message:'Dictation stopped'};
  }
}
