import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ChatEvent, PlannerAPI, RuntimeStatus, SpeechProgress } from '../shared/model';

function channel<T>() {
  const subscribers = new Set<(payload: T) => void>();
  return {
    publish(payload: T) { subscribers.forEach(callback => callback(payload)); },
    subscribe(callback: (payload: T) => void) {
      subscribers.add(callback);
      return () => { subscribers.delete(callback); };
    },
  };
}

function call<T>(operation: string, input?: unknown): Promise<T> {
  return invoke('planner_request', { operation, input });
}

function binary<T>(operation: string, data: ArrayBuffer, metadata: object): Promise<T> {
  return invoke('planner_audio', data, {
    headers: {
      'x-mymind-operation': operation,
      'x-mymind-metadata': JSON.stringify(metadata),
    },
  });
}

export async function installTauriBridge() {
  const changed = channel<void>();
  const status = channel<RuntimeStatus>();
  const chat = channel<ChatEvent>();
  const speech = channel<SpeechProgress>();
  const prepareClose = channel<void>();
  const subscriptions = await Promise.all([
    listen('planner-changed', () => changed.publish()),
    listen<RuntimeStatus>('assistant-status', event => status.publish(event.payload)),
    listen<ChatEvent>('assistant-event', event => chat.publish(event.payload)),
    listen<SpeechProgress>('speech-progress', event => speech.publish(event.payload)),
    listen('app-prepare-close', () => prepareClose.publish()),
  ]);
  addEventListener('pagehide', () => subscriptions.forEach(unlisten => unlisten()), { once: true });

  const api: PlannerAPI = {
    snapshot: () => call('snapshot'),
    mutate: input => call('mutate', input),
    undo: expectedRevision => call('undo', expectedRevision),
    organizePreview: () => call('organizePreview'),
    preferences: input => call('preferences', input),
    getDraft: () => call('getDraft'),
    applyDraft: input => call('applyDraft', input),
    editDraft: input => call('editDraft', input),
    dismissDraft: input => call('dismissDraft', input),
    onDraftChanged: callback => chat.subscribe(event => {
      if (event.type === 'draftchange') callback(event.draft);
    }),
    chat: input => call('chat', input),
    checkChatInput: input => call('checkChatInput', input),
    cancelChat: () => call('cancelChat'),
    newChat: () => call('newChat'),
    onChatEvent: chat.subscribe,
    status: () => call('status'),
    runtimeSettings: () => call('runtimeSettings'),
    configureRuntime: input => call('configureRuntime', input),
    retryRuntime: () => call('retryRuntime'),
    startSpeech: () => call('startSpeech'),
    transcribe: ({ audio, ...input }) => binary('transcribe', audio, input),
    async speak(input) {
      const buffer = await invoke<ArrayBuffer>('planner_speak', { input });
      const sampleRate = new DataView(buffer).getUint32(0, true);
      return { pcm: buffer.slice(4), sampleRate };
    },
    cancelSpeech: requestId => call('cancelSpeech', requestId),
    speechStatus: () => call('speechStatus'),
    createDictation: input => call('createDictation', input),
    appendDictation: ({ audio, ...input }) => binary('appendDictation', audio, input),
    checkpointDictation: input => call('checkpointDictation', input),
    listDictations: () => call('listDictations'),
    getDictation: draftId => call('getDictation', draftId),
    restoreDictation: input => call('restoreDictation', input),
    discardDictation: draftId => call('discardDictation', draftId),
    previewSpeech: ({ pcm, ...input }) => binary('previewSpeech', pcm, input),
    transcribeDictation: input => call('transcribeDictation', input),
    onSpeechProgress: speech.subscribe,
    onPrepareClose: callback => prepareClose.subscribe(() => {
      void callback().finally(() => call('closeReady')).catch(() => {});
    }),
    onChanged: changed.subscribe,
    onStatus: status.subscribe,
  };
  Object.defineProperty(window, 'planner', { value: Object.freeze(api) });
  const { preferences } = await api.snapshot();
  document.documentElement.dataset.theme =
    preferences.appearance === 'dark' ||
    (preferences.appearance === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  return () => call<void>('showWindow');
}
