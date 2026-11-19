import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {AssistantViewAction, Change, EventItem, Project, Snapshot, Task, TaskStep} from '../shared/model';
import {shiftDate, todayIn} from '../shared/dates';
import {Icon} from './App';
import {PixelCat, PixelFlower} from './Pixel';
import BloomCalendar, {type BlockSlot, type CalendarHandle} from './BloomCalendar';
import BloomCategories from './BloomCategories';
import BloomComposer from './BloomComposer';
import {Button, useEscape, type PlannerPreviewTarget} from './BloomControls';
import BloomEditor, {type Editor} from './BloomEditor';
import BloomTasks, {type CompletionFilter, type ScheduleFilter} from './BloomTasks';

type View = 'calendar' | 'tasks';

const monthFormat = new Intl.DateTimeFormat('en', {month: 'long', year: 'numeric', timeZone: 'UTC'});
const monthTitle = (date: string) => monthFormat.format(new Date(date + 'T12:00:00Z'));
const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');

function withMembership(current: ReadonlySet<string>, id: string, present: boolean) {
  const next = new Set(current);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

export default function Workspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>('calendar');
  const [now, setNow] = useState(Date.now());
  const today = todayIn(snapshot?.preferences.timezone, new Date(now));
  const [leadDate, setLeadDate] = useState<string | null>(null);
  const [calendarDestination, setCalendarDestination] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{text: string; error: boolean} | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [completion, setCompletion] = useState<CompletionFilter>('active');
  const [schedule, setSchedule] = useState<ScheduleFilter>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<PlannerPreviewTarget | null>(null);

  const calendar = useRef<CalendarHandle>(null);
  const tasksPanel = useRef<HTMLDivElement>(null);
  const categoriesAnchor = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(false);
  const latestRefresh = useRef(0);

  const showCategories = categoriesOpen || target?.entity === 'category';
  const currentDate = leadDate ?? today;

  const report = useCallback((text: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({text, error});
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    const token = ++latestRefresh.current;
    try {
      const result = await window.planner.snapshot();
      if (alive.current && token === latestRefresh.current) setSnapshot(result);
    } catch (error) {
      if (alive.current && token === latestRefresh.current) report(cleanError(error), true);
    }
  }, [report]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = window.planner.onChanged(refresh);
    return () => {
      alive.current = false;
      unsubscribe();
      clearTimeout(toastTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 15_000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);

  const setVisibility = useCallback((id: string, visible: boolean) => setHidden(current => withMembership(current, id, !visible)), []);
  const showAll = useCallback(() => setHidden(new Set()), []);
  const setProjectCollapsed = useCallback((id: string, value: boolean) => setCollapsed(current => withMembership(current, id, value)), []);
  const setTaskExpanded = useCallback((id: string, value: boolean) => setExpanded(current => withMembership(current, id, value)), []);
  const onPreview = useCallback((next: PlannerPreviewTarget | null) => {
    if (next && document.querySelector('dialog.bloom-editor[open]')) return;
    if (next) setView(next.entity === 'event' || next.calendarDeadline || next.entity === 'category' ? 'calendar' : 'tasks');
    setTarget(next);
  }, []);

  useEscape(() => {
    if (target) onPreview(null);
    if (categoriesOpen) {
      setCategoriesOpen(false);
      categoriesAnchor.current?.querySelector('button')?.focus({preventScroll: true});
    }
  }, !editor && (categoriesOpen || !!target));

  useEffect(() => {
    const clearPreview = () => onPreview(null);
    window.addEventListener('blur', clearPreview);
    return () => window.removeEventListener('blur', clearPreview);
  }, [onPreview]);

  useLayoutEffect(() => {
    if (!target || !snapshot) return;
    if (target.calendarDeadline) {
      const task = snapshot.tasks.find(task => task.id === target.id);
      if (task?.dueDate) calendar.current?.goTo(task.dueDate);
      return;
    }
    if (target.entity === 'event') {
      const record = snapshot.events.find(event => event.id === target.id) ?? target.before;
      if (record && typeof record.startDate === 'string') {
        calendar.current?.goTo(record.startDate, false, typeof record.startTime === 'string' ? record.startTime : null);
      }
      return;
    }
    const root = target.entity === 'category' ? categoriesAnchor.current : tasksPanel.current;
    const escaped = CSS.escape(target.id);
    const parent = target.entity === 'step' && target.taskId ? `[data-task-id="${CSS.escape(target.taskId)}"] ` : '';
    root?.querySelector<HTMLElement>(`${parent}[data-${target.entity}-id="${escaped}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [target, snapshot?.revision]);

  useLayoutEffect(() => {
    if (calendarDestination && view === 'calendar') {
      calendar.current?.goTo(calendarDestination);
      setCalendarDestination(null);
    }
  }, [calendarDestination, view]);

  const onViewAction = useCallback((action: AssistantViewAction) => {
    onPreview(null);
    switch (action.type) {
      case 'tab':
        setView(action.tab);
        setCategoriesOpen(false);
        break;
      case 'date':
        setView('calendar');
        setCalendarDestination(action.date);
        break;
      case 'categoryVisibility':
        setView('calendar');
        setVisibility(action.categoryId, action.visible);
        break;
      case 'showAllCategories':
        setView('calendar');
        showAll();
        break;
      case 'taskFilters':
        setView('tasks');
        if (action.completion) setCompletion(action.completion);
        if (action.schedule) setSchedule(action.schedule);
        break;
      case 'projectCollapsed':
        setView('tasks');
        setProjectCollapsed(action.projectId, action.collapsed);
        break;
      case 'taskExpanded':
        setView('tasks');
        setTaskExpanded(action.taskId, action.expanded);
        break;
    }
  }, [onPreview, setVisibility, showAll, setProjectCollapsed, setTaskExpanded]);

  async function save(changes: Change[], label: string, revision = snapshot?.revision) {
    if (saving.current || revision === undefined) return false;
    saving.current = true;
    setBusy(true);
    try {
      await window.planner.mutate({changes, label, expectedRevision: revision, requestId: crypto.randomUUID()});
      await refresh();
      report(label);
      return true;
    } catch (error) {
      report(cleanError(error), true);
      await refresh();
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function navigate(next: View) {
    onPreview(null);
    setView(next);
    setCategoriesOpen(false);
  }

  const openEvent = useCallback((item: EventItem) => {
    onPreview(null);
    setEditor({kind: 'event', item, date: item.startDate});
    setCategoriesOpen(false);
  }, [onPreview]);

  const newEvent = useCallback((slot: BlockSlot) => {
    onPreview(null);
    setEditor({kind: 'event', ...slot});
    setCategoriesOpen(false);
  }, [onPreview]);

  function openTask(item?: Task, projectId?: string) {
    navigate('tasks');
    setEditor({kind: 'task', item, projectId});
  }

  function openProject(item?: Project) {
    onPreview(null);
    setEditor({kind: 'project', item});
  }

  function scheduleTask(task: Task) {
    onPreview(null);
    setEditor({kind: 'event', task, date: task.dueDate ?? today});
  }

  function checkTask(task: Task) {
    void save([{action: 'update', entity: 'task', id: task.id, fields: {completed: !task.completed}}], task.completed ? 'Task reopened' : 'Task completed');
  }

  function checkStep(task: Task, step: TaskStep) {
    const steps = task.steps.map(item => item.id === step.id ? {...item, completed: !item.completed} : item);
    void save([{action: 'update', entity: 'task', id: task.id, fields: {steps}}], step.completed ? 'Step reopened' : 'Step completed');
  }

  if (!snapshot) return <div className="loading-screen" role="status"><PixelFlower size={42}/><h1>Bloom Planner</h1>
    <p>{toast?.text ?? 'Opening your planner…'}</p></div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-logo" title="Bloom Planner"><PixelFlower size={40}/><span className="brand-small" aria-hidden="true">b</span></div>
      <nav className="side-nav" aria-label="Main navigation">
        {(['calendar', 'tasks'] as const).map(tab => <button type="button" key={tab}
          className={`side-button ${view === tab ? 'active' : ''}`}
          aria-current={view === tab ? 'page' : undefined} aria-label={tab === 'calendar' ? 'Calendar' : 'Tasks'}
          title={tab === 'calendar' ? 'Calendar' : 'Tasks'} onClick={() => navigate(tab)}>
          <Icon name={tab} size={24}/>
        </button>)}
      </nav>
      <div className="side-bottom"><div className="sidebar-tulip"><PixelFlower size={25}/></div><PixelCat size={43}/>
        <span className="side-caption">bloom</span></div>
    </aside>
    <main className="main-shell">
      <div className="screen-content" hidden={view !== 'calendar'}>
        <header className="topbar">
          <div className="title-wrap"><span className="bar-flower"><PixelFlower size={24}/></span>
            <h1>{monthTitle(currentDate)}</h1><span className="mini-muted">a little room to bloom</span></div>
          <div className="toolbar-actions">
            <div className="nav-pair">
              <button type="button" className="sq-btn" aria-label="Previous seven days" onClick={() => calendar.current?.goTo(shiftDate(currentDate, -7), true)}><Icon name="left"/></button>
              <button type="button" className="sq-btn" aria-label="Next seven days" onClick={() => calendar.current?.goTo(shiftDate(currentDate, 7), true)}><Icon name="right"/></button>
            </div>
            <Button onClick={() => calendar.current?.goTo(today, true)}>Today</Button>
            <div className="toolbar-separator"/>
            <div className="popover-anchor" ref={categoriesAnchor}>
              <Button icon="filter" aria-expanded={!!showCategories} onClick={() => setCategoriesOpen(open => !open)}>
                Categories <span className="filter-counter">{snapshot.categories.filter(category => !hidden.has(category.id)).length}</span>
              </Button>
              {showCategories && <BloomCategories categories={snapshot.categories} hidden={hidden} target={target} busy={busy}
                setVisibility={setVisibility} showAll={showAll} save={save}/>}
            </div>
            <Button icon="plus" variant="primary" onClick={() => newEvent({date: currentDate})}>New block</Button>
          </div>
        </header>
        <div className="subbar">
          <div className="subbar-left"><span className="small-flower">✳</span><span>Time to make space for what matters.</span></div>
          <span className="single-calendar-note">One calendar · all your moments</span>
        </div>
        <BloomCalendar ref={calendar} snapshot={snapshot} today={today} now={now} hiddenCategories={hidden} target={target}
          onOpen={openEvent} onTask={openTask} onNew={newEvent} onLead={setLeadDate}/>
        <div className="calendar-footnote"><span><span className="soft-dot"/> Click or drag an empty time slot to make a block.</span>
          <span>↔ days <span className="hint-separator">·</span> ↕ hours</span></div>
      </div>
      <div className="screen-content" hidden={view !== 'tasks'}>
        <BloomTasks snapshot={snapshot} completion={completion} schedule={schedule} collapsed={collapsed} expanded={expanded}
          target={target} panelRef={tasksPanel} busy={busy} onCompletion={setCompletion} onScheduleFilter={setSchedule}
          onTask={openTask} onProject={openProject} onSchedule={scheduleTask} onProjectCollapse={setProjectCollapsed}
          onTaskExpand={setTaskExpanded} onTaskCheck={checkTask} onStepCheck={checkStep}/>
      </div>
      <BloomComposer snapshot={snapshot} onPreview={onPreview} onViewAction={onViewAction}/>
    </main>
    {editor && <BloomEditor key={editor.kind + (editor.item?.id ?? '')} editor={editor} snapshot={snapshot} busy={busy}
      error={toast?.error ? toast.text : undefined} onClose={() => {setEditor(null); setToast(value => value?.error ? null : value);}}
      save={save} report={report} openTask={openTask} scheduleTask={scheduleTask}/>}
    {toast && !(editor && toast.error) && <div role={toast.error ? 'alert' : 'status'} className={`toast ${toast.error ? 'toast-error' : ''}`}>
      <PixelFlower size={25}/><span>{toast.text}</span><Icon name={toast.error ? 'info' : 'check'} size={15}/>
    </div>}
  </div>;
}
