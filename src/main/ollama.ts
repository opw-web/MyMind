import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createServer } from 'node:net';
import {execFile} from 'node:child_process';
import { WindowsJob } from './windows-job';
import { RuntimeStatus } from '../shared/model';

export class OllamaRuntime {
  model = process.env.MYMIND_MODEL || 'qwen3.5:9b';
  // Use the same runner options for preload and every chat request.
  readonly modelOptions:{num_ctx:number;num_gpu?:number} = {num_ctx:65536};
  status: RuntimeStatus = { state: 'starting', message: 'Starting your local assistant…', model: this.model, context: 65536, gpu: 'unknown' };
  private job?: WindowsJob;
  private controller = new AbortController();
  private initializing?: Promise<void>;
  private stopped = false;
  private monitor?: NodeJS.Timeout;
  private setStatus(value: Partial<RuntimeStatus>): void { this.status = { ...this.status, ...value }; this.onStatus(this.status); }
  constructor(private onStatus: (status: RuntimeStatus) => void, settings?: {model:string;context:number}) { if(settings){this.model=settings.model;this.modelOptions.num_ctx=settings.context;} this.status={...this.status,model:this.model,context:this.modelOptions.num_ctx}; }
  private async localModel(name:string,tags?:any):Promise<any>{
    const installed=(tags??await this.call('tags')).models?.find((m:any)=>m.name===name||m.model===name);
    if(!installed||!(installed.size>0))throw new Error('Choose an installed local model with weights.');
    if(/^(?:hf\.co|huggingface\.co)\//i.test(name)||name.includes('/'))throw new Error('Choose an installed Ollama library model.');
    const info=await this.call('show',{model:name});
    if([installed,info].some(m=>m.remote_model||m.remote_host||m.remote===true||m.cloud===true)||/:.*cloud/i.test(name))throw new Error('Choose a local model; remote and cloud models are unavailable.');
    if(info.details?.format!=='gguf'||!info.capabilities?.includes('completion')||!info.capabilities?.includes('tools'))throw new Error('Choose local weights supporting both completion and tools.');
    return info;
  }
  async settings() {
    const tags=await this.call('tags'),models:string[]=[];
    for(const model of tags.models??[]){const name=String(model.name??model.model);try{await this.localModel(name,tags);models.push(name);}catch{}}
    if(this.status.state==='ready')await this.gpuStatus();
    return {model:this.model,context:this.modelOptions.num_ctx,activeContext:this.status.state==='ready'?this.status.context:null,models};
  }
  async configure(settings:{model:string;context:number}):Promise<void>{
    if(this.initializing)throw new Error('Wait for model loading to finish before changing settings.');
    await this.localModel(settings.model);
    this.model=settings.model;this.modelOptions.num_ctx=settings.context;
    this.setStatus({model:this.model,context:settings.context});await this.retry();
    if(this.status.state!=='ready')throw new Error(this.status.message);
  }
  get baseUrl(): string { return `http://127.0.0.1:${this.status.port}`; }
  private executable(): string {
    const candidates = [process.env.MYMIND_OLLAMA_PATH, join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'), join(process.env.ProgramFiles ?? '', 'Ollama', 'ollama.exe'), ...(process.env.PATH ?? '').split(delimiter).map(folder => join(folder.replace(/^"|"$/g, ''), 'ollama.exe'))];
    const found = candidates.find((path): path is string => !!path && existsSync(path));
    if (!found) throw new Error(`Install Ollama and download ${this.model}, then click Retry.`);
    return found;
  }
  private async freePort(): Promise<number> {
    return new Promise((resolve,reject) => { const server = createServer(); server.once('error',reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as {port:number}).port; server.close(error => error ? reject(error) : resolve(port)); }); });
  }
  private async limitSharedGpu(modelBytes:number,layers:number):Promise<void>{
    const free=await new Promise<number|undefined>(resolve=>execFile('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000},(error,stdout)=>{const value=Number(stdout.trim().split('\n')[0]);resolve(!error&&Number.isFinite(value)?value:undefined);}));
    // WDDM can page an ostensibly fully offloaded model into shared RAM.
    // Bound offload by the free memory before loading; leave room for compute
    // buffers and other windows, while retaining useful partial acceleration.
    if(free!==undefined&&modelBytes>0&&layers>0){
      const fit=Math.max(0,Math.floor((free-1536)*1048576/modelBytes*layers));
      if(fit<layers)this.modelOptions.num_gpu=fit;else delete this.modelOptions.num_gpu;
    }else delete this.modelOptions.num_gpu;
  }
  async call(path: string, body?: unknown, signal?: AbortSignal, timeout = 60000): Promise<any> {
    if (this.stopped) throw new Error('MYMIND is closing.');
    if(path==='chat')return this.streamChat(body as Record<string,unknown>,signal??new AbortController().signal,()=>{},timeout);
    const combined = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const response = await fetch(`${this.baseUrl}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined });
    const result: any = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Ollama returned ${response.status}.`);
    return result;
  }
  async streamChat(body:Record<string,unknown>,signal:AbortSignal,onText:(text:string)=>void,timeout=600000):Promise<any>{
    const combined=AbortSignal.any([this.controller.signal,signal,AbortSignal.timeout(timeout)]);
    const response=await fetch(`${this.baseUrl}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,stream:true}),signal:combined});
    if(!response.ok||!response.body){const error:any=await response.json().catch(()=>({}));throw new Error(error.error||`Local assistant returned ${response.status}.`);}
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',content='',thinking='';const calls:any[]=[];let final:any={};
    const consume=(line:string)=>{if(!line.trim())return;const value=JSON.parse(line);if(value.error)throw new Error(value.error);const text=value.message?.content??'';content+=text;thinking+=value.message?.thinking??'';if(text)onText(text);if(value.message?.tool_calls)calls.push(...value.message.tool_calls);if(value.done)final=value;};
    try{while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){consume(pending.slice(0,end));pending=pending.slice(end+1);}}pending+=decoder.decode();if(pending.trim())consume(pending);}
    finally{await reader.cancel().catch(()=>{});}
    return {...final,message:{role:'assistant',content,...(thinking?{thinking}:{}),...(calls.length?{tool_calls:calls}:{})}};
  }
  start(): Promise<void> {
    if (this.stopped || (this.status.state==='ready'&&this.job?.alive)) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async initialize(): Promise<void> {
    if (this.stopped) return;
    const started=performance.now();
    let serverReady=false;
    try {
      if(this.monitor)clearInterval(this.monitor);
      this.job?.close();this.job=undefined;
      this.setStatus({ state: 'starting', message: 'Starting your local assistant…', gpu: 'unknown', model:this.model, context: this.modelOptions.num_ctx, startup:undefined });
      const executable = this.executable(), port = await this.freePort();
      if (this.stopped) return;
      this.job = new WindowsJob(executable, { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: process.env.OLLAMA_MODELS || join(process.env.USERPROFILE ?? '', '.ollama', 'models'), OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: String(this.modelOptions.num_ctx), OLLAMA_KEEP_ALIVE: '-1', OLLAMA_FLASH_ATTENTION:'1',OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_GPU_OVERHEAD:String(1536*1048576) });
      this.setStatus({ port, pid: this.job.pid });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !this.stopped) {
        if (!this.job.alive) throw new Error('Ollama exited during startup. Click Retry to start it again.');
        try { await this.call('version', undefined, undefined, 3000); serverReady=true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (this.stopped) return;
      if (!serverReady) throw new Error('Ollama did not become ready. Click Retry.');
      const serverMs=Math.round(performance.now()-started),checksStarted=performance.now();
      this.setStatus({message:'Checking your local model…'});
      const tags=await this.call('tags');
      let capabilities:any;
      try{capabilities=await this.localModel(this.model,tags);}catch(error){throw new Error(`${this.model} is unavailable: ${error instanceof Error?error.message:'Cannot read model metadata.'} Open Settings to select an eligible installed model.`);}
      const checksMs=Math.round(performance.now()-checksStarted),loadStarted=performance.now();
      const installedModel=tags.models.find((model:any)=>model.name===this.model||model.model===this.model);
      const layerCount=Object.entries(capabilities.model_info??{}).find(([key])=>key.endsWith('.block_count')&&!key.includes('.vision.'))?.[1];
      await this.limitSharedGpu(Number(installedModel?.size??0),Number(layerCount??0));
      this.setStatus({ state: 'loading', message: this.modelOptions.num_gpu===0?'Loading local assistant on CPU while GPU is busy…':`Loading ${this.model}…` });
      const loaded=await this.call('generate', { model: this.model, prompt: '', stream: false, keep_alive: -1, think: false, options: this.modelOptions }, undefined, 180000);
      const modelMs=Math.round(performance.now()-loadStarted),ollamaLoadMs=typeof loaded.load_duration==='number'?Math.round(loaded.load_duration/1000000):undefined;
      const gpu = await this.gpuStatus();
      if (this.stopped) return;
      this.setStatus({ state: 'ready', gpu, startup:{serverMs,checksMs,modelMs,ollamaLoadMs,totalMs:Math.round(performance.now()-started)}, message: `${this.model} · ${gpu==='full'?'fully on GPU':gpu==='partial'?'GPU + CPU':gpu==='cpu'?'CPU':'ready'}` });
      this.monitor = setInterval(() => { if (!this.stopped && this.job && !this.job.alive) { this.job.close(); this.job = undefined; this.setStatus({ state: 'error', message: 'Ollama stopped. Your planner is saved; click Retry to reconnect.' }); if (this.monitor) clearInterval(this.monitor); } }, 3000);
    } catch (error) {
      if (this.stopped) return;
      // A reachable discovery server must survive invalid saved selections so
      // Settings can list and configure a replacement without restarting MYMIND.
      if(!serverReady){this.job?.close(); this.job = undefined;}
      this.setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not start Ollama.' });
    }
  }
  private async gpuStatus(): Promise<RuntimeStatus['gpu']> {
    const ps = await this.call('ps');
    const model = ps.models?.find((model:any) => model.name === this.model || model.model === this.model);
    if (!model) return 'unknown';
    if(typeof model.context_length!=='number')throw new Error('Ollama did not report its active context window. Update Ollama and retry.');
    this.setStatus({context:model.context_length});
    return model.size_vram >= model.size * 0.99 ? 'full' : model.size_vram > 0 ? 'partial' : 'cpu';
  }
  async retry(): Promise<void> {
    if (this.stopped || this.initializing) return;
    this.controller.abort(); this.job?.close(); this.job = undefined;
    if (this.monitor) clearInterval(this.monitor);
    this.controller = new AbortController(); await this.start();
  }
  async resume(): Promise<void> { if (this.status.state === 'error') await this.retry(); }
  stop(): void {
    this.stopped = true; this.controller.abort();
    if (this.monitor) clearInterval(this.monitor);
    this.job?.close(); this.job = undefined;
    this.setStatus({ state: 'stopped', message: 'Assistant stopped.' });
  }
}
