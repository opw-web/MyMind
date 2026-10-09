import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { WindowsJob } from './windows-job';
import { RuntimeStatus } from '../shared/model';

export class OllamaRuntime {
  readonly model = 'qwen3.5:4b';
  status: RuntimeStatus = { state: 'starting', message: 'Starting your local assistant…', model: this.model, context: 4096, gpu: 'unknown' };
  private job?: WindowsJob;
  private controller = new AbortController();
  private initializing?: Promise<void>;
  private stopped = false;
  private monitor?: NodeJS.Timeout;
  private setStatus(value: Partial<RuntimeStatus>): void { this.status = { ...this.status, ...value }; this.onStatus(this.status); }
  constructor(private onStatus: (status: RuntimeStatus) => void) {}
  get baseUrl(): string { return `http://127.0.0.1:${this.status.port}`; }
  private executable(): string {
    const candidates = [process.env.MYMIND_OLLAMA_PATH, join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'), join(process.env.ProgramFiles ?? '', 'Ollama', 'ollama.exe'), ...(process.env.PATH ?? '').split(delimiter).map(folder => join(folder.replace(/^"|"$/g, ''), 'ollama.exe'))];
    const found = candidates.find((path): path is string => !!path && existsSync(path));
    if (!found) throw new Error('Ollama is not installed. Install Ollama and download qwen3.5:4b, then click Retry.');
    return found;
  }
  private async freePort(): Promise<number> {
    return new Promise((resolve,reject) => { const server = createServer(); server.once('error',reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as {port:number}).port; server.close(error => error ? reject(error) : resolve(port)); }); });
  }
  async call(path: string, body?: unknown, signal?: AbortSignal, timeout = 60000): Promise<any> {
    if (this.stopped) throw new Error('MYMIND is closing.');
    const combined = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const response = await fetch(`${this.baseUrl}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined });
    const result: any = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || `Ollama returned ${response.status}.`);
    return result;
  }
  start(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async initialize(): Promise<void> {
    if (this.stopped) return;
    try {
      this.setStatus({ state: 'starting', message: 'Starting your local assistant…', gpu: 'unknown', context: 4096 });
      const executable = this.executable(), port = await this.freePort();
      if (this.stopped) return;
      this.job = new WindowsJob(executable, { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: process.env.OLLAMA_MODELS || join(process.env.USERPROFILE ?? '', '.ollama', 'models'), OLLAMA_NO_CLOUD: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_KEEP_ALIVE: '-1' });
      this.setStatus({ port, pid: this.job.pid });
      const deadline = Date.now() + 30000;
      let tags: any;
      while (Date.now() < deadline && !this.stopped) {
        if (!this.job.alive) throw new Error('Ollama exited during startup. Click Retry to start it again.');
        try { tags = await this.call('tags', undefined, undefined, 1500); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (this.stopped) return;
      if (!tags) throw new Error('Ollama did not become ready. Click Retry.');
      if (!tags.models?.some((model:any) => model.name === this.model || model.model === this.model)) throw new Error('qwen3.5:4b is not downloaded in Ollama. Download that model, then click Retry.');
      const capabilities = await this.call('show', { model: this.model });
      if (!capabilities.capabilities?.includes('tools')) throw new Error('The installed model does not support tools. Update Ollama and qwen3.5:4b, then retry.');
      this.setStatus({ state: 'loading', message: 'Loading Qwen onto your GPU…' });
      await this.call('generate', { model: this.model, prompt: '', stream: false, keep_alive: -1, think: false, options: { num_ctx: 4096 } }, undefined, 180000);
      let gpu = await this.gpuStatus();
      if (gpu !== 'full') {
        this.setStatus({ context: 2048, message: 'Reducing context to fit available GPU memory…' });
        await this.call('generate', { model: this.model, prompt: '', stream: false, keep_alive: 0 });
        await this.call('generate', { model: this.model, prompt: '', stream: false, keep_alive: -1, think: false, options: { num_ctx: 2048 } }, undefined, 180000);
        gpu = await this.gpuStatus();
      }
      if (this.stopped) return;
      this.setStatus({ state: 'ready', gpu, message: gpu === 'full' ? 'Qwen · fully on GPU' : gpu === 'partial' ? 'Qwen · GPU + CPU (GPU memory is busy)' : 'Qwen · CPU (GPU memory unavailable)' });
      this.monitor = setInterval(() => { if (!this.stopped && this.job && !this.job.alive) { this.job.close(); this.job = undefined; this.setStatus({ state: 'error', message: 'Ollama stopped. Your planner is saved; click Retry to reconnect.' }); if (this.monitor) clearInterval(this.monitor); } }, 3000);
    } catch (error) {
      if (this.stopped) return;
      this.job?.close(); this.job = undefined;
      this.setStatus({ state: 'error', message: error instanceof Error ? error.message : 'Could not start Ollama.' });
    }
  }
  private async gpuStatus(): Promise<RuntimeStatus['gpu']> {
    const ps = await this.call('ps');
    const model = ps.models?.find((model:any) => model.name === this.model || model.model === this.model);
    if (!model) return 'unknown';
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
