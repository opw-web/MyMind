export const COLORS = ['coral', 'amber', 'sage', 'sky', 'lavender', 'rose'] as const;
export type Color = typeof COLORS[number];
export interface EventItem { id: string; title: string; notes: string; color: Color; startDate: string; endDate: string; startTime: string | null; endTime: string | null; }
export interface Project { id: string; title: string; order: number; }
export interface Section { id: string; projectId: string; title: string; order: number; }
export interface Task { id: string; title: string; notes: string; color: Color; dueDate: string | null; completed: boolean; projectId: string; sectionId: string | null; order: number; }
export interface Preferences { timezone: string; dayWidth: number; year: number; chatOpen: boolean; voiceAutoSend?: boolean; }
export interface SpeechStatus { state: 'idle'|'loading'|'ready'|'error'|'stopped'; message: string; pid?: number; port?: number; }
export interface Snapshot { revision: number; events: EventItem[]; tasks: Task[]; projects: Project[]; sections: Section[]; preferences: Preferences; canUndo: boolean; }
export type Entity = 'event' | 'task' | 'project' | 'section';
export interface Change { action: 'create' | 'update' | 'delete'; entity: Entity; id?: string; fields?: Record<string, unknown>; }
export interface Mutation { changes: Change[]; label: string; expectedRevision: number; requestId: string; }
export interface Receipt { label: string; descriptions: string[]; revision: number; }
export interface RuntimeStatus { state: 'starting' | 'loading' | 'ready' | 'error' | 'stopped'; message: string; model: string; context: number; gpu: 'unknown' | 'full' | 'partial' | 'cpu'; port?: number; pid?: number; }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; receipt?: Receipt; }
export interface ChatResult { content: string; receipt?: Receipt; }
export interface PlannerAPI {
  snapshot(): Promise<Snapshot>;
  mutate(input: Mutation): Promise<Receipt>;
  undo(): Promise<Receipt>;
  preferences(input: Partial<Preferences>): Promise<void>;
  chat(input: { text: string; requestId: string }): Promise<ChatResult>;
  cancelChat(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  retryRuntime(): Promise<void>;
  startSpeech(): Promise<SpeechStatus>;
  transcribe(input: { pcm: ArrayBuffer; final: boolean }): Promise<{text:string}>;
  cancelSpeech(): Promise<void>;
  speechStatus(): Promise<SpeechStatus>;
  onChanged(fn: () => void): () => void;
  onStatus(fn: (status: RuntimeStatus) => void): () => void;
}
