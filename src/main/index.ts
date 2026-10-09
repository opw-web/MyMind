import { app, BrowserWindow, ipcMain, powerMonitor, screen, nativeTheme } from 'electron';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { PlannerDatabase } from './database';
import { PlannerAssistant } from './assistant';
import { OllamaRuntime } from './ollama';
import { preferenceSchema } from '../shared/validation';
import { SpeechRuntime } from './speech';

const dataDir = process.env.MYMIND_DATA_DIR || join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'MYMIND');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setAppUserModelId('com.mymind.planner');
let window: BrowserWindow | undefined, db: PlannerDatabase | undefined, runtime: OllamaRuntime | undefined, assistant: PlannerAssistant | undefined;
let shuttingDown = false;
let speech:SpeechRuntime|undefined;
function log(error: unknown): void { try { appendFileSync(join(dataDir,'errors.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`); } catch {} }
function shutdown(): void {
  if (shuttingDown) return; shuttingDown = true;
  assistant?.cancel(); speech?.stop(); runtime?.stop();
  try { db?.close(); } catch (error) { log(error); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('before-quit', shutdown);
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', error => { log(error); shutdown(); app.exit(1); });
  process.on('unhandledRejection', error => { log(error); });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    db = new PlannerDatabase(join(dataDir,'planner.sqlite'));
    const changed = () => { if (!shuttingDown && window && !window.isDestroyed()) window.webContents.send('planner:changed'); };
    runtime = new OllamaRuntime(status => { if (!shuttingDown && window && !window.isDestroyed()) window.webContents.send('assistant:status',status); });
    assistant = new PlannerAssistant(db,runtime,changed);
    speech = new SpeechRuntime(app.isPackaged?join(process.resourcesPath,'speech'):join(__dirname,'../../speech-runtime'),()=>{const state=db!.snapshot();return `Calendar events, tasks, and projects. Proper names: ${[...state.projects,...state.tasks,...state.events].slice(0,35).map(item=>item.title).join(', ')}`;});
    const handle = (channel: string, handler: (...args:any[]) => any) => ipcMain.handle(channel, async (event,...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || shuttingDown) throw new Error('This planner request is unavailable.');
      try { return await handler(...args); } catch(error) { throw new Error(error instanceof Error ? error.message : 'The request could not be completed.'); }
    });
    handle('planner:snapshot', () => db!.snapshot());
    handle('planner:mutate', input => { const result = db!.mutate(input); changed(); return result; });
    handle('planner:undo', () => { const result = db!.undo(); changed(); return result; });
    handle('planner:preferences', input => { db!.preferences(preferenceSchema.parse(input)); changed(); });
    handle('assistant:chat', input => assistant!.chat(input));
    handle('assistant:cancel', () => assistant!.cancel());
    handle('assistant:status', () => runtime!.status);
    handle('assistant:retry', () => runtime!.retry());
    handle('speech:start', () => speech!.start());
    handle('speech:transcribe', input => speech!.transcribe(input));
    handle('speech:cancel', () => speech!.cancel());
    handle('speech:status', () => speech!.status);
    const available = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({ width: Math.min(1480,Math.max(1000,available.width-40)), height: Math.min(940,Math.max(650,available.height-40)), minWidth: 1000, minHeight: 650, backgroundColor: '#111718', title: 'MYMIND', autoHideMenuBar: true, show: false, icon: join(__dirname,'../../assets/icon.ico'), webPreferences: { preload: join(__dirname,'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
    window.removeMenu();
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window?.webContents&&permission==='media'&&'mediaTypes' in details&&details.mediaTypes?.every(type=>type==='audio')===true));
    window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window?.webContents&&permission==='media'&&details.mediaType==='audio');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', shutdown);
    window.on('closed', () => { window = undefined; });
    window.once('ready-to-show', () => { if (process.env.MYMIND_TEST_MODE !== '1') window?.show(); });
    await window.loadFile(join(__dirname,'../renderer/index.html'));
    if (process.env.MYMIND_SKIP_OLLAMA !== '1') void runtime.start();
    powerMonitor.on('resume', () => { changed(); void runtime?.resume(); });
  }).catch(error => { log(error); shutdown(); app.exit(1); });
}
