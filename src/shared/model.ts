export const COLORS = ['coral', 'amber', 'sage', 'sky', 'lavender', 'rose'] as const;
export const DEFAULT_ASSISTANT_MODEL = 'qwen3.5:4b';
export const DEFAULT_ASSISTANT_CONTEXT = 32_768;
export type Color = typeof COLORS[number];
export interface Categorized { categoryId: string | null; colorOverride: Color | null; }
export interface Category { id: string; title: string; color: Color; semanticKey?: string; aliases?: string[]; }
export type EventKind = 'planned' | 'actual';
export interface EventItem extends Categorized { kind: EventKind; linkedStepId: string | null; /** @deprecated Derived from linked work on reads. */ completed: boolean; linkedTaskId: string | null; id: string; title: string; notes: string; textBox: string; color: Color; startDate: string; endDate: string; startTime: string | null; endTime: string | null; }
export interface Project { id: string; title: string; order: number; }
export interface Section { id: string; projectId: string; title: string; order: number; }
export interface TaskStep { id: string; title: string; completed: boolean; }
export type TaskPriority = '' | 'Low' | 'Medium' | 'High';
export interface Task extends Categorized { createdAt: string | null; completedAt: string | null; id: string; title: string; notes: string; textBox: string; color: Color; dueDate: string | null; priority?:TaskPriority; estimate?:string; /** @deprecated Legacy input adapter; sessions are canonical. */ scheduledDate: string | null; completed: boolean; projectId: string; sectionId: string | null; order: number; steps: TaskStep[]; dependsOnIds: string[]; }
export interface Preferences { appearance?: 'light'|'dark'|'system'; timezone: string; dayWidth: number; year: number; chatOpen: boolean; voiceAutoSend?: boolean; chatWidth?: number; spokenReplies?: boolean; taskLayout?:'checklist'|'flow'; }
export interface SpeechStatus { state: 'idle'|'loading'|'ready'|'error'|'stopped'; message: string; pid?: number; port?: number; }
export interface Snapshot { revision: number; events: EventItem[]; tasks: Task[]; projects: Project[]; sections: Section[]; categories: Category[]; preferences: Preferences; canUndo: boolean; }
export type Entity = 'event' | 'task' | 'project' | 'section' | 'category';
export interface Change { action: 'create' | 'update' | 'delete'; entity: Entity; id?: string; fields?: Record<string, unknown>; }
export interface Mutation { changes: Change[]; label: string; expectedRevision: number; requestId: string; }
export interface DraftIdentity { id:string; version:number; baseRevision:number; }
export interface DraftIssue { id:string; question:string; required:boolean; entity?:Entity; targetId?:string; field?:string; conflictingFields?:string[]; requestId?:string; }
export interface DraftItem { id:string; entity:Entity; action:Change['action']|'restore'|'undo'; title:string; before?:Record<string,unknown>; after?:Record<string,unknown>; }
export interface PendingDraft extends DraftIdentity { changes:Change[]; projectedSnapshot:Snapshot; items:DraftItem[]; unresolved:DraftIssue[]; stale:boolean; busy:boolean; timezone:string; descriptions:string[]; }
export interface DraftPreview { saved:false; draft:PendingDraft; }
export interface ApplyDraftInput { draftId:string; version:number; expectedRevision:number; requestId:string; }
export interface EditDraftInput { draftId:string; version:number; expectedRevision:number; changes?:Change[]; repreview?:boolean; resolveIssueIds?:string[]; }
export interface DismissDraftInput { draftId:string; version:number; }
export type ActionPreviewTarget = {entity:'event'|'task'|'project'|'category'|'step';id:string;taskId?:string;before?:Record<string,unknown>};
export interface ActionReceipt {actionId:string;action:Change['action'];title:string;target:ActionPreviewTarget;undone?:boolean;}
export interface UndoActionInput {actionId:string;requestId:string;}
export type AssistantViewAction =
  | {type:'tab';tab:'calendar'|'tasks'}
  | {type:'date';date:string}
  | {type:'categoryVisibility';categoryId:string;visible:boolean}
  | {type:'showAllCategories'}
  | {type:'taskFilters';completion?:'active'|'completed'|'all';schedule?:'all'|'scheduled'|'unscheduled'}
  | {type:'projectCollapsed';projectId:string;collapsed:boolean}
  | {type:'taskExpanded';taskId:string;expanded:boolean};
