import {useRef, useState, type ReactNode} from 'react';
import type {Change, EventItem, Project, Snapshot, Task, TaskStep} from '../shared/model';
import {Icon} from './App';
import {PixelFlower} from './Pixel';
import {Button, Field, Modal, TaskCheck} from './BloomControls';
import {STANDALONE} from './BloomTasks';
import type {BlockSlot} from './BloomCalendar';

export type Editor =
  | ({kind: 'event'; item?: EventItem; task?: Task} & BlockSlot)
  | {kind: 'task'; item?: Task; projectId?: string}
  | {kind: 'project'; item?: Project};

interface CommonProps<T extends Editor> {
  editor: T;
  snapshot: Snapshot;
  busy: boolean;
  error?: string;
  onClose: () => void;
  save: (changes: Change[], label: string, revision?: number) => Promise<boolean>;
  report: (text: string, error?: boolean) => void;
}
interface EditorProps extends CommonProps<Editor> {
  openTask: (task: Task) => void;
  scheduleTask: (task: Task) => void;
}

export function defaultCategory(snapshot: Snapshot) {
  return (snapshot.categories.find(category => category.semanticKey === 'projects' || /^projects?$/i.test(category.title)) ?? snapshot.categories[0])?.id ?? null;
}

function patch<T extends Record<string, unknown>>(previous: T, next: T) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== previous[key]));
}

function EditorFooter({onClose, submit, busy, onDelete, deleteLabel = 'Delete'}: {
  onClose: () => void; submit: string; busy: boolean; onDelete?: () => void; deleteLabel?: string;
}) {
  return <>
    <div className="footer-left">{onDelete && <button type="button" className="delete-btn" disabled={busy} onClick={onDelete}>
      <Icon name="trash" size={15}/> {deleteLabel}
    </button>}</div>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant="primary" type="submit" disabled={busy}>{submit}</Button>
  </>;
}

function CategoryField({id, snapshot, onChange, full}: {
  id: string | null; snapshot: Snapshot; onChange: (id: string | null) => void; full?: boolean;
}) {
  return <Field label="Category" full={full}>
    <select aria-label="Category" value={id ?? ''} onChange={event => onChange(event.target.value || null)}>
      <option value="">No category</option>
      {snapshot.categories.map(category => <option key={category.id} value={category.id}>{category.title}</option>)}
    </select>
  </Field>;
}

