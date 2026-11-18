import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync,existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApplyDraftInput, AssistantViewAction, Change, ChatInput, ChatResult, DraftItem, Entity, EventItem, Mutation, Preferences, Receipt, Section, Snapshot, Task, UndoActionInput } from '../shared/model';
import { categoryFields,eventFields, mutationSchema, preferenceSchema, projectFields, sectionFields, taskFields } from '../shared/validation';
import {categorizeChanges,inferCategory,normalizeCategory} from './categories';
import { todayIn, daysBetween, shiftDate, shortDate } from '../shared/dates';
import {calendarCompletionChanges,eventCompletion} from '../shared/calendar';
import {validateTaskGraph} from '../shared/tasks';
import {ActionJournal, actionCollections, actionEffects} from './action-journal';

const tables: Record<Entity, string> = { event: 'events', task: 'tasks', project: 'projects', section: 'sections',category:'categories' };
export interface UndoToken { readonly kind:'trusted-undo'; }
export interface RestoreToken { readonly kind:'trusted-restore'; }
export interface CompiledBatch { readonly changes:Change[]; readonly projectedSnapshot:Snapshot; readonly descriptions:string[]; readonly items:DraftItem[]; }
type SavedState = Pick<Snapshot, 'events' | 'tasks' | 'projects' | 'sections'|'categories'>;
export interface AppliedChat {chatRequestId:string;content:string;viewActions?:AssistantViewAction[];}
export class PlannerDatabase {
  readonly db: DatabaseSync;
  private readonly chatJournal:ActionJournal;
  private previewClock?:Date;
  private undoTokens=new WeakMap<UndoToken,{id:number;revision:number;state:SavedState;label:string}>();
  private restoreTokens=new WeakMap<RestoreToken,{entity:'task'|'event';record:Record<string,unknown>}>();
  private compiled=new WeakMap<CompiledBatch,{state:SavedState;revision:number;undo?:UndoToken;descriptions:string[];items:DraftItem[]}>();
  constructor(path: string,private readonly now:()=>Date=()=>new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 10) throw new Error('This planner database needs a newer version of MYMIND.');
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
    if(version<2){
      // VACUUM INTO includes committed WAL data; a plain file copy would not.
      if(version===1&&path!==':memory:'&&!existsSync(`${path}.v1-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v1-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec("CREATE TABLE categories(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE UNIQUE INDEX categories_title ON categories(lower(trim(json_extract(body,'$.title'))));");
        for(const entity of ['event','task'] as const)for(const item of this.rows<any>(entity))this.put(entity,{...item,categoryId:null,colorOverride:item.color});
        this.db.exec('PRAGMA user_version=2; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
      if(version<3){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v2-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v2-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        for(const task of this.rows<any>('task'))this.put('task',{...task,scheduledDate:task.scheduledDate??task.dueDate??null});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all()){
          const state=JSON.parse(row.before_state as string);
          state.tasks=state.tasks.map((task:any)=>({...task,scheduledDate:task.scheduledDate===undefined?task.dueDate??null:task.scheduledDate}));
          this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);
        }
        this.db.exec('PRAGMA user_version=3; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<4){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v3-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v3-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        for(const task of this.rows<any>('task'))this.put('task',{...task,steps:task.steps??[],dependsOnIds:task.dependsOnIds??[]});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all()){
          const state=JSON.parse(row.before_state as string);
          state.tasks=state.tasks.map((task:any)=>({...task,steps:task.steps??[],dependsOnIds:task.dependsOnIds??[]}));
          this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);
        }
        this.db.exec('PRAGMA user_version=4; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
      if(version<5){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v4-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v4-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        for(const event of this.rows<EventItem>('event'))this.put('event',{...event,linkedTaskId:null});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all()){
          const state=JSON.parse(row.before_state as string);
          state.events=state.events.map((event:EventItem)=>({...event,linkedTaskId:null}));
          this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(state),row.id as number);
        }
        this.db.exec('PRAGMA user_version=5; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<6){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v5-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v5-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const normalize=(state:SavedState)=>{
          state.tasks=state.tasks.map(task=>({...task,createdAt:task.createdAt??null,completedAt:task.completedAt??null}));
          state.events=state.events.map(event=>({...event,completed:event.linkedTaskId?state.tasks.find(t=>t.id===event.linkedTaskId)?.completed??false:event.completed??false}));
          return state;
        };
        const state=normalize(this.savedState());
        for(const task of state.tasks)this.put('task',{...task});
        for(const event of state.events)this.put('event',{...event});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all())this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(normalize(JSON.parse(row.before_state as string))),row.id as number);
        this.db.exec('PRAGMA user_version=6; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<7){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v6-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v6-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const normalize=(state:SavedState)=>({...state,
          tasks:state.tasks.map(task=>({...task,textBox:task.textBox??''})),
          events:state.events.map(event=>({...event,textBox:event.textBox??''}))});
        const state=normalize(this.savedState());
        for(const task of state.tasks)this.put('task',{...task});
        for(const event of state.events)this.put('event',{...event});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all())this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(normalize(JSON.parse(row.before_state as string))),row.id as number);
        this.db.exec('PRAGMA user_version=7; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<8){
      // Back up committed WAL pages before reconciling legacy independent dates.
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v7-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v7-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const normalize=(state:SavedState):SavedState=>({...state,tasks:state.tasks.map(task=>{
          const event=state.events.find(item=>item.linkedTaskId===task.id);
          const placement=event?.startDate??task.scheduledDate??null;
          return {...task,dueDate:task.dueDate??null,scheduledDate:placement};
        })});
        const state=normalize(this.savedState());
        for(const task of state.tasks)this.put('task',{...task});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all())this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(normalize(JSON.parse(row.before_state as string))),row.id as number);
        this.db.exec('PRAGMA user_version=8; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<9){
      // VACUUM INTO sees committed WAL pages. Do this before modifying saved state/history.
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v8-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v8-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const normalize=(state:SavedState):SavedState=>{
          const events=state.events.map(event=>({...event,kind:event.kind??'planned',linkedStepId:event.linkedStepId??null}));
          for(const task of state.tasks)if(task.scheduledDate&&!events.some(event=>event.linkedTaskId===task.id)){
            // A deterministic ID gives each legacy placement one durable identity, including Undo.
            let id=`legacy-session:${task.id}`;while(events.some(event=>event.id===id))id+=':legacy';
            events.push({id,kind:'planned',linkedTaskId:task.id,linkedStepId:null,completed:false,title:task.title,notes:task.notes,textBox:task.textBox??'',categoryId:task.categoryId,colorOverride:task.colorOverride,color:task.color,startDate:task.scheduledDate,endDate:task.scheduledDate,startTime:null,endTime:null});
          }
          return {...state,events,categories:(state.categories??[]).map(normalizeCategory)};
        };
        const state=normalize({...this.savedState(),events:this.rows<EventItem>('event')});
        for(const event of state.events)this.put('event',{...event});
        for(const category of state.categories)this.put('category',{...category});
        for(const row of this.db.prepare('SELECT id,before_state FROM history').all())this.db.prepare('UPDATE history SET before_state=? WHERE id=?').run(JSON.stringify(normalize(JSON.parse(row.before_state as string))),row.id as number);
        this.db.exec('PRAGMA user_version=9; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    if(version<10){
      if(version>0&&path!==':memory:'&&!existsSync(`${path}.v9-backup`))this.db.prepare('VACUUM INTO ?').run(`${path}.v9-backup`);
      this.db.exec('BEGIN IMMEDIATE');
      try{
        ActionJournal.migrate(this.db);
        for(const task of this.rows<Task>('task'))this.put('task',{...task});
        this.db.exec('PRAGMA user_version=10; COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    this.chatJournal=new ActionJournal(this.db);
  }
  private meta(key: string): string { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string }).value; }
  private setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  get revision(): number { return Number(this.meta('revision')); }
  private rows<T>(entity: Entity): T[] { return this.db.prepare(`SELECT body FROM ${tables[entity]} ORDER BY rowid`).all().map(row => JSON.parse(row.body as string) as T); }
  snapshot(): Snapshot {
    const tasks=this.rows<Task>('task').sort((a,b)=>a.order-b.order);
    return { revision: this.revision, events: this.rows<EventItem>('event').map(event=>({...event,completed:eventCompletion(event,tasks)??false})), tasks, projects: this.rows<Snapshot['projects'][number]>('project').sort((a,b) => a.order-b.order), sections: this.rows<Section>('section').sort((a,b) => a.order-b.order),categories:this.rows('category'), preferences: {appearance:'light',...JSON.parse(this.meta('preferences'))}, canUndo: !!this.db.prepare('SELECT id FROM history LIMIT 1').get() };
  }
  private savedState(): SavedState { const { events, tasks, projects, sections,categories } = this.snapshot(); return { events, tasks, projects, sections,categories }; }
  private actionState():SavedState {
    return {events:this.rows('event'),tasks:this.rows('task'),projects:this.rows('project'),sections:this.rows('section'),categories:this.rows('category')};
  }
  private get(entity: Entity, id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT body FROM ${tables[entity]} WHERE id=?`).get(id);
    if (!row) throw new Error(`That ${entity} no longer exists. Refresh and try again.`);
    return JSON.parse(row.body as string);
  }
  private put(entity: Entity, value: Record<string, unknown>): void {
    if(entity==='task')value={createdAt:null,completedAt:null,priority:'',estimate:'',steps:[],dependsOnIds:[],...value};
    if(entity==='event')value={kind:'planned',linkedStepId:null,completed:false,linkedTaskId:null,...value};
    if(entity==='task'&&value.scheduledDate===undefined)value={...value,scheduledDate:null};
    if(entity==='task'||entity==='event')value={categoryId:null,colorOverride:value.color,...value};
    const body = JSON.stringify(value);
    if (entity === 'section') this.db.prepare('INSERT INTO sections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, body=excluded.body').run(value.id as string, value.projectId as string, body);
    else if (entity === 'task') this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, section_id=excluded.section_id, body=excluded.body').run(value.id as string, value.projectId as string, value.sectionId as string | null, body);
    else this.db.prepare(`INSERT INTO ${tables[entity]} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id as string, body);
  }
  private applyDirect(changes: Change[]): { descriptions: string[]; normalized: Change[] } {
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
        if(entity==='category')for(const kind of ['task','event'] as const)for(const item of this.rows<any>(kind))if(item.categoryId===id)this.put(kind,{...item,categoryId:null,colorOverride:item.color});
        if(entity==='task')for(const task of this.rows<Task>('task'))if(task.id!==id&&task.dependsOnIds.includes(id)){
          this.put('task',{...task,dependsOnIds:task.dependsOnIds.filter(ref=>ref!==id)});
          descriptions.push(`Updated task: ${task.title} · removed prerequisite ${old!.title}`);
        }
        this.db.prepare(`DELETE FROM ${tables[entity]} WHERE id=?`).run(id);
        descriptions.push(`Deleted ${entity}: ${old!.title}`);
        normalized.push({ ...change, id });
        continue;
      }
      if (action === 'create' && this.db.prepare(`SELECT id FROM ${tables[entity]} WHERE id=?`).get(id)) throw new Error('That item ID already exists.');
      if (!change.fields || Object.keys(change.fields).length === 0) throw new Error('Supply the fields to change.');
      const defaults = entity === 'event' ? { kind:'planned', linkedStepId:null, completed:false, linkedTaskId:null, notes: '', textBox:'', color: 'coral',categoryId:null,colorOverride:null, startTime: null, endTime: null, endDate: change.fields.startDate }
        : entity === 'task' ? { notes: '', textBox:'', color: 'sage',categoryId:null,colorOverride:null, dueDate: null, scheduledDate:null, completed: false, projectId: 'inbox', sectionId: null, steps:[],dependsOnIds:[],order: this.rows<Task>('task').reduce((n,t) => Math.max(n,t.order + 1),0) }
        : entity==='category'?{color:'sky'}:{ order: this.rows<{order:number}>(entity).reduce((n,t) => Math.max(n,t.order + 1),0) };
      // Parse the supplied keys separately: an unexpected key must never reach persistence.
      const schema = entity === 'event' ? eventFields : entity === 'task' ? taskFields : entity === 'project' ? projectFields : entity==='category'?categoryFields:sectionFields;
      schema.partial().parse(change.fields);
      const { id: _oldId, createdAt: _createdAt, completedAt: _completedAt, ...oldFields } = old ?? {};
      const patch = { ...change.fields };
      if (entity === 'event' && old && patch.startDate !== undefined && patch.endDate === undefined) patch.endDate = shiftDate(old.endDate as string, daysBetween(old.startDate as string, patch.startDate as string));
      const value = { id, ...schema.parse({ ...defaults, ...oldFields, ...patch }) } as Record<string, unknown>;
      if(entity==='task'){
        value.createdAt=old?old.createdAt??null:(this.previewClock??this.now()).toISOString();
        value.completedAt=value.completed?(old?.completed?old.completedAt??null:(this.previewClock??this.now()).toISOString()):null;
      }
      if(entity==='event'||entity==='task'){
        const category=value.categoryId?this.get('category',value.categoryId as string):undefined;
        if(value.colorOverride)value.color=value.colorOverride;
        else if(category)value.color=category.color;
      }
      if(entity==='category'&&old&&value.color!==old.color)for(const kind of ['task','event'] as const)for(const item of this.rows<any>(kind))if(item.categoryId===id&&!item.colorOverride)this.put(kind,{...item,color:value.color});
      if (entity === 'event') {
        const ev = value as unknown as EventItem;
        if (ev.endDate < ev.startDate) throw new Error('The event end date must be on or after its start date.');
        if (ev.endTime && !ev.startTime) throw new Error('Add a start time before an end time.');
        if (ev.startDate === ev.endDate && ev.startTime && ev.endTime && ev.endTime <= ev.startTime) throw new Error('The end time must be after the start time.');
      }
      if (entity === 'section') {
        this.get('project', value.projectId as string);
        if (old && old.projectId !== value.projectId) for (const task of this.rows<Task>('task')) if (task.sectionId === id) this.put('task', { ...task, projectId: value.projectId });
      }
      if (entity === 'task') {
        this.get('project', value.projectId as string);
        if (value.sectionId && this.get('section', value.sectionId as string).projectId !== value.projectId) throw new Error('The selected section belongs to a different project.');
      }
      if(entity==='category'){
        const category=normalizeCategory(value as unknown as Snapshot['categories'][number]);
        value.semanticKey=old?.semanticKey??category.semanticKey;
        value.aliases=[...new Set([...(old?.aliases as string[]??[]),...(category.aliases??[]),...(old?[String(old.title).trim().toLowerCase()]:[])])];
      }
      this.put(entity, value);
      const verb = (entity === 'task'||entity==='event') && action === 'update' && change.fields.completed !== undefined ? (value.completed ? 'Completed' : 'Reopened') : action === 'create' ? 'Added' : 'Updated';
      const readable = (date: string) => `${shortDate(date)} ${date.slice(0,4)}`;
      const detail = entity === 'event' ? ` · Date ${readable(value.startDate as string)}${value.endDate !== value.startDate ? ` → ${readable(value.endDate as string)}` : ''}${value.startTime ? `, ${value.startTime}${value.endTime ? `–${value.endTime}` : ''}` : ''}` : entity === 'task' && value.dueDate ? ` · Date ${readable(value.dueDate as string)}` : '';
      const scheduleDetail=entity==='task'&&value.scheduledDate?' · on Calendar':'';
      const categoryDetail=(entity==='event'||entity==='task')&&value.categoryId&&(action==='create'||change.fields.categoryId!==undefined)?` · ${this.get('category',value.categoryId as string).title}`:'';
      descriptions.push(`${verb} ${entity}: ${value.title}${detail}${scheduleDetail}${categoryDetail}`);
      normalized.push({ ...change, id, fields:patch });
    }
    validateTaskGraph(this.rows<Task>('task'));
    return { descriptions, normalized };
  }
  // Sessions own their content and placement; links carry identity and completion only.
  private apply(changes:Change[]):{descriptions:string[];normalized:Change[]}{
    const before=this.snapshot();
    // Compatibility for the old event checkbox: route to the same task/step helper used by new UI.
    const completion:{id:string;completed:boolean}[]=[];
    changes=changes.map(change=>{
      if(change.entity!=='event'||change.action==='delete'||change.fields?.completed===undefined)return change;
      eventFields.partial().parse(change.fields);
      const fields={...change.fields},completed=Boolean(fields.completed);delete fields.completed;
      const existing=before.events.find(event=>event.id===change.id);
      if(existing)completion.push({id:existing.id,completed});
      // Creates do not complete linked work as a side effect of logging an activity.
      return {...change,fields};
    }).filter(change=>change.action==='delete'||!change.fields||Object.keys(change.fields).length>0);
    const result=this.applyDirect(changes);
    for(const intent of completion){
      const routed=this.applyDirect(calendarCompletionChanges(this.snapshot(),{id:intent.id,entryType:'session'},intent.completed));
      result.descriptions.push(...routed.descriptions);result.normalized.push(...routed.normalized);
    }
    const after=this.snapshot(),sync:Change[]=[];
    const deleted=(entity:Entity,id:string)=>changes.some(c=>c.entity===entity&&c.id===id&&c.action==='delete');
    for(const event of after.events){
      if(event.linkedStepId&&!event.linkedTaskId)throw new Error('A linked step requires a linked task.');
      if(!event.linkedTaskId)continue;
      const task=after.tasks.find(task=>task.id===event.linkedTaskId);
      if(!task){
        if(!deleted('task',event.linkedTaskId))throw new Error('The linked task does not exist.');
        sync.push({action:'update',entity:'event',id:event.id,fields:{linkedTaskId:null,linkedStepId:null}});continue;
      }
      if(event.linkedStepId&&!task.steps.some(step=>step.id===event.linkedStepId)){
        const previous=before.tasks.find(t=>t.id===task.id),oldEvent=before.events.find(e=>e.id===event.id);
        if(!previous?.steps.some(step=>step.id===event.linkedStepId)||oldEvent?.linkedStepId!==event.linkedStepId)throw new Error('The linked step does not exist on that task.');
        sync.push({action:'update',entity:'event',id:event.id,fields:{linkedStepId:null}});
      }
    }
    // Transitional scheduledDate input only materializes missing placement. It never edits
    // existing sessions, mirrors notes, deletes blocks, or changes an independent dueDate.
    const legacyPlacements=new Set(result.normalized.filter(change=>change.entity==='task'&&change.action!=='delete'&&change.fields?.scheduledDate).map(change=>change.id));
    for(const id of legacyPlacements){
      const task=after.tasks.find(task=>task.id===id);
      if(task?.scheduledDate&&!after.events.some(event=>event.linkedTaskId===task.id))sync.push({action:'create',entity:'event',id:randomUUID(),fields:{kind:'planned',linkedTaskId:task.id,linkedStepId:null,title:task.title,notes:task.notes,textBox:task.textBox,categoryId:task.categoryId,colorOverride:task.colorOverride,color:task.color,startDate:task.scheduledDate,endDate:task.scheduledDate,startTime:null,endTime:null}});
    }
    if(sync.length){const extra=this.applyDirect(sync);result.descriptions.push(...extra.descriptions);result.normalized.push(...extra.normalized);}
    // A replayable preview has one final patch per identity; later corrections must
    // not compete with stale intermediate step arrays from this same batch.
    const combined=new Map<string,Change>();
    for(const change of result.normalized){
      const key=`${change.entity}:${change.id}`,previous=combined.get(key);
      combined.set(key,previous&&change.action==='update'?{...previous,fields:{...previous.fields,...change.fields}}:change);
    }
    result.normalized=[...combined.values()];
    return result;
  }
  private replaceSavedState(state:SavedState):void {
    this.db.exec('DELETE FROM tasks; DELETE FROM sections; DELETE FROM projects; DELETE FROM events; DELETE FROM categories;');
    for(const category of state.categories??[])this.put('category',{...category});
    for(const project of state.projects)this.put('project',{...project});
    for(const section of state.sections)this.put('section',{...section});
    for(const event of state.events)this.put('event',{...event});
    for(const task of state.tasks)this.put('task',{...task});
  }
  captureUndo(expectedRevision:number):UndoToken {
    if(expectedRevision!==this.revision)throw new Error('A later change exists. Re-preview the original Undo; it cannot target a different batch.');
    const row=this.db.prepare('SELECT id,label,before_state FROM history ORDER BY id DESC LIMIT 1').get();
    if(!row)throw new Error('There are no changes to undo.');
    const token:UndoToken=Object.freeze({kind:'trusted-undo'});
    this.undoTokens.set(token,{id:Number(row.id),revision:expectedRevision,state:JSON.parse(String(row.before_state)),label:String(row.label)});return token;
  }
  private validatedUndo(token:UndoToken){
    const value=this.undoTokens.get(token),head=this.db.prepare('SELECT id FROM history ORDER BY id DESC LIMIT 1').get();
    if(!value||value.revision!==this.revision||Number(head?.id)!==value.id)throw new Error('The original Undo is no longer the latest batch. Dismiss this proposal; Undo cannot be retargeted.');
    return value;
  }
  captureRestore(entity:'task'|'event',id:string):RestoreToken {
    const token:RestoreToken=Object.freeze({kind:'trusted-restore'});this.restoreTokens.set(token,{entity,record:structuredClone(this.get(entity,id))});return token;
  }
  previewBatch(input:{expectedRevision:number;changes:Change[];undo?:UndoToken;restores?:RestoreToken[];clock?:Date}):CompiledBatch {
    if(input.expectedRevision!==this.revision)throw new Error('Your planner changed. Re-preview this draft before Apply.');
    const undo=input.undo?this.validatedUndo(input.undo):undefined;
    const before=this.actionState(),priorClock=this.previewClock;this.previewClock=input.clock??this.now();this.db.exec('BEGIN');
    try{
      if(undo)this.replaceSavedState(undo.state);
      for(const token of input.restores??[]){const restore=this.restoreTokens.get(token);if(!restore)throw new Error('Untrusted restoration.');this.put(restore.entity,structuredClone(restore.record));}
      const result=this.apply(categorizeChanges(this.snapshot(),input.changes));
      const state=this.actionState(),items:DraftItem[]=[];
      for(const entity of Object.keys(tables) as Entity[]){const name=entity==='category'?'categories':`${entity}s`;const previous=before[name as keyof SavedState] as unknown as Record<string,unknown>[],next=state[name as keyof SavedState] as unknown as Record<string,unknown>[];
        for(const id of new Set([...previous,...next].map(item=>String(item.id)))){const a=previous.find(item=>item.id===id),b=next.find(item=>item.id===id);if(JSON.stringify(a)===JSON.stringify(b))continue;items.push({entity,id,title:String(b?.title??a?.title??'Item'),action:!b?'delete':!a?(undo||input.restores?.length?'restore':'create'):'update',...(a?{before:structuredClone(a)}:{}),...(b?{after:structuredClone(b)}:{})});}
      }
      if(undo)items.unshift({id:`undo:${undo.id}`,entity:'project',action:'undo',title:`Undo ${undo.label}`});
      const descriptions=[...(undo?[`Proposed Undo: ${undo.label}`]:[]),...result.descriptions];
      const batch:CompiledBatch={changes:structuredClone(result.normalized),projectedSnapshot:structuredClone(this.snapshot()),descriptions:structuredClone(descriptions),items:structuredClone(items)};
      this.compiled.set(batch,{state:structuredClone(state),revision:input.expectedRevision,undo:input.undo,descriptions,items});return batch;
    }finally{this.db.exec('ROLLBACK');this.previewClock=priorClock;}
  }
  draftReceipt(input:Pick<ApplyDraftInput,'draftId'|'version'|'expectedRevision'>):Receipt|undefined {
    const saved=this.receipt(`draft:${input.draftId}:${input.version}`);
    if(saved&&saved.draft?.baseRevision!==input.expectedRevision)throw new Error('That Apply retry does not match the accepted draft revision.');return saved;
  }
  applyBatch(batch:CompiledBatch,input:ApplyDraftInput,chat?:AppliedChat):Receipt {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const completed=chat&&this.chatJournal.result(chat.chatRequestId);
      if(completed){
        if(!completed.receipt)throw new Error('This chat request is already finished.');
        this.db.exec('COMMIT');return completed.receipt;
      }
      const existing=this.draftReceipt(input);if(existing){this.db.exec('COMMIT');return existing;}
      const compiled=this.compiled.get(batch);if(!compiled)throw new Error('Untrusted draft state.');
      if(compiled.revision!==input.expectedRevision||this.revision!==input.expectedRevision)throw new Error('Your planner changed. Re-preview this draft before Apply.');
      if(compiled.undo)this.validatedUndo(compiled.undo);
      const before=this.actionState();this.replaceSavedState(compiled.state);
      const revision=this.revision+1;this.setMeta('revision',String(revision));
      const receipt:Receipt={label:compiled.undo?'Assistant Undo and changes':'Assistant changes',revision,descriptions:compiled.descriptions,items:compiled.items.filter(item=>item.action!=='undo').map(item=>({id:item.id,entity:item.entity,action:item.action==='restore'?'create':item.action as Change['action'],title:item.title})),draft:{id:input.draftId,version:input.version,baseRevision:input.expectedRevision}};
      this.db.prepare('INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)').run(receipt.label,JSON.stringify(before),JSON.stringify(receipt.descriptions));
      this.db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)');
      this.db.prepare('INSERT INTO requests VALUES (?,?)').run(`draft:${input.draftId}:${input.version}`,JSON.stringify(receipt));
      const after=this.actionState();
      if(chat){
        receipt.actions=this.chatJournal.capture(chat.chatRequestId,before,after,revision);
        this.chatJournal.finish(chat.chatRequestId,{content:chat.content,receipt,viewActions:chat.viewActions});
      }else this.chatJournal.track(actionEffects(before,after),revision);
      this.db.exec('COMMIT');return receipt;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  preview(changes: Change[], expectedRevision: number): { descriptions: string[]; changes: Change[] } {
    mutationSchema.parse({ changes, label: 'Preview', expectedRevision, requestId: 'preview' });
    if (expectedRevision !== this.revision) throw new Error('Your planner changed while the assistant was working. Please send the request again.');
    this.db.exec('BEGIN');
    try { const result = this.apply(categorizeChanges(this.snapshot(),changes)); return { descriptions: result.descriptions, changes: result.normalized }; }
    finally { this.db.exec('ROLLBACK'); }
  }
  receipt(requestId: string): Receipt | undefined { const row = this.db.prepare('SELECT receipt FROM requests WHERE id=?').get(requestId); return row ? JSON.parse(row.receipt as string) : undefined; }
  clearTasksAndEvents(requestId:string):Receipt|undefined{
    const existing=this.receipt(requestId);if(existing)return existing;
    const state=this.snapshot();
    const changes:Change[]=[...state.events.map(event=>({action:'delete' as const,entity:'event' as const,id:event.id})),...state.tasks.map(task=>({action:'delete' as const,entity:'task' as const,id:task.id}))];
    if(!changes.length)return undefined;
    return this.mutate({changes,label:'Clear all tasks and events',expectedRevision:state.revision,requestId});
  }
  mutate(input: Mutation): Receipt {
    const parsed = mutationSchema.parse(input);
    const existing = this.receipt(parsed.requestId); if (existing) return existing;
    if (parsed.expectedRevision !== this.revision) throw new Error('Your planner changed. Please try again with the latest entries.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.actionState(), { descriptions,normalized } = this.apply(categorizeChanges(this.snapshot(),parsed.changes)), revision = this.revision + 1;
      this.setMeta('revision', String(revision));
      const receipt: Receipt = { label: parsed.label, descriptions, revision,items:normalized.map(change=>({id:change.id!,entity:change.entity,action:change.action,title:String(change.action==='delete'?(before[`${change.entity==='category'?'categorie':change.entity}s` as keyof SavedState] as {id:string;title:string}[]|undefined)?.find(item=>item.id===change.id)?.title??'Item':this.get(change.entity,change.id!).title)})) };
      this.db.prepare('INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)').run(parsed.label, JSON.stringify(before), JSON.stringify(descriptions));
      this.db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)');
      this.db.prepare('INSERT INTO requests VALUES (?,?)').run(parsed.requestId, JSON.stringify(receipt));
      this.chatJournal.track(actionEffects(before,this.actionState()),revision);
      this.db.exec('COMMIT'); return receipt;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  undo(expectedRevision?:number,requestId?:string): Receipt {
    if(requestId){const existing=this.receipt(requestId);if(existing)return existing;}
    if(expectedRevision!==undefined&&expectedRevision!==this.revision)throw new Error('A later change exists. Use the current Undo control.');
    const row = this.db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 1').get();
    if (!row) throw new Error('There are no changes to undo.');
    const state = JSON.parse(row.before_state as string) as SavedState;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before=this.actionState();
      this.replaceSavedState(state);
      this.db.prepare('DELETE FROM history WHERE id=?').run(row.id!);
      const revision = this.revision + 1; this.setMeta('revision', String(revision));
      this.chatJournal.track(actionEffects(before,this.actionState()),revision);
      const receipt={ label: `Undid ${row.label}`, descriptions: [`Restored the planner before ${row.label}`], revision };
      if(requestId)this.db.prepare('INSERT INTO requests VALUES (?,?)').run(requestId,JSON.stringify(receipt));
      this.db.exec('COMMIT'); return receipt;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  beginChat(input:ChatInput){this.chatJournal.begin(input);}
  chatResult(requestId:string){return this.chatJournal.result(requestId);}
  finishChat(requestId:string,result:ChatResult){return this.chatJournal.finish(requestId,result);}
  chatHistory(){return this.chatJournal.history();}
  recoverChat(){this.chatJournal.recover();}
  clearChat(){this.chatJournal.clear();this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}

  seedBloomCategories():void {
    if(this.revision!==0||this.rows('category').length)return;
    const definitions=[['personal','Personal','rose'],['projects','Projects','lavender'],['career','Career Applications','amber'],
      ['communication','Communication','sky'],['events','Events','coral'],['focus','Focus / Study','sage']] as const;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const [id,title,color] of definitions)this.put('category',normalizeCategory({id,title,color}));
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  undoAction({actionId}:UndoActionInput){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const card=this.chatJournal.card(actionId);
      if(card.receipt.undone){this.db.exec('COMMIT');return card.receipt;}
      const before=this.actionState(),next=this.chatJournal.inverse(card,before);
      const {target,action}=card.receipt;
      if(action==='create'){
        // Apply the established rehome/unlink policy to records added since the original action.
        if(target.entity==='step'){
          const task=next.tasks.find(item=>item.id===target.taskId)!;
          this.apply([{entity:'task',id:task.id,action:'update',fields:{steps:task.steps}}]);
        }else this.apply([{entity:target.entity,id:target.id,action:'delete'}]);
      }else this.writeActionState(before,next);
      const revision=this.revision+1;
      this.setMeta('revision',String(revision));
      const label=`Reversed ${card.receipt.title}`;
      this.db.prepare('INSERT INTO history(label,before_state,descriptions) VALUES (?,?,?)').run(label,JSON.stringify(before),JSON.stringify([label]));
      this.db.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)');
      const receipt=this.chatJournal.reverse(card,before,this.actionState(),revision);
      this.db.exec('COMMIT');return receipt;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  private writeActionState(before:SavedState,next:SavedState):void {
    const projects=new Set(next.projects.map(project=>project.id)),categories=new Set(next.categories.map(category=>category.id));
    const names=new Set(next.categories.map(category=>category.title.trim().toLowerCase()));
    if(names.size!==categories.size)throw new Error('Another category now has that name. Rename it before undoing this action.');
    const sections=new Map(next.sections.map(section=>[section.id,section])),tasks=new Map(next.tasks.map(task=>[task.id,task]));
    const missing=()=>new Error('Undo needs a linked planner item that has changed or is missing.');
    for(const section of next.sections)if(!projects.has(section.projectId))throw missing();
    for(const task of next.tasks){
      if(!projects.has(task.projectId)||task.sectionId&&sections.get(task.sectionId)?.projectId!==task.projectId)throw missing();
      if(task.categoryId&&!categories.has(task.categoryId))throw missing();
      if(task.steps.length>100)throw new Error('Undo would exceed the checklist’s step limit.');
    }
    validateTaskGraph(next.tasks);
    for(const event of next.events){
      if(event.categoryId&&!categories.has(event.categoryId)||event.linkedTaskId&&!tasks.has(event.linkedTaskId)||event.linkedStepId&&!tasks.get(event.linkedTaskId??'')?.steps.some(step=>step.id===event.linkedStepId))throw missing();
      if(event.endDate<event.startDate||event.endTime&&!event.startTime||event.endDate===event.startDate&&event.startTime&&event.endTime&&event.endTime<=event.startTime)throw new Error('Undo would conflict with the block’s current date or time.');
    }
    const order=['category','project','section','task','event'] as const;
    for(const entity of order){
      const collection=actionCollections[entity],previous=new Map(before[collection].map(record=>[record.id,record]));
      for(const record of next[collection])if(JSON.stringify(previous.get(record.id))!==JSON.stringify(record))this.put(entity,{...record});
    }
    for(const entity of [...order].reverse()){
      const collection=actionCollections[entity],remaining=new Set(next[collection].map(record=>record.id));
      for(const record of before[collection])if(!remaining.has(record.id))this.db.prepare(`DELETE FROM ${tables[entity]} WHERE id=?`).run(record.id);
    }
  }
  organizePreview():{changes:Change[];descriptions:string[];revision:number}{
    const state=this.snapshot(),changes:Change[]=[...state.tasks.map(item=>({entity:'task' as const,item})),...state.events.map(item=>({entity:'event' as const,item}))].filter(({item})=>!item.categoryId).map(({entity,item})=>({action:'update',entity,id:item.id,fields:{categoryTitle:inferCategory(item.title,entity),colorOverride:null}}));
    if(!changes.length)return {changes:[],descriptions:[],revision:state.revision};
    const preview=this.preview(changes,state.revision);return {...preview,revision:state.revision};
  }
  preferences(input: Partial<Preferences>): void { const parsed = preferenceSchema.parse(input); this.setMeta('preferences', JSON.stringify({ ...JSON.parse(this.meta('preferences')), ...parsed })); }
  close(): void { this.db.close(); }
}
