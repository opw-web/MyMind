import { contextBridge, ipcRenderer } from 'electron';
import { PlannerAPI } from '../shared/model';
const api: PlannerAPI = {
  snapshot: () => ipcRenderer.invoke('planner:snapshot'),
  mutate: input => ipcRenderer.invoke('planner:mutate', input),
  undo: () => ipcRenderer.invoke('planner:undo'),
  preferences: input => ipcRenderer.invoke('planner:preferences', input),
  chat: input => ipcRenderer.invoke('assistant:chat', input),
  cancelChat: () => ipcRenderer.invoke('assistant:cancel'),
  status: () => ipcRenderer.invoke('assistant:status'),
  retryRuntime: () => ipcRenderer.invoke('assistant:retry'),
  startSpeech: () => ipcRenderer.invoke('speech:start'),
  transcribe: input => ipcRenderer.invoke('speech:transcribe',input),
  cancelSpeech: () => ipcRenderer.invoke('speech:cancel'),
  speechStatus: () => ipcRenderer.invoke('speech:status'),
  onChanged: fn => { const listener = () => fn(); ipcRenderer.on('planner:changed', listener); return () => ipcRenderer.removeListener('planner:changed', listener); },
  onStatus: fn => { const listener = (_event: unknown, status: any) => fn(status); ipcRenderer.on('assistant:status', listener); return () => ipcRenderer.removeListener('assistant:status', listener); }
};
contextBridge.exposeInMainWorld('planner', api);