function EventEditor({editor, snapshot, busy, error, onClose, save, report, openTask}: CommonProps<Extract<Editor, {kind: 'event'}>> & {
  openTask: (task: Task) => void;
}) {
  const existing = editor.item;
  const openingRevision = useRef(snapshot.revision);
  const [title, setTitle] = useState(existing?.title ?? editor.task?.title ?? '');
  const [date, setDate] = useState(existing?.startDate ?? editor.date);
  const [category, setCategory] = useState(existing ? existing.categoryId : editor.task?.categoryId ?? defaultCategory(snapshot));
  const [allDay, setAllDay] = useState(existing ? !existing.startTime : editor.allDay ?? false);
  const initialStart = existing?.startTime ?? editor.startTime ?? '10:00';
  const initialEnd = existing?.endTime ?? editor.endTime ?? '11:00';
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [taskId, setTaskId] = useState(existing?.linkedTaskId ?? editor.task?.id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const linkedTask = snapshot.tasks.find(task => task.id === taskId);

  async function submit() {
    const value = title.trim() || linkedTask?.title;
    if (!value) return report('Enter a title for this block', true);
    if (!date) return report('Choose a date for this block', true);
    const timesChanged = !existing || allDay !== !existing.startTime || (!allDay && (start !== initialStart || end !== initialEnd));
    if (!allDay && timesChanged && (!start || !end || end <= start)) return report('End time must be after start time', true);
    const fields = {title: value, startDate: date, categoryId: category, linkedTaskId: taskId || null, notes};
    const times = {startTime: allDay ? null : start, endTime: allDay ? null : end};
    const changes = existing
      ? {
        ...patch({title: existing.title, startDate: existing.startDate, categoryId: existing.categoryId, linkedTaskId: existing.linkedTaskId, notes: existing.notes}, fields),
        ...(timesChanged ? times : {}),
        ...(existing.linkedTaskId !== fields.linkedTaskId ? {linkedStepId: null} : {}),
      }
      : {...fields, ...times, endDate: date};
    if (!Object.keys(changes).length || await save([{
      entity: 'event', action: existing ? 'update' : 'create', id: existing?.id, fields: changes,
    }], existing ? 'Calendar block updated' : 'Calendar block added', openingRevision.current)) onClose();
  }

  async function remove() {
    if (existing && await save([{entity: 'event', action: 'delete', id: existing.id}], 'Calendar block deleted', openingRevision.current)) onClose();
  }

  return <Modal title={existing ? 'Edit calendar block' : 'New calendar block'} onClose={onClose} onSubmit={submit}
    footer={<EditorFooter onClose={onClose} busy={busy} submit={existing ? 'Save changes' : 'Add block'} onDelete={existing ? remove : undefined}/>}>
    <div className="dialog-grid">
      <Field label="Title" full><input data-initial-focus value={title} placeholder="What belongs on your calendar?" onChange={event => setTitle(event.target.value)}/></Field>
      <Field label="Date"><input type="date" value={date} onChange={event => setDate(event.target.value)}/></Field>
      <CategoryField id={category} snapshot={snapshot} onChange={setCategory}/>
      <label className="inline-check full-field"><input type="checkbox" checked={allDay} onChange={event => setAllDay(event.target.checked)}/><span>All-day block</span></label>
      {!allDay && <>
        <Field label="Start time"><input type="time" value={start} onChange={event => setStart(event.target.value)}/></Field>
        <Field label="End time"><input type="time" value={end} onChange={event => setEnd(event.target.value)}/></Field>
      </>}
      <Field label="Linked task (optional)" full>
        <select aria-label="Linked task (optional)" value={taskId} onChange={event => {
          const task = snapshot.tasks.find(item => item.id === event.target.value);
          setTaskId(task?.id ?? '');
          if (task) setTitle(task.title);
        }}>
          <option value="">No linked task</option>
          {snapshot.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </Field>
      {linkedTask && <button type="button" className="linked-task-action full-field" onClick={() => openTask(linkedTask)}>
        <Icon name="link" size={14}/> Open linked task: {linkedTask.title}
      </button>}
      <Field label="Notes" full><textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Add a little detail (optional)"/></Field>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}

function TaskEditor({editor, snapshot, busy, error, onClose, save, report, scheduleTask}: CommonProps<Extract<Editor, {kind: 'task'}>> & {
  scheduleTask: (task: Task) => void;
}) {
  const existing = editor.item;
  const openingRevision = useRef(snapshot.revision);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [projectId, setProject] = useState(existing?.projectId ?? editor.projectId ?? STANDALONE);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? '');
  const [priority, setPriority] = useState<NonNullable<Task['priority']>>(existing?.priority ?? '');
  const [estimate, setEstimate] = useState(existing?.estimate ?? '');
  const [category, setCategory] = useState(existing ? existing.categoryId : (snapshot.categories.find(item => item.semanticKey === 'personal') ?? snapshot.categories[0])?.id ?? null);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [steps, setSteps] = useState(existing?.steps ?? []);

  function changeStep(id: string, fields: Partial<TaskStep>) {
    setSteps(current => current.map(step => step.id === id ? {...step, ...fields} : step));
  }

  async function submit() {
    if (!title.trim()) return report('Enter a task name', true);
    const cleanSteps = steps.filter(step => step.title.trim()).map(step => ({...step, title: step.title.trim()}));
    const fields = {title: title.trim(), projectId, dueDate: dueDate || null, priority, estimate, categoryId: category, notes};
    const changes = existing
      ? {
        ...patch({
          title: existing.title, projectId: existing.projectId, dueDate: existing.dueDate, priority: existing.priority ?? '',
          estimate: existing.estimate ?? '', categoryId: existing.categoryId, notes: existing.notes,
        }, fields),
        ...(existing.projectId !== projectId ? {sectionId: null} : {}),
        ...(JSON.stringify(existing.steps) !== JSON.stringify(cleanSteps) ? {steps: cleanSteps} : {}),
      }
      : {...fields, steps: cleanSteps};
    if (!Object.keys(changes).length || await save([{
      action: existing ? 'update' : 'create', entity: 'task', id: existing?.id, fields: changes,
    }], existing ? 'Task updated' : 'Task added', openingRevision.current)) onClose();
  }

  async function remove() {
    if (existing && await save([{entity: 'task', action: 'delete', id: existing.id}], 'Task deleted; calendar blocks preserved', openingRevision.current)) onClose();
  }

  return <Modal title={existing ? 'Edit task' : 'Create a task'} onClose={onClose} onSubmit={submit}
    footer={<EditorFooter onClose={onClose} busy={busy} submit={existing ? 'Save changes' : 'Add task'} onDelete={existing ? remove : undefined} deleteLabel="Delete task"/>}>
    <div className="dialog-grid">
      <Field label="Task name" full><input data-initial-focus placeholder="e.g. Finish portfolio case study" value={title} onChange={event => setTitle(event.target.value)}/></Field>
      <Field label="Project">
        <select aria-label="Project" value={projectId} onChange={event => setProject(event.target.value)}>
          <option value={STANDALONE}>Standalone task</option>
          {snapshot.projects.filter(project => project.id !== STANDALONE).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </Field>
      <Field label="Due date"><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)}/></Field>
      <Field label="Priority"><select aria-label="Priority" value={priority} onChange={event => setPriority(event.target.value as typeof priority)}>
        <option value="">None</option><option>Low</option><option>Medium</option><option>High</option>
      </select></Field>
      <Field label="Estimate"><input value={estimate} placeholder="e.g. 1h 30m" onChange={event => setEstimate(event.target.value)}/></Field>
      <CategoryField id={category} snapshot={snapshot} onChange={setCategory} full/>
      <Field label="Notes" full><textarea rows={2} placeholder="Anything worth remembering?" value={notes} onChange={event => setNotes(event.target.value)}/></Field>
      <div className="editor-steps full-field">
        <div className="steps-heading"><strong>Checklist steps</strong><span>{steps.length} {steps.length === 1 ? 'step' : 'steps'}</span></div>
        {steps.map((step, index) => <div className="editor-step-row" key={step.id}>
          <TaskCheck checked={step.completed} label={`Complete ${step.title || `step ${index + 1}`}`} onChange={() => changeStep(step.id, {completed: !step.completed})}/>
          <input value={step.title} placeholder={`Step ${index + 1}`} aria-label={`Step ${index + 1}`} onChange={event => changeStep(step.id, {title: event.target.value})}/>
          <button type="button" title="Remove step" className="tiny-action" onClick={() => setSteps(current => current.filter(item => item.id !== step.id))}><Icon name="close" size={16}/></button>
        </div>)}
        <button type="button" className="add-editor-step" onClick={() => setSteps(current => [...current, {id: crypto.randomUUID(), title: '', completed: false}])}>
          <Icon name="plus" size={15}/> Add checklist step
        </button>
      </div>
      {existing && <button type="button" className="linked-task-action full-field" onClick={() => scheduleTask(existing)}>
        <Icon name="calendar" size={15}/> Schedule on Calendar
      </button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}

function ProjectEditor({editor, snapshot, busy, error, onClose, save, report}: CommonProps<Extract<Editor, {kind: 'project'}>>) {
  const existing = editor.item;
  const openingRevision = useRef(snapshot.revision);
  const [name, setName] = useState(existing?.title ?? '');

  async function submit() {
    const title = name.trim();
    if (!title) return report('Enter a project name', true);
    if (title === existing?.title || await save([{
      action: existing ? 'update' : 'create', entity: 'project', id: existing?.id, fields: {title},
    }], existing ? 'Project renamed' : 'Project created', openingRevision.current)) onClose();
  }

  async function remove() {
    if (existing && await save([{entity: 'project', action: 'delete', id: existing.id}], 'Project removed; tasks moved to standalone', openingRevision.current)) onClose();
  }

  return <Modal title={existing ? 'Rename project' : 'New project'} onClose={onClose} onSubmit={submit}
    footer={<EditorFooter onClose={onClose} busy={busy} submit={existing ? 'Save project' : 'Create project'} onDelete={existing ? remove : undefined} deleteLabel="Remove project"/>}>
    <Field label="Project name"><input data-initial-focus value={name} placeholder="e.g. Portfolio Refresh" onChange={event => setName(event.target.value)}/></Field>
    <div className="project-dialog-note"><PixelFlower size={27}/>Projects group tasks; tasks can also live on their own.</div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </Modal>;
}

export default function BloomEditor({editor, ...props}: EditorProps): ReactNode {
  if (editor.kind === 'event') return <EventEditor {...props} editor={editor}/>;
  if (editor.kind === 'task') return <TaskEditor {...props} editor={editor}/>;
  return <ProjectEditor {...props} editor={editor}/>;
}
