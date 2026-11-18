import {useMemo, type RefObject} from 'react';
import type {Snapshot, Task, TaskStep, Project, ActionPreviewTarget} from '../shared/model';
import {Icon} from './App';
import {PixelCat, PixelFlower} from './Pixel';
import {Button, TaskCheck, previewClass} from './BloomControls';

export type CompletionFilter = 'active' | 'completed' | 'all';
export type ScheduleFilter = 'all' | 'scheduled' | 'unscheduled';
const dueLabel = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', timeZone:'UTC'});
export const STANDALONE = 'inbox';

interface Props {
  snapshot: Snapshot;
  completion: CompletionFilter;
  schedule: ScheduleFilter;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  target: ActionPreviewTarget | null;
  panelRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  onCompletion: (filter: CompletionFilter) => void;
  onScheduleFilter: (filter: ScheduleFilter) => void;
  onProject: (project?: Project) => void;
  onTask: (task?: Task, projectId?: string) => void;
  onSchedule: (task: Task) => void;
  onProjectCollapse: (id: string, collapsed: boolean) => void;
  onTaskExpand: (id: string, expanded: boolean) => void;
  onTaskCheck: (task: Task) => void;
  onStepCheck: (task: Task, step: TaskStep) => void;
}

const COMPLETION_FILTERS = {active: 'Active', completed: 'Completed', all: 'All'} as const;
const SCHEDULE_FILTERS = {all: 'Any schedule', scheduled: 'Scheduled', unscheduled: 'Unscheduled'} as const;

function Segmented<T extends string>({label, choices, selected, onSelect}: {
  label: string; choices: Record<T, string>; selected: T; onSelect: (choice: T) => void;
}) {
  return <div className="segmented" role="group" aria-label={label}>
    {(Object.keys(choices) as T[]).map(choice => <button type="button" key={choice}
      className={selected === choice ? 'chosen' : ''} aria-pressed={selected === choice} onClick={() => onSelect(choice)}>
      {choices[choice]}
    </button>)}
  </div>;
}

