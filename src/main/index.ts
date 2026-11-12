import { app, BrowserWindow, ipcMain, powerMonitor, screen, nativeTheme } from 'electron';
import { join } from 'node:path';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { PlannerDatabase } from './database';
import { PlannerAssistant } from './assistant';
import { OllamaRuntime } from './ollama';
import { preferenceSchema } from '../shared/validation';
import { SpeechRuntime } from './speech';
import {z} from 'zod';
import {DictationDrafts} from './dictation-drafts';

const dataDir = process.env.MYMIND_DATA_DIR || join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'MYMIND');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('com.mymind.planner');
// This planner is a 2D interface. Keep rendering independent of GPU inference
// so model loading and other GPU applications cannot stall the workspace.
app.disableHardwareAcceleration();
let window: BrowserWindow | undefined, db: PlannerDatabase | undefined, runtime: OllamaRuntime | undefined, assistant: PlannerAssistant | undefined;
let shuttingDown = false;
let speech:SpeechRuntime|undefined;
let drafts:DictationDrafts|undefined,closePending=false,closeReady=false;
const dictationJobs=new Map<string,string>();
const draftRequest=z.object({draftId:z.string().uuid(),generation:z.string().uuid(),requestId:z.string().uuid(),sequence:z.number().int().nonnegative()}).strict();
function log(error: unknown): void { try { appendFileSync(join(dataDir,'errors.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`); } catch {} }
function shutdown(): void {
  if (shuttingDown) return; shuttingDown = true;
  assistant?.cancel(); speech?.stop(); runtime?.stop();
  try { drafts?.close(); } catch (error) { log(error); }
  try { db?.close(); } catch (error) { log(error); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  const prepareClose=()=>{
    if(closePending)return;closePending=true;
    if(window&&!window.isDestroyed())window.webContents.send('app:prepare-close');
    const timer=setTimeout(()=>{closeReady=true;shutdown();app.quit();},3000);timer.unref();
  };
  app.on('before-quit',event=>{if(!closeReady){event.preventDefault();prepareClose();}else shutdown();});
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', error => { log(error); shutdown(); app.exit(1); });
  process.on('unhandledRejection', error => { log(error); });
  app.whenReady().then(async () => {
    db = new PlannerDatabase(join(dataDir,'planner.sqlite'));
    const applyAppearance=()=>{nativeTheme.themeSource=db!.snapshot().preferences.appearance??'light';window?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#292524':'#fff8f0');};
    applyAppearance();
    nativeTheme.on('updated',()=>window?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#292524':'#fff8f0'));
    drafts = new DictationDrafts(join(dataDir,'dictation.sqlite'));
    const changed = () => { if (!shuttingDown && window && !window.isDestroyed()){window.webContents.send('planner:changed');window.webContents.send('assistant:event',{requestId:'',type:'draftchange',draft:assistant?.getDraft()??null});} };
    let savedSettings:{model:string;context:number}|undefined;
    const runtimeSchema=z.object({model:z.string().trim().min(1).max(200),context:z.number().int().min(4096).max(1048576)}).strict();
    try{savedSettings=runtimeSchema.parse(JSON.parse(readFileSync(join(dataDir,'assistant-settings.json'),'utf8')));}catch{}
    runtime = new OllamaRuntime(status => { if (!shuttingDown && window && !window.isDestroyed()) window.webContents.send('assistant:status',status); },savedSettings);
    assistant = new PlannerAssistant(db,runtime,changed,event=>{if(!shuttingDown&&window&&!window.isDestroyed())window.webContents.send('assistant:event',event);});
    speech = new SpeechRuntime(app.isPackaged?join(process.resourcesPath,'speech'):join(__dirname,'../../speech-runtime'),()=>{const state=db!.snapshot();return `MYMIND. Calendar. To-do list. Assignments, exams, submissions, tasks, cornhole prototype. ${[...state.projects,...state.tasks,...state.events].slice(0,20).map(item=>item.title.slice(0,80)).join(', ')}`;});
    const handle = (channel: string, handler: (...args:any[]) => any) => ipcMain.handle(channel, async (event,...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || shuttingDown) throw new Error('This planner request is unavailable.');
      try { return await handler(...args); } catch(error) { throw new Error(error instanceof Error ? error.message : 'The request could not be completed.'); }
    });
    handle('planner:snapshot', () => db!.snapshot());
    handle('planner:mutate', input => { const result = db!.mutate(input); changed(); return result; });
    handle('planner:undo', revision => {const parsed=revision===undefined?undefined:z.number().int().nonnegative().parse(revision); const result = db!.undo(parsed); changed(); return result; });
    handle('planner:organize-preview',()=>db!.organizePreview());
    handle('planner:preferences', input => { db!.preferences(preferenceSchema.parse(input)); applyAppearance(); changed(); });
    handle('assistant:get-draft',()=>assistant!.getDraft());
    handle('assistant:apply-draft',input=>assistant!.applyDraft(input));
    handle('assistant:edit-draft',input=>assistant!.editDraft(input));
    handle('assistant:dismiss-draft',input=>assistant!.dismissDraft(input));
    handle('assistant:chat', input => assistant!.chat(input));
    handle('assistant:check-input', input => assistant!.checkInput(input));
    handle('assistant:cancel', () => assistant!.cancel());
    handle('assistant:reset',()=>assistant!.reset());
    handle('assistant:status', () => runtime!.status);
    handle('assistant:settings',()=>runtime!.settings());
    handle('assistant:configure',async input=>{const settings=runtimeSchema.parse(input);assistant!.cancel();await runtime!.configure(settings);writeFileSync(join(dataDir,'assistant-settings.json'),JSON.stringify(settings));});
    handle('assistant:retry', () => runtime!.retry());
    handle('speech:start', () => speech!.start());
    handle('speech:transcribe', input => speech!.transcribe(input));
    handle('speech:speak',input=>speech!.speak(input));
    handle('speech:cancel', requestId => speech!.cancel(requestId));
    handle('speech:status', () => speech!.status);
    handle('dictation:create',input=>drafts!.create(input));
    handle('dictation:append',input=>drafts!.append(input));
    handle('dictation:checkpoint',input=>drafts!.checkpoint(input));
    handle('dictation:list',()=>drafts!.list());
    handle('dictation:get',id=>drafts!.get(id));
    handle('dictation:restore',input=>{
      const p=z.object({draftId:z.string().uuid(),generation:z.string().uuid()}).strict().parse(input);
      const request=dictationJobs.get(p.draftId);if(request)void speech!.cancel(request);
      dictationJobs.delete(p.draftId);return drafts!.bind(p.draftId,p.generation);
    });
    handle('dictation:discard',id=>{
      z.string().uuid().parse(id);const request=dictationJobs.get(id);if(request)void speech!.cancel(request);
      dictationJobs.delete(id);drafts!.discard(id);
    });
    handle('speech:preview',async input=>{
      const p=z.object({draftId:z.string().uuid(),generation:z.string().uuid()}).passthrough().parse(input);
      drafts!.owned(p.draftId,p.generation);if(dictationJobs.has(p.draftId))throw new Error('Final transcription is already running.');
      const result=await speech!.preview(input);drafts!.owned(p.draftId,p.generation);return result;
    });
    handle('dictation:transcribe',async input=>{
      const p=draftRequest.parse(input),draft=drafts!.owned(p.draftId,p.generation);
      if(dictationJobs.has(draft.id))throw new Error('This recording is already being transcribed.');
      dictationJobs.set(draft.id,p.requestId);
      try{
        const result=await speech!.transcribe({audio:drafts!.audio(draft.id,p.generation),mimeType:'audio/webm;codecs=opus',requestId:p.requestId},progress=>{
          if(shuttingDown||dictationJobs.get(draft.id)!==p.requestId)return;
          try{drafts!.progress(draft.id,p.generation,progress.text);window?.webContents.send('speech:progress',{...p,...progress});}catch{}
        });
        if(dictationJobs.get(draft.id)!==p.requestId)throw new Error('This dictation session has changed.');
        drafts!.final(draft.id,p.generation,result.text,draft.reviewText.trim()===[draft.prefix.trim(),draft.liveText.trim()].filter(Boolean).join(' ')?draft.revision:undefined);return result;
      }finally{if(dictationJobs.get(draft.id)===p.requestId)dictationJobs.delete(draft.id);}
    });
    handle('app:close-ready',()=>{if(closePending){closeReady=true;shutdown();setImmediate(()=>app.quit());}});
    const available = screen.getPrimaryDisplay().workAreaSize;
    if (process.env.MYMIND_SKIP_OLLAMA !== '1') void runtime.start();
    window = new BrowserWindow({ width: Math.min(1480,Math.max(1000,available.width-40)), height: Math.min(940,Math.max(650,available.height-40)), minWidth: 900, minHeight: 600, backgroundColor: nativeTheme.shouldUseDarkColors?'#292524':'#fff8f0', title: 'MYMIND', autoHideMenuBar: true, show: false, icon: join(__dirname,'../../assets/icon.ico'), webPreferences: { preload: join(__dirname,'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false,backgroundThrottling:false } });
    window.removeMenu();
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window?.webContents&&permission==='media'&&'mediaTypes' in details&&details.mediaTypes?.every(type=>type==='audio')===true));
    window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window?.webContents&&permission==='media'&&details.mediaType==='audio');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event=>{if(!closeReady){event.preventDefault();prepareClose();}else shutdown();});
    window.on('closed', () => { window = undefined; });
    window.once('ready-to-show', () => { if (process.env.MYMIND_TEST_MODE !== '1') window?.show(); });
    await window.loadFile(join(__dirname,'../renderer/index.html'),{query:{theme:nativeTheme.shouldUseDarkColors?'dark':'light'}});
    powerMonitor.on('resume', () => { changed(); void runtime?.resume(); });
  }).catch(error => { log(error); shutdown(); app.exit(1); });
}
