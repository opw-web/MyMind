import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Change, Entity, EventItem, Mutation, Preferences, Receipt, Section, Snapshot, Task } from '../shared/model';
import { eventFields, mutationSchema, preferenceSchema, projectFields, sectionFields, taskFields } from '../shared/validation';
import { todayIn, daysBetween, shiftDate, shortDate } from '../shared/dates';

const tables: Record<Entity, string> = { event: 'events', task: 'tasks', project: 'projects', section: 'sections' };
type SavedState = Pick<Snapshot, 'events' | 'tasks' | 'projects' | 'sections'>;
export class PlannerDatabase {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('This planner database needs a newer version of MYMIND.');
    if (version === 0) {
      this.db.exec(`BEGIN;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE projects (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE sections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL);
        CREATE TABLE events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), section_id TEXT REFERENCES sections(id), body TEXT NOT NULL);
        CREATE INDEX tasks_project ON tasks(project_id);
        CREATE INDEX tasks_section ON tasks(section_id);
        CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, before_state TEXT NOT NULL, descriptions TEXT NOT NULL);
        CREATE TABLE requests (id TEXT PRIMARY KEY, receipt TEXT NOT NULL);
        INSERT INTO meta VALUES ('revision', '0');
        PRAGMA user_version=1;
        COMMIT;`);
      this.put('project', { id: 'inbox', title: 'Inbox', order: 0 });
      this.setMeta('preferences', JSON.stringify({ timezone: 'Asia/Kolkata', dayWidth: 132, year: Number(todayIn().slice(0, 4)), chatOpen: false }));
    }
  }
  private meta(key: string): string { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string }).value; }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  get revision(): number { return Number(this.meta('revision')); }
  private rows<T>(entity: Entity): T[] { return this.db.prepare(`SELECT body FROM ${tables[entity]} ORDER BY rowid`).all().map(row => JSON.parse(row.body as string) as T); }
  snapshot(): Snapshot {
    return { revision: this.revision, events: this.rows('event'), tasks: this.rows<Task>('task').sort((a,b) => a.order-b.order), projects: this.rows<Snapshot['projects'][number]>('project').sort((a,b) => a.order-b.order), sections: this.rows<Section>('section').sort((a,b) => a.order-b.order), preferences: JSON.parse(this.meta('preferences')), canUndo: !!this.db.prepare('SELECT id FROM history LIMIT 1').get() };
  }
  private savedState(): SavedState { const { events, tasks, projects, sections } = this.snapshot(); return { events, tasks, projects, sections }; }
  private get(entity: Entity, id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT body FROM ${tables[entity]} WHERE id=?`).get(id);
    if (!row) throw new Error(`That ${entity} no longer exists. Refresh and try again.`);
    return JSON.parse(row.body as string);
  }
  private put(entity: Entity, value: Record<string, unknown>): void {
    const body = JSON.stringify(value);
    if (entity === 'section') this.db.prepare('INSERT INTO sections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, body=excluded.body').run(value.id as string, value.projectId as string, body);
    else if (entity === 'task') this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, section_id=excluded.section_id, body=excluded.body').run(value.id as string, value.projectId as string, value.sectionId as string | null, body);
    else this.db.prepare(`INSERT INTO ${tables[entity]} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id as string, body);
  }
  private apply(changes: Change[]): { descriptions: string[]; normalized: Change[] } {
    const descriptions: string[] = [], normalized: Change[] = [];
    for (const change of changes) {
      const { action, entity } = change;
      const id = change.id ?? (action === 'create' ? randomUUID() : '');
      if (!id) throw new Error('An existing item ID is required.');
      if (id === 'inbox' && entity === 'project' && action !== 'create') throw new Error('Inbox is the permanent home for unassigned tasks.');
      const old = action === 'create' ? null : this.get(entity, id);
      if (action === 'delete') {
        if (change.fields && Object.keys(change.fields).length) throw new Error('Delete operations cannot contain fields.');
        if (entity === 'project' || entity === 'section') {
          for (const task of this.rows<Task>('task')) {
            if ((entity === 'project' && task.projectId === id) || (entity === 'section' && task.sectionId === id)) this.put('task', { ...task, projectId: 'inbox', sectionId: null });
          }
          if (entity === 'project') this.db.prepare('DELETE FROM sections WHERE project_id=?').run(id);
        }
        this.db.prepare(`DELETE FROM ${tables[entity]} WHERE id=?`).run(id);
        descriptions.push(`Deleted ${entity}: ${old!.title}`);
        normalized.push({ ...change, id });
        continue;
      }
      if (action === 'create' && this.db.prepare(`SELECT id FROM ${tables[entity]} WHERE id=?`).get(id)) throw new Error('That item ID already exists.');
      if (!change.fields || Object.keys(change.fields).length === 0) throw new Error('Supply the fields to change.');
      const defaults = entity === 'event' ? { notes: '', color: 'coral', startTime: null, endTime: null, endDate: change.fields.startDate }
        : entity === 'task' ? { notes: '', color: 'sage', dueDate: null, completed: false, projectId: 'inbox', sectionId: null, order: this.rows<Task>('task').reduce((n,t) => Math.max(n,t.order + 1),0) }
        : { order: this.rows<{order:number}>(entity).reduce((n,t) => Math.max(n,t.order + 1),0) };
      // Parse the supplied keys separately: an unexpected key must never reach persistence.
      const schema = entity === 'event' ? eventFields : entity === 'task' ? taskFields : entity === 'project' ? projectFields : sectionFields;
      schema.partial().parse(change.fields);
      const { id: _oldId, ...oldFields } = old ?? {};
      const patch = { ...change.fields };
      if (entity === 'event' && old && patch.startDate !== undefined && patch.endDate === undefined) patch.endDate = shiftDate(old.endDate as string, daysBetween(old.startDate as string, patch.startDate as string));
      const value = { id, ...schema.parse({ ...defaults, ...oldFields, ...patch }) } as Record<string, unknown>;
      if (entity === 'event') {
        const ev = value as unknown as EventItem;
        if (ev.endDate < ev.startDate) throw new Error('The event end date must be on or after its start date.');
        if (ev.endTime && !ev.startTime) throw new Error('Add a start time before an end time.');
        if (ev.startDate === ev.endDate && ev.startTime && ev.endTime && ev.endTime < ev.startTime) throw new Error('The end time must be after the start time.');
      }
      if (entity === 'section') {
        this.get('project', value.projectId as string);
        if (old && old.projectId !== value.projectId) for (const task of this.rows<Task>('task')) if (task.sectionId === id) this.put('task', { ...task, projectId: value.projectId });
      }
      if (entity === 'task') {
        this.get('project', value.projectId as string);
        if (value.sectionId && this.get('section', value.sectionId as string).projectId !== value.projectId) throw new Error('The selected section belongs to a different project.');
      }
      this.put(entity, value);
      const verb = entity === 'task' && action === 'update' && change.fields.completed !== undefined ? (value.completed ? 'Completed' : 'Reopened') : action === 'create' ? 'Added' : 'Updated';
      const readable = (date: string) => `${shortDate(date)} ${date.slice(0,4)}`;
      const detail = entity === 'event' ? ` · ${readable(value.startDate as string)}${value.endDate !== value.startDate ? ` → ${readable(value.endDate as string)}` : ''}${value.startTime ? `, ${value.startTime}${value.endTime ? `–${value.endTime}` : ''}` : ''}` : entity === 'task' && value.dueDate && verb !== 'Completed' && verb !== 'Reopened' ? ` · due ${readable(value.dueDate as string)}` : '';
      descriptions.push(`${verb} ${entity}: ${value.title}${detail}`);
      normalized.push({ ...change, id });
    }
    return { descriptions, normalized };
  }
  preview(changes: Change[], expectedRevision: number): { descriptions: string[]; changes: Change[] } {
    mutationSchema.parse({ changes, label: 'Preview', expectedRevision, requestId: 'preview' });
    if (expectedRevision !== this.revision) throw new Error('Your planner changed while the assistant was working. Please send the request again.');
    this.db.exec('BEGIN');
    try { const result = this.apply(changes); return { descriptions: result.descriptions, changes: result.normalized }; }
    finally { this.db.exec('ROLLBACK'); }
  }
  receipt(requestId: string): Receipt | undefined { const row = this.db.prepare('SELECT receipt FROM requests WHERE id=?').get(requestId); return row ? JSON.parse(row.receipt as string) : undefined; }
  mutate(input: Mutation): Receipt {
    const parsed = mutationSchema.parse(input);
    const existing = this.receipt(parsed.requestId); if (existing) return existing;
    if (parsed.expectedRevision !== this.revision) throw new Error('Your planner changed. Please try again with the latest entries.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.savedState(), { descriptions } = this.apply(parsed.changes), revision = this.revision + 1;
      this.setMeta('revision', String(revision));
      const receipt: Receipt = { label: parsed.label, descriptions, revision };
      this.db.prepare('INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)').run(parsed.label, JSON.stringify(before), JSON.stringify(descriptions));
      this.db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)');
      this.db.prepare('INSERT INTO requests VALUES (?,?)').run(parsed.requestId, JSON.stringify(receipt));
      this.db.exec('COMMIT'); return receipt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  undo(): Receipt {
    const row = this.db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 1').get();
    if (!row) throw new Error('There are no changes to undo.');
    const state = JSON.parse(row.before_state as string) as SavedState;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM tasks; DELETE FROM sections; DELETE FROM projects; DELETE FROM events;');
      for (const project of state.projects) this.put('project', { ...project });
      for (const section of state.sections) this.put('section', { ...section });
      for (const ev of state.events) this.put('event', { ...ev });
      for (const task of state.tasks) this.put('task', { ...task });
      this.db.prepare('DELETE FROM history WHERE id=?').run(row.id!);
      const revision = this.revision + 1; this.setMeta('revision', String(revision));
      this.db.exec('COMMIT'); return { label: `Undid ${row.label}`, descriptions: [`Restored the planner before ${row.label}`], revision };
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  preferences(input: Partial<Preferences>): void { const parsed = preferenceSchema.parse(input); this.setMeta('preferences', JSON.stringify({ ...JSON.parse(this.meta('preferences')), ...parsed })); }
  close(): void { this.db.close(); }
}