export interface Receipt { draft?:DraftIdentity; label: string; descriptions: string[]; revision: number; items?: {id:string;entity:Entity;action:Change['action'];title:string}[]; actions?:ActionReceipt[]; }
export interface RuntimeStatus { state: 'starting' | 'loading' | 'ready' | 'error' | 'stopped'; message: string; model: string; context: number; gpu: 'unknown' | 'full' | 'partial' | 'cpu'; port?: number; pid?: number; startup?: {serverMs:number;checksMs:number;modelMs:number;totalMs:number;ollamaLoadMs?:number}; }
export interface Selection { entity: 'event'|'task'; id:string; revision:number; entryType?:'session'|'deadline'; draftId?:string; draftVersion?:number; }
export interface ChatInput { text:string; requestId:string; selection?:Selection; clarificationIssueId?:string; }
export type ChatInputCheck = {fits:boolean;message?:string};
export interface TranscriptionInput { audio:ArrayBuffer; mimeType:'audio/webm;codecs=opus'|'audio/webm'|'audio/wav'; requestId:string; }
export interface SpeechWord { text:string; start:number; end:number; }
export interface DictationDraft { id:string; generation:string; prefix:string; liveText:string; finalText:string; partialText:string; reviewText:string; revision:number; seconds:number; bytes:number; nextSequence:number; createdAt:string; updatedAt:string; }
export interface SpeechPreviewInput { draftId:string; generation:string; requestId:string; sequence:number; pcm:ArrayBuffer; sampleRate:16000; offset:number; }
export interface DraftTranscriptionInput { draftId:string; generation:string; requestId:string; sequence:number; }
export type SpeechProgress = DraftTranscriptionInput & {text:string; seconds:number};
export interface ChatResult { content: string; receipt?: Receipt; preview?:DraftPreview; disposition?:'dismissed'|'superseded'; contextTrimmed?: boolean; viewActions?:AssistantViewAction[]; status?:'failed'|'interrupted'; }
export interface ChatMessage extends ChatResult { id: string; role: 'user' | 'assistant'; }
export type ChatEvent = {requestId:string;type:'progress';stage:'understanding'|'searching'|'preparing'|'saving'|'responding';message:string} | {requestId:string;type:'text';text:string} | {requestId:string;type:'receipt';receipt:Receipt} | {requestId:string;type:'preview';preview:DraftPreview} | {requestId:string;type:'draftchange';draft:PendingDraft|null} | {requestId:string;type:'done';contextTrimmed:boolean} | {requestId:string;type:'error';message:string};
export interface PlannerAPI {
  snapshot(): Promise<Snapshot>;
  mutate(input: Mutation): Promise<Receipt>;
  undo(expectedRevision?:number): Promise<Receipt>;
  undoAction(input:UndoActionInput): Promise<ActionReceipt>;
  organizePreview(): Promise<{changes:Change[];descriptions:string[];revision:number}>;
  preferences(input: Partial<Preferences>): Promise<void>;
  getDraft(): Promise<PendingDraft|null>;
  applyDraft(input:ApplyDraftInput): Promise<Receipt>;
  editDraft(input:EditDraftInput): Promise<PendingDraft>;
  dismissDraft(input:DismissDraftInput): Promise<void>;
  onDraftChanged(fn:(draft:PendingDraft|null)=>void):()=>void;
  chat(input: ChatInput): Promise<ChatResult>;
  chatHistory(): Promise<ChatMessage[]>;
  checkChatInput(input: Omit<ChatInput,'requestId'>): Promise<ChatInputCheck>;
  cancelChat(): Promise<void>;
  newChat(): Promise<void>;
  onChatEvent(fn:(event:ChatEvent)=>void):()=>void;
  status(): Promise<RuntimeStatus>;
  runtimeSettings(): Promise<{model:string;context:number;activeContext:number|null;models:string[]}>;
  configureRuntime(input:{model:string;context:number}):Promise<void>;
  retryRuntime(): Promise<void>;
  startSpeech(): Promise<SpeechStatus>;
  transcribe(input: TranscriptionInput): Promise<{text:string;confidence?:number}>;
  speak(input:{text:string}):Promise<{pcm:ArrayBuffer;sampleRate:number}>;
  cancelSpeech(requestId?:string): Promise<void>;
  speechStatus(): Promise<SpeechStatus>;
  createDictation(input:{generation:string;prefix:string}):Promise<DictationDraft>;
  appendDictation(input:{draftId:string;generation:string;sequence:number;audio:ArrayBuffer;seconds:number}):Promise<void>;
  checkpointDictation(input:{draftId:string;generation:string;liveText?:string;reviewText?:string;revision?:number;seconds?:number}):Promise<DictationDraft>;
  listDictations():Promise<DictationDraft[]>;
  getDictation(draftId:string):Promise<DictationDraft>;
  restoreDictation(input:{draftId:string;generation:string}):Promise<DictationDraft>;
  discardDictation(draftId:string):Promise<void>;
  previewSpeech(input:SpeechPreviewInput):Promise<{words:SpeechWord[]}>;
  transcribeDictation(input:DraftTranscriptionInput):Promise<{text:string;confidence?:number}>;
  onSpeechProgress(fn:(event:SpeechProgress)=>void):()=>void;
  onPrepareClose(fn:()=>Promise<void>):()=>void;
  onChanged(fn: () => void): () => void;
  onStatus(fn: (status: RuntimeStatus) => void): () => void;
}