export default function BloomTasks({
  snapshot, completion, schedule, collapsed, expanded, target, panelRef, busy,
  onCompletion, onScheduleFilter, onProject, onTask, onSchedule, onProjectCollapse, onTaskExpand, onTaskCheck, onStepCheck,
}: Props) {
  const taskTarget = target?.entity === 'task' ? target.id : target?.entity === 'step' ? target.taskId : undefined;
  const projects = snapshot.projects.filter(project => project.id !== STANDALONE);
  if (target?.entity === 'project' && target.before && !projects.some(project => project.id === target.id)) {
    projects.push({...target.before, id: target.id} as unknown as Project);
  }
  const tasks = target?.entity === 'task' && target.before && !snapshot.tasks.some(task => task.id === target.id)
    ? [...snapshot.tasks, {...target.before, id: target.id} as unknown as Task]
    : snapshot.tasks;
  const taskProject = tasks.find(task => task.id === taskTarget)?.projectId;
  const sessions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of snapshot.events) {
      if (event.linkedTaskId) counts.set(event.linkedTaskId, (counts.get(event.linkedTaskId) ?? 0) + 1);
    }
    return counts;
  }, [snapshot.events]);
  const filtered = tasks.filter(task =>
    task.id === taskTarget || (
      (completion === 'all' || (completion === 'active' ? !task.completed : task.completed))
      && (schedule === 'all' || (schedule === 'scheduled' ? sessions.has(task.id) : !sessions.has(task.id)))
    ),
  );
  const standalones = filtered.filter(task => !task.projectId || task.projectId === STANDALONE);
  const active = snapshot.tasks.filter(task => !task.completed).length;

  function taskRow(task: Task) {
    const selected = task.id === taskTarget;
    const deleted = target?.entity === 'task' && selected && !!target.before;
    const displayExpanded = expanded.has(task.id) || target?.entity === 'step' && selected;
    const steps = target?.entity === 'step' && selected && target.before && !task.steps.some(step => step.id === target.id)
      ? [...task.steps, {...target.before, id: target.id} as unknown as TaskStep]
      : task.steps;
    const sessionCount = sessions.get(task.id);
    const scope = target?.entity === 'project' && target.id === task.projectId || target?.entity === 'step' && selected ? null : target;
    return <div key={task.id} className={`task-entry${task.completed ? ' task-done' : ''}${previewClass(scope, 'task', task.id)}`}
      data-task-id={task.id} data-task={task.id}>
      <div className="task-main-row">
        <TaskCheck checked={task.completed} label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} disabled={busy || deleted}
          onChange={() => onTaskCheck(task)}/>
        {steps.length ? <button type="button" className="task-expand" title={displayExpanded ? 'Hide checklist steps' : 'Show checklist steps'}
          aria-expanded={displayExpanded} disabled={deleted} onClick={() => onTaskExpand(task.id, !displayExpanded)}>
          <Icon name={displayExpanded ? 'down' : 'chevron'} size={15}/>
        </button> : <span className="task-expand" aria-hidden="true"><Icon name="chevron" size={15}/></span>}
        <button type="button" className="task-title-button" disabled={deleted} onClick={() => onTask(task)}>{task.title}</button>
        {task.priority === 'High' && <span className="priority-tag">important</span>}
        {task.dueDate && <span className="task-due"><Icon name="calendar" size={12}/>{dueLabel.format(new Date(`${task.dueDate}T12:00:00Z`))}</span>}
        {steps.length > 0 && <span className="step-progress">{steps.filter(step => step.completed).length}/{steps.length} steps</span>}
        {sessionCount && <span className="task-sessions" title={`${sessionCount} scheduled session(s)`}><Icon name="link" size={12}/>{sessionCount}</span>}
        <div className="task-actions">
          <button type="button" title="Schedule on calendar" className="tiny-action" disabled={deleted} onClick={() => onSchedule(task)}><Icon name="calendar" size={16}/></button>
          <button type="button" title="Edit task" className="tiny-action" disabled={deleted} onClick={() => onTask(task)}><Icon name="edit" size={16}/></button>
        </div>
      </div>
      {displayExpanded && steps.length > 0 && <div className="steps-list">
        {steps.map(step => <div key={step.id} data-step-id={step.id} data-step-task={task.id}
          className={'step-line' + previewClass(target?.entity === 'step' && selected ? target : null, 'step', step.id)}>
          <TaskCheck checked={step.completed} label={`Mark ${step.title}`}
            disabled={busy || deleted || target?.entity === 'step' && selected && target.id === step.id && !!target.before}
            onChange={() => onStepCheck(task, step)}/>
          <span className={step.completed ? 'step-completed' : ''}>{step.title}</span>
        </div>)}
        <button type="button" className="add-step-inline" disabled={deleted} onClick={() => onTask(task)}><Icon name="plus" size={13}/> Edit steps</button>
      </div>}
    </div>;
  }

  return <>
    <header className="topbar task-topbar">
      <div className="title-wrap"><span className="bar-flower"><PixelFlower size={24}/></span><h1>My tasks</h1>
        <span className="mini-muted">{active} little {active === 1 ? 'thing' : 'things'} on your list</span></div>
      <div className="toolbar-actions">
        <Button icon="plus" onClick={() => onProject()}>New project</Button>
        <Button icon="plus" variant="primary" onClick={() => onTask()}>New task</Button>
      </div>
    </header>
    <div className="tasks-subbar">
      <div className="subbar-left"><span className="small-flower">✳</span> One thoughtful step at a time.</div>
      <div className="task-filters">
        <Segmented label="Task completion filter" choices={COMPLETION_FILTERS} selected={completion} onSelect={onCompletion}/>
        <Segmented label="Scheduling filter" choices={SCHEDULE_FILTERS} selected={schedule} onSelect={onScheduleFilter}/>
      </div>
    </div>
    <div className="tasks-content" ref={panelRef}><div className="tasks-column">
      <div className="tasks-section-label"><span>PROJECTS</span><span className="label-line"/><span>{projects.length}</span></div>
      {projects.map(project => {
        const visible = filtered.filter(task => task.projectId === project.id);
        const total = snapshot.tasks.filter(task => task.projectId === project.id);
        const done = total.filter(task => task.completed).length;
        const isCollapsed = collapsed.has(project.id) && project.id !== taskProject;
        const deleted = target?.entity === 'project' && target.id === project.id && !!target.before;
        const scope = project.id === taskProject ? null : target;
        return <section key={project.id} className={'project-panel' + previewClass(scope, 'project', project.id)} data-project-id={project.id}>
          <div className="project-head">
            <button type="button" className="project-collapse" title={isCollapsed ? 'Expand project' : 'Collapse project'}
              aria-expanded={!isCollapsed} disabled={deleted} onClick={() => onProjectCollapse(project.id, !isCollapsed)}>
              <Icon name={isCollapsed ? 'right' : 'down'} size={16}/>
            </button>
            <span className="project-folder"><Icon name="folder" size={19}/></span>
            <button type="button" className="project-name" disabled={deleted} onClick={() => onProject(project)}>{project.title}</button>
            <span className="project-progress">{done} of {total.length} complete</span>
            <div className="mini-progress"><span style={{width: `${total.length ? done / total.length * 100 : 0}%`}}/></div>
            <button type="button" className="tiny-action" aria-label={`Add task to ${project.title}`} title="Add task here" disabled={deleted}
              onClick={() => onTask(undefined, project.id)}><Icon name="plus" size={17}/></button>
            <button type="button" className="tiny-action" aria-label={`Rename ${project.title}`} title="Rename project" disabled={deleted}
              onClick={() => onProject(project)}><Icon name="more" size={17}/></button>
          </div>
          {!isCollapsed && !deleted && <div className="project-tasks">
            {visible.map(taskRow)}
            {visible.length === 0 && <div className="project-empty">No tasks in this view. <button type="button" onClick={() => onTask(undefined, project.id)}>Add one</button></div>}
          </div>}
        </section>;
      })}
      <div className="tasks-section-label standalone-label"><span>STANDALONE TASKS</span><span className="label-line"/><span>{standalones.length}</span></div>
      <section className="standalone-panel">
        {standalones.map(taskRow)}
        {standalones.length === 0 && <div className="project-empty">A tidy corner for everything else. <button type="button" onClick={() => onTask()}>Add a task</button></div>}
      </section>
      <div className="task-footer-message"><PixelCat size={39} happy/>
        <div><strong>Small steps still count.</strong><span>There’s no rush to finish it all at once.</span></div><PixelFlower size={23}/>
      </div>
    </div></div>
  </>;
}
