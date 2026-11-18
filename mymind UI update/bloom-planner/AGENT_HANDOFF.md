# Bloom Planner — Complete Feature, Control, and AI Integration Handoff

**Version:** Single-calendar prototype, 17 November 2026  
**Audience:** A developer/AI coding agent tasked with replacing mock behavior with local, offline integrations.  
**Source of truth:** `src/App.tsx` (React/Vite edition), `src/app.tsx` (standalone/offline edition), `src/style.css`.  
**Companion prototype:** `Bloom-Planner-Demo.html`, a self-contained HTML file.

> **Non-negotiable product rule:** There is **one calendar**. Do not restore a Scheduled/Actual switch, separate actual-time calendar, calendar-type field, a separate AI screen, or a dashboard. Every calendar block—including a retrospective activity entry—appears on the **same** time grid. Categories are color-coded *labels and filters* within that one calendar, not separate calendar databases/views. The Tasks screen still has a **Scheduled / Unscheduled** *task filter*, which means whether a task has at least one linked calendar block; it is not a second calendar.

## 1. What this prototype is and is not

- A functioning in-memory UI with **exactly two main screens**: **Calendar** (default) and **Tasks**. A compact command composer stays visible at the bottom of both.
- Calendar: horizontally continuous days, vertically scrolling hourly grid, all-day lane, current-time line, click/drag creation, create/edit/delete, category visibility, task linking.
- Tasks: optional projects → tasks → checklist steps; also independent standalone tasks. Create, edit, delete, complete, filter, move between projects, schedule onto the calendar.
- Command composer: typed demo commands and a **simulated** voice workflow, deterministic action previews, explicit approval, and in-memory updates.
- **Not implemented:** backend, persistence, account/login, sync, actual microphone audio capture, Whisper, Ollama, a semantic AI model, API requests, notifications, recurrence, search, external calendars, real analytics, undo, moving/resizing existing blocks by dragging, or category deletion/color picking.
- Data resets to seeded values on reload. A user-facing button is described below only when it actually exists; optional future functionality is clearly marked.

## 2. Screen architecture and state

### 2.1 Navigation and layout

- Fixed narrow left sidebar, approximately 60–72 px on desktop and slimmer on narrow screens.
- Top logo is a decorative pixel tulip/flower. Bottom flowers, orange cat, and “bloom” caption are **decorative, not clickable**.
- **Calendar** icon button selects the calendar; **Tasks** icon button selects the checklist screen. An active terracotta highlight identifies the selected screen. Tooltip text and accessible names identify icons.
- No settings button and no other navigation tab exist in this prototype.
- Shared bottom composer is persistent across tab switches; opening the task or calendar view does **not** open a separate AI page.
- Modals overlay the app. Clicking the X, pressing Escape, clicking the shaded backdrop, or Cancel closes the modal without submitting. The UI includes transient 3-second success/error-style toast messages.
- Small-screen responsive behavior retains the same two tabs. The calendar stays horizontally scrollable when seven full columns cannot fit.

### 2.2 Data shape actually represented

Current `CalEvent` is a **single unified event entity**:

```ts
type CalendarBlock = {
  id: string;
  date: string;       // YYYY-MM-DD, local date
  start: string;      // HH:mm, 24-hour local time
  end: string;        // HH:mm, 24-hour local time
  allDay: boolean;
  categoryId: string; // key into categories
  taskId: string;     // empty string means not linked
  title: string;
  notes: string;
};

type Project = { id: string; name: string; collapsed: boolean };
type Step = { id: string; title: string; done: boolean };
type Task = {
  id: string;
  projectId: string | null; // null means standalone task
  title: string;
  done: boolean;
  due: string;               // YYYY-MM-DD or ''
  priority: string;          // '', 'Low', 'Medium', 'High'
  duration: string;          // free-text estimate like '1h 30m'
  categoryId: string;
  notes: string;
  steps: Step[];
  expanded: boolean;
};
type Category = { id: string; name: string; color: string; ink: string };
```

Other transient UI state: selected tab; visible category ID list; calendar date range, column width, leading visible date and scroll positions; open dialog; current unsaved editor draft; project collapse and task expansion flags; task filters; command text, simulated recording stage, interim/final transcript, examples/interim visibility, proposed action preview, and toast.

**Important linkage rules:**

1. A task exists independently of a calendar block. Merely setting a task **due date** does not create a calendar block.
2. A calendar block may link to zero or one task through `taskId`.
3. A task may have **many** calendar blocks/sessions sharing that `taskId`.
4. A linked block displays the linked **current task title** when the task can be found. Renaming a task therefore updates its displayed calendar block titles without duplicating task identities. The block also has a stored `title` fallback.
5. Checking a task or step does **not** change calendar blocks; adding an event does **not** complete a task.
6. Deleting a task preserves its former calendar blocks but unlinks them (`taskId: ''`). Deleting a project preserves its tasks and makes them standalone (`projectId: null`).
7. There is **no Scheduled/Actual discriminator** on calendar blocks. A past-activity entry is a normal calendar block with a past time and, where created by the command demo, notes describing its origin.

### 2.3 Initial example data

- Categories: Personal, Projects, Career Applications, Communication, Events, Focus / Study. Every category has a different gentle pastel background and contrasting text.
- Projects: Portfolio Refresh and Career & Applications.
- Portfolio project tasks include Redesign homepage (with four steps), Update project screenshots, and Rewrite About section.
- Career project tasks include Submit design internship application (with two steps) and Prepare interview examples.
- Standalone tasks include Buy groceries, Call a friend, and one completed Read 20 pages example.
- Calendar sample events include portfolio work, meeting/catch-up, reading, walk, job application/interview preparation, coffee, family call, application deadline and weekend plans. Previously separated “Reading” and “Replied to messages” sample activity entries now appear on that **same** calendar.
- Most seed dates are generated relative to the browser's local current date, not hardcoded to November 2026.

---

## 3. COMPLETE BUTTON AND CONTROL REFERENCE

Each row states the **current implementation behavior**. A future AI agent should preserve it unless a user explicitly requests a change.

### A. Global sidebar and universal interactions

| Control / gesture | Location | Exact current behavior |
|---|---|---|
| **Calendar** icon | Sidebar, top nav | Select `tab='calendar'`; show the single unified calendar; preserve previously visited horizontal/vertical scroll position on return. Default screen on first launch. |
| **Tasks** checklist icon | Sidebar, below Calendar | Select `tab='tasks'`; show task hierarchy and filters. |
| Pixel flower/logo | Sidebar top | Decorative brand mark with tooltip “Bloom Planner”; **not** navigation or a button. |
| Pixel cat/tulip/caption | Sidebar bottom | Decorative; no click handler. |
| **X / Close dialog** | Each modal top right | Close open modal, discard unapplied form changes, and do not apply preview actions. |
| **Cancel** | Each modal footer | Close without saving, deleting, or approving. |
| Click modal backdrop | Outside a dialog | Close without saving/applying. |
| **Escape** | Keyboard | Close active dialog and/or category popover/examples panel; discard unapproved preview. |
| Brief success toast | Top right after write actions | Displays confirmation and disappears after about 3 seconds. Informational, not clickable. |

### B. Calendar toolbar, grid, scrolling and timeline

| Control / gesture | Exact behavior |
|---|---|
| Month heading | Displays **month + year of the leftmost visible calendar day**, updates as horizontal scrolling crosses month boundary. Heading is informational, not a month picker. |
| **‹ Previous seven days** left arrow | Scroll calendar horizontally seven days back from the current leading day; not restricted to weeks or months. |
| **› Next seven days** right arrow | Scroll calendar horizontally seven days forward from the current leading day. |
| **Today** | Move horizontal viewport so today is the **leftmost visible day**. Does not switch to a month grid. |
| **Categories** funnel button with number | Toggle category filter/management popover. Number is the count of currently visible categories (initially 6). |
| **New block** plus button | Open “New calendar block” modal, prefilled with current leading visible date, 10:00–11:00, and Projects category. Nothing is created until **Add block**. |
| “One calendar · all your moments” | Informational copy only, indicating the now-unified calendar. Not a toggle. |
| Horizontal mouse/trackpad/touch scrolling | Shift visible date columns continuously in either direction. Days can cross week and month boundaries. Earlier/future columns load as the user approaches the range edges. |
| Vertical mouse/trackpad/touch scrolling inside calendar | Navigate 24-hour timeline from midnight through late night. Does **not** change dates/month. Initial scroll shows roughly 7–8 AM. |
| Day header e.g. **TUE 17** | Shows weekday/date, highlighting today; sticky when scrolling vertically. Informational only. |
| **all-day** gutter label | Identifies separate all-day row. Not a button. |
| Click empty **all-day** cell | Open “New calendar block” modal with selected date and **All-day block** already checked. |
| Click existing all-day chip | Open that block's edit modal. |
| Click an empty timed slot | Open a new block modal on the clicked date and snapped half-hour start, with a default one-hour span. |
| Mouse-drag vertically over empty timed slots | Preview a translucent selection, then open the new block modal for the selected half-hour-snapped time range. This is **creation**, not moving an existing block. |
| Click existing colored timed block | Open edit modal for that block. Colored block position/height reflects exact start/end minutes. |
| Link icon inside block | Indicates a linked task. The **whole block** opens its event editor; the tiny link icon itself is visual, not a separate “open task” button. |
| Current-time line and bubble | Shows present time across today's column; informational, not draggable. |
| Hour gutter, full-hour lines, half-hour dividers | Fixed visual time coordinates; not interactive controls. |
| Footer “↔ days · ↕ hours” and click/drag hint | Usage instructions, not buttons. |

**Calendar view invariants:** The first visible day on initial launch is today; about seven day columns fit a typical desktop; sticky day headers, all-day cells and hourly columns stay aligned; category visibility changes which events are drawn, **never** deletes them; past-activity blocks and future events use the same drawing/rendering path.

### C. Categories popover — color labels *within one calendar*

| Control | Exact behavior |
|---|---|
| **Show all** | Mark every category as visible; display blocks from every category in the unified calendar. |
| Category visibility checkbox (each category row) | Toggle that category ID in `visibleCats`. Blocks with that category temporarily hide/show. They remain in memory and can be restored. Does not filter task lists. |
| Colored dot next to category | Visual explanation of the category's background/border palette, not independently clickable. |
| **Pencil / Rename category** on row | Swap that row's name label for an editable text field prefilled with current name. |
| Category name text input | Edit proposed category name; **Enter** saves it. Leaving it blank retains existing name. |
| **Checkmark / Save name** (same row) | Persist the edited category name in in-memory categories and exit edit mode. Existing events still point at the same category ID. |
| **New category name** field | Type a name for an extra colored category. |
| **+ Add category** | Create category with generated ID and next color in pastel palette; immediately make it visible; clear input. **Enter** in the input does the same. Empty names do nothing. |
| **Categories** toolbar button again / Escape | Close popover. |

**No UI for deleting categories, setting custom colors, or changing their order.** The six sample categories are labels and do not create six separate calendars.

### D. Create/edit calendar block dialog — every field and button

| Control / field | Exact behavior and data written |
|---|---|
| **Title** text input | Edit `event.title`; required unless a linked task supplies a title. Placeholder: “What belongs on your calendar?” A linked block displays the task title on the grid. |
| **Date** date picker | Set `event.date` (`YYYY-MM-DD`). |
| **Category** dropdown | Set `event.categoryId`, choosing from current category list. This controls pastel color and category filtering on the **one calendar**. |
| **All-day block** checkbox | Set `event.allDay`. When checked, hide Start/End time fields and render in all-day row; when unchecked, render by precise clock time. |
| **Start time** picker | Set `event.start` (`HH:mm`) for timed blocks. Hidden for all-day blocks. |
| **End time** picker | Set `event.end` (`HH:mm`) for timed blocks. Hidden for all-day blocks. End must be **later** than start, otherwise a validation toast appears and no save occurs. Overnight blocks spanning two dates are not currently supported by this editor. |
| **Linked task (optional)** dropdown | Set `event.taskId` or empty string for no task. Selecting a task also prefills the editor title with task name. A task can be linked to multiple blocks. |
| **Open linked task: [name]** | Only shown when `taskId` is nonempty. Switch to Tasks and open that task's editor. Current unsaved event-editor changes are not automatically saved. |
| **Notes** textarea | Edit free-text `event.notes`. |
| **Add block** | In create mode, validate, give the block a generated ID, append to `events`, close modal, show toast, and immediately render at correct date/time or all-day row. |
| **Save changes** | In edit mode, validate then replace matching event by its ID, close, toast, and rerender. |
| **Delete** red text/trash button | Edit mode only. Remove matching event ID from memory; close and toast. It does **not** delete a linked task. |
| **Cancel** | Close without saving. |
| **X / backdrop / Escape** | Also close without saving. |

**Removed controls:** The old **Scheduled / Actual** calendar switch and the event-dialog **Entry type** segmented control have been deleted. Do not expose or use a hidden `kind` field in future integration. To record something that happened, create a block on the same calendar at its actual date and time.

### E. Tasks toolbar, filters and list structure

| Control / item | Exact behavior |
|---|---|
| **New project** | Open New project modal with empty name. |
| **New task** | Open Create a task modal with no parent project (`projectId=null`); the task is standalone unless Project dropdown is changed. |
| **Active** filter | Show incomplete tasks only. **Default** completion filter. |
| **Completed** filter | Show completed tasks only. |
| **All** completion filter | Show both completed and incomplete tasks. |
| **Any schedule** | Show all tasks irrespective of calendar links. **Default** scheduling filter. |
| **Scheduled** task filter | Show only tasks with **one or more linked calendar blocks** (`events.some(e => e.taskId===task.id)`). A due date alone is not enough. Not a separate calendar. |
| **Unscheduled** task filter | Show only tasks with **zero** linked calendar blocks. Due dates alone do not count. |
| PROJECTS heading + number | Read-only number of projects. |
| STANDALONE TASKS heading + number | Read-only number of standalone tasks **remaining after current filters**. |
| Project progress bar / “n of m complete” | Read-only project-level task completion (counts all tasks in project, even when task filters hide some). |
| Priority “important”, due date, step count, session/link count badges | Informational labels. Not clickable. |
| Friendly orange-cat footer | Decorative motivational message; not an action. |

### F. Per-project buttons in the Tasks screen

| Control | Exact behavior |
|---|---|
| **▾ / › collapse/expand project** | Toggle `project.collapsed`; hide/show that project's task rows without changing tasks. |
| Folder icon | Decorative indicator that row is a project; no handler. |
| **Project name** | Open “Rename project” editor for that project, also containing deletion action. |
| **+ Add task here** (at right of project header) | Open Create a task modal with `projectId` already set to that project. |
| **… Rename project** (three-dot icon) | Open the same Rename project editor. No separate overflow menu. |
| **Add one** in empty project panel | Open Create a task modal preassigned to that project. “No tasks in this view” may be due to task filters, not absence of tasks. |

### G. Per-task, per-step and standalone-list buttons

| Control | Exact behavior |
|---|---|
| Task square checkbox | Toggle `task.done` true/false. A completed task gets struck-through styling and may disappear from Active filter. It does not check its steps automatically and does not alter calendar entries. |
| Task disclosure arrow **› / ▾** | Toggle `task.expanded`; show/hide checklist steps if present. Does not mark task complete. |
| **Task title** | Open Edit task modal for that task. |
| **Calendar** icon at right (“Schedule on calendar”) | Open a **new linked calendar block** editor; prefill date from task due date or today, 10:00–11:00, task category, and task ID. One task can have many work sessions. |
| **Pencil** icon at right (“Edit task”) | Open Edit task modal. Equivalent to clicking task title. |
| Step square checkbox | Toggle **only that step's** `done` status. Does not auto-complete parent task. |
| **Edit steps** below expanded steps | Open Edit task modal; use its checklist editing area to add/edit/remove steps. |
| Session count/link badge | Shows number of linked calendar blocks for task. Not clickable; use calendar icon or editor to schedule new work session. |
| **Add a task** in empty standalone panel | Open Create a task modal as a standalone task. |

### H. Create/edit task modal — every field and button

| Control / field | Exact behavior |
|---|---|
| **Task name** input | Set `task.title`. Required; a blank name does not save. |
| **Project** dropdown | Choose **Standalone task** (`null`) or any project ID; moves a task between project and standalone when saved. |
| **Due date** date picker | Set `task.due`; this is a deadline/due-date property, **not an automatic calendar block**. |
| **Priority** dropdown | Choose None, Low, Medium, or High; High displays “important” badge in list. Other priority values are stored but don't show an equivalent badge. |
| **Estimate** input | Set free-text `task.duration` (e.g. “1h 30m”). Not an automated timer. |
| **Category** dropdown | Assign task category/color association. Category selection here does not automatically schedule a block. |
| **Notes** textarea | Set task notes. |
| Checklist step checkbox inside editor | Toggle that draft step's `done` flag; changes persist only when Save changes/Add task is pressed. |
| Checklist step text input | Rename that draft step. Blank step names are dropped when the task is saved. |
| **X Remove step** at right of an editor step | Remove that step from the editor draft. Persist on Save. |
| **+ Add checklist step** | Add a new blank step draft with generated ID; type its name before Save. |
| Checklist heading “n steps” | Informational count of current draft steps. |
| **Schedule on Calendar** | Present only for an existing task. Open a new linked calendar block editor. Note that unsaved changes in the current task form are not committed automatically before switching to the event editor. |
| **Add task** | Create a new task with generated ID and edited properties; close and toast. |
| **Save changes** | Update existing task by ID; close and toast. Linked calendar blocks dynamically display updated task name. |
| **Delete task** | Edit mode only. Remove task; preserve any former calendar blocks as unlinked entries. Close and toast. |
| **Cancel / X / backdrop / Escape** | Discard draft; return to underlying screen. |

### I. Create/rename/delete project modal

| Control / field | Exact behavior |
|---|---|
| **Project name** input | Create or edit display name; cannot submit a blank name. |
| **Create project** | Assign ID and append project; initially expanded; close and toast. |
| **Save project** | Rename existing project by ID; preserve its linked tasks; close and toast. |
| **Remove project** | Edit mode only. Delete project container but keep tasks by setting their `projectId=null` (standalone). Close and toast. |
| **Cancel / X / backdrop / Escape** | Discard draft and close. |
| Pixel flower + helper text | Decorative information that tasks can exist without a project. |

### J. Shared local-AI *demo* composer — all controls/states

| Control / state | Exact behavior |
|---|---|
| “LOCAL AI · SIMULATED” label | Honest static status; **not** an Ollama/Whisper connection indicator. |
| **Mic** button, idle | Start **simulated** recording. Does **not** access microphone or request permission. Clears previous text, shows animated waveform and interim transcript. |
| **Mic/pause** button, recording | Stop simulated recording; freeze last interim transcript; show “Refining transcript...” briefly (~680 ms), then put a separately cleaned final transcript into editable command input. **Does not send**. |
| Animated wave bars, “MOCK RECORDING” | Visual indication of simulation; not audio levels. |
| Interim text | Expands word by word at ~850 ms intervals from demo sentence “Add a task to buy groceries tomorrow.” Not real speech recognition. |
| “Refining transcript...” | Short mock transition; mic and input disabled while refining. |
| **Inspect interim** | After a simulation, reveal the earlier interim transcript in a small panel for comparison. |
| **Hide interim** | Collapse interim panel without losing final text. |
| Editable command text input | User types any text or edits cleaned final transcript; this never applies an action automatically. Input is replaced with live text while recording. |
| **Enter** in text input | Call Send / Review command (if not recording/refining). |
| **Ctrl+Enter / Cmd+Enter** | Also sends command for preview when nonempty and no modal is open. |
| **Examples** sparkle button | Toggle demo command list below composer. Does not execute anything. |
| Click any of the **five example command buttons** | Place that example sentence in editable input; close examples list. Must then explicitly Send. |
| **Send →** arrow | Enabled only when editable text is nonempty and not recording/refining. Interpret text through deterministic local parser and open **Review suggested actions** modal; no data changes yet. |
| “Final transcript · edit before sending” label | Appears after transcription simulation/review; informational. |
| Review dialog **Cancel / X / Escape / backdrop** | Discard proposed operation without mutating projects, tasks or calendar. Keep composer text until subsequently cleared by another action. |
| Review dialog **Approve & apply** | Execute mock operations against in-memory state; switch to affected screen, clear input/preview and show toast. If creating a calendar block, navigate calendar toward its date. |
| Preview summary, action lines, “Demo interpretation only” warning | Read-only description of what will be applied. No individual action-line toggles/editors in the existing preview. |

**Exactly five examples and what the existing deterministic parser does:**

| Example spoken/typed text | Current mock preview + approved effect |
|---|---|
| `Add a task to buy groceries tomorrow.` | Create one standalone Buy groceries task, due tomorrow (may duplicate sample task; no deduplication). Switch to Tasks. |
| `Create a project called Portfolio Refresh. Add tasks to redesign the homepage and update screenshots. Under redesign homepage, add steps for choosing colors, building the hero section, and testing responsiveness.` | Create a project, Redesign homepage task with three steps, and Update screenshots task. This is a fixed pattern, not general language understanding; duplicates are allowed. Switch to Tasks. |
| `Block tomorrow from 10 AM to 12 PM for portfolio work.` | Create one regular timed block on **the single calendar**, Projects category, tomorrow 10:00–12:00. Switch to Calendar. |
| `Schedule my homepage redesign task for Friday from 2 to 4.` | Find a task containing “homepage”, create a linked block next Friday 14:00–16:00 in Projects category. If no match, create an unlinked named block; parser is limited. Switch to Calendar. |
| `I spent the last 45 minutes replying to emails.` | Create one **ordinary block on the same calendar**, ending at the local current time, starting 45 minutes earlier, Communication category, with a note indicating past-activity origin. **There is no Actual screen or type**. Switch to Calendar. |

Other supported limited phrasing: `create a task`, `add a task`, `remind me to`, some `schedule ... from ...` and `block ... from ... to ... for ...` expressions. An unrecognized command falls back to a simple standalone task proposal with a warning in preview. This is a prototype convenience, **not** an agent-quality NLP parser. Approval is always required.

---

## 4. Features arranged by workflow (cross-reference)

### 4.1 Calendar workflows

1. Open app → Calendar is already selected → today is leading/leftmost → hour scroll starts near morning.
2. Browse days with left/right scrolling or seven-day arrow buttons; cross week/month boundaries with no week reset.
3. Browse hours vertically while headers and hour gutter remain anchored appropriately.
4. Create a time block using toolbar + button or clicking/dragging empty time grid.
5. Create an all-day block through all-day row or checking All-day in block editor.
6. Edit an existing block's title, date, category, time, all-day status, notes, or task link.
7. Delete existing block without deleting a linked task.
8. Filter any combination of category tags, including none or all.
9. Add category, rename category, assign categories to events/tasks.
10. Display tasks as blocks **only** when explicitly scheduled into one or more sessions.
11. Click linked event, then Open linked task → navigate directly to task editor.
12. Log past work by creating a normal block at the past time, manually or through command preview.
13. The unified calendar renders ordinary plans and retrospective blocks together. **No mode switching, no split calendar.**

### 4.2 Task workflows

1. Create project → create tasks under project using per-project + button.
2. Create task without project using top New task (or choose Standalone task in Project dropdown).
3. Add zero or many named checklist steps in editor.
4. Complete individual steps independently.
5. Complete/reopen parent task independently.
6. Collapse/expand project or task steps.
7. Edit title, due date, priority, duration estimate, category, notes and project assignment.
8. Move task between projects and standalone status.
9. Delete task while preserving its calendar sessions as unlinked events.
10. Delete project while preserving its tasks as standalone tasks.
11. Filter tasks by completion (Active/Completed/All) and whether linked to calendar (Any schedule/Scheduled/Unscheduled).
12. Click Schedule on Calendar → create **one more linked session**; multiple sessions can share a task.
13. Rename task → linked event display title updates via ID lookup.

### 4.3 Command workflow

1. Type text or press simulated mic.
2. If mic: watch incremental **interim** text, stop, review an independently produced editable **final** text. Inspect interim if desired.
3. Explicitly press Send or Enter. Not automatically sent on stopping the mic.
4. Preview action summary/individual lines; **Cancel** makes no changes.
5. **Approve & apply** mutates the same project/task/calendar state the manual controls use.
6. Result appears in Tasks or the one Calendar, with a short confirmation toast.

---

## 5. Recommended future local-AI integration contract (PROPOSAL — not yet implemented)

This section gives the next coding agent clear hook targets. **Do not confuse this proposed contract with working APIs**; the current app uses component methods and a deterministic `commandPreview` function.

### 5.1 Integration pipeline

```
Voice capture (future local Whisper) or typed input
  -> editable final user command
  -> local Ollama/Qwen interpreter (future)
  -> typed operation proposal(s) with resolved IDs and arguments
  -> validation / disambiguation / review modal
  -> explicit user approval
  -> one application action dispatcher / store
  -> update shared calendar/tasks/projects/categories UI
```

The Ollama agent should generate a **structured proposal**, not execute side effects. It must not automatically approve its own mutations. Whisper **interim** and **final** messages are separate and neither is executed without Send + Approve. Local/offline means no cloud endpoint, no telemetry, and no hidden network calls.

### 5.2 Stable conceptual actions to implement in a dispatcher

Suggested operation names are **future-facing names**; currently the mock only uses `task`, `projectTree`, `event` operations internally.

| Suggested future operation | Payload / effect | Related current UI |
|---|---|---|
| `calendar.create` | `{title,date,start,end,allDay,categoryId,taskId?,notes?}` → new block ID | New block / click grid / All-day / Add block |
| `calendar.update` | `{id,changes}` → update existing block, keeping ID | Click block → Save changes |
| `calendar.delete` | `{id}` → delete exactly that block | Edit block → Delete |
| `calendar.navigate` | `{date}` → scroll so date is leading | Today / date arrows / UI scroll |
| `category.setVisible` | `{categoryId,visible}` → toggle filter only | Category checkbox |
| `category.showAll` | `{}` → enable all categories | Show all |
| `category.create` | `{name}` → new category ID and pastel palette | + Add category |
| `category.rename` | `{id,name}` | Pencil → checkmark |
| `project.create` | `{name}` → new project ID | New project |
| `project.rename` | `{id,name}` | Project name or … → Save project |
| `project.delete` | `{id}`; tasks become standalone | Remove project |
| `project.setCollapsed` | `{id,collapsed}`; visual-only state | Project ▾/› |
| `task.create` | `{title,projectId?,due?,priority?,duration?,categoryId?,notes?,steps?}` → task ID | New task / Add task here |
| `task.update` | `{id,changes}` including project reassignment | Edit task / Save changes |
| `task.delete` | `{id}`; unlink but retain calendar blocks | Delete task |
| `task.setComplete` | `{id,done}`; do not auto-toggle steps | Task checkbox |
| `task.setExpanded` | `{id,expanded}`; UI-only | Task disclosure arrow |
| `step.create` | `{taskId,title}` | Add checklist step |
| `step.update` | `{taskId,stepId,changes}` | Step input/checkbox |
| `step.delete` | `{taskId,stepId}` | Step X/remove |
| `step.setComplete` | `{taskId,stepId,done}`; parent unchanged | Step checkbox |
| `task.schedule` | `{taskId,date,start,end,allDay?,categoryId?}` → **create calendar block** linked to existing task; task remains independent | Schedule on Calendar |
| `task.filter` | `{completion:'active'|'completed'|'all',schedule:'all'|'scheduled'|'unscheduled'}` → UI-only filter | Tasks segmented filters |
| `activity.record` | `{title,date,start,end,categoryId,taskId?,notes?}` → alias to `calendar.create`, **not a second calendar** | Past-activity command / normal event editor |

### 5.3 Example *proposed* JSON action message

This is only a design contract for future code, not a currently accepted input format:

```json
{
  "version": 1,
  "summary": "Schedule work on homepage redesign",
  "operations": [
    {
      "type": "task.schedule",
      "payload": {
        "taskId": "t-home",
        "date": "2026-11-20",
        "start": "14:00",
        "end": "16:00",
        "allDay": false,
        "categoryId": "projects"
      }
    }
  ],
  "requiresApproval": true
}
```

Do not trust the model to invent IDs. Resolve natural names (e.g. “the homepage task”) against current tasks/categories/projects; ask for disambiguation if several matches are plausible. The example date here is just an illustrative local date. Do not hard-code example dates in production.

### 5.4 Validation / business rules for local AI

- Date values: local **`YYYY-MM-DD`**. Times: local **`HH:mm`**. Convert natural language (“tomorrow”, “Friday”, “last 45 minutes”) to concrete times in the user's actual local timezone, with correct DST handling where applicable.
- For a timed block, `end > start` on the same date; do not silently store a negative-duration block. Multi-day/overnight support would require a deliberate new design decision.
- Category IDs and linked task IDs must exist; IDs are the references, not titles. Category renames must not invalidate links.
- New task may have `projectId=null` and `steps=[]`; never force project/steps. Step IDs must be unique within tasks.
- Do not create a calendar block from a task due date unless the user **asks to schedule it**. Do not equate task completion with time recorded.
- On task deletion, keep historical calendar blocks as unlinked events; on project deletion, rehome tasks as standalone.
- Preserve multiple sessions per task. Editing a session should not alter the task's completion and editing a task should not erase its sessions.
- Category visibility is presentation-only. A hidden block is still in state and must remain updateable.
- Commands like “I spent the last 45 minutes reading” should create a normal event, optionally tagged/note-marked as historical context, in the **same calendar**; never require a Scheduled/Actual toggle.
- A plan with multiple actions should preview every action. If any action is invalid, surface the issue before approval. Apply a confirmed plan as a consistent batch (or explicitly report partial failures); support cancel without changing state.
- No automatic message sending at the end of simulated or future real transcription.
- For a real local-AI integration: wire the composer to local Whisper STT and an on-device Ollama model only when explicitly implemented; never show “Connected” merely because the UI is ready. Keep demo fallback labeled.
- Persistence is outside the current prototype. If adding local storage later, make save/restore explicit and preserve existing IDs and links. Do not silently add cloud sync/auth.

### 5.5 Relevant implementation hooks today

- `commandPreview(text, tasks)` — deterministic command-to-proposal demo; replace or wrap with local AI interpreter while preserving explicit approval.
- `sendCommand` — creates preview; **does not** mutate data.
- `applyPreview` — executes current tiny operation set (`task`, `projectTree`, `event`) in React memory; replace with a validated shared dispatcher as above.
- `toggleRecording` — mock microphone + interim/final timing; future place to connect real local speech capture/transcript events.
- `openEvent`, `saveEvent`, `removeEvent`, `scheduleTask` — calendar editing and task-to-calendar links.
- `openTask`, `saveTask`, `deleteTask`, `toggleTask`, `toggleStep` — task CRUD and completion.
- `openProject`, `saveProject`, `deleteProject` — project CRUD.
- `renderCategoryPopover`, `addCategory` — categories and visibility.
- `renderCalendar`, `onCalendarScroll`, `goTo`, `moveDays`, `mountCalendar` — unified day/hour calendar.
- `renderTasks`, `renderTaskRow` — project/task checklist and filters.
- The two source editions intentionally duplicate the app. **When modifying code, keep `src/App.tsx` and `src/app.tsx` behavior identical**, then run `npm run build:offline` to rebuild standalone assets.

---

## 6. Exact acceptance checklist for the next agent

- [ ] Only Calendar and Tasks primary navigation buttons exist; Calendar opens by default.
- [ ] One continuous calendar displays **all blocks**, including retrospective activity, without Scheduled/Actual switch or event type field.
- [ ] Category names are filters/tags, not additional calendars. Show all restores all blocks.
- [ ] Today initially leads the calendar; Today resets leading date; arrow and horizontal scrolling work across months.
- [ ] Vertical scroll traverses 24 hours; day headers, all-day row and time gutter stay aligned.
- [ ] Click/drag empty grid creates timed block; all-day cell creates all-day block; save/edit/delete rerender.
- [ ] Event editor validates end time after start, supports category, notes, optional linked task; linked-task navigation opens task.
- [ ] Projects/tasks/steps are truly hierarchical; standalone tasks and tasks with no steps work.
- [ ] Task completion is independent of steps, due dates, calendar sessions, and logged activities.
- [ ] New task, project, step, edit, delete, move, filters and collapse controls work.
- [ ] One task supports multiple linked sessions; linked block titles reflect renamed task; task deletion preserves sessions as unlinked blocks.
- [ ] Five command examples populate text input; Send opens preview; Cancel does not mutate; Approve changes shared state.
- [ ] Simulated mic shows incremental interim, separately refined editable final, and no auto-send. Real mic is **not** claimed in demo.
- [ ] Past-time command inserts **ordinary event** into same calendar, visible with other blocks.
- [ ] Dialogs close by X, Cancel, Escape, backdrop; no inert exposed control.
- [ ] No backend, cloud/model call, auth, analytics or telemetry is present in UI-only edition.

## 7. Known limitations and *not* promises

- Existing blocks are **not** draggable to move or resize after creation. Creation range selection is a mouse drag; use event editor for time changes.
- The grid uses half-hour snapping for creation, but editor time pickers allow minute-level times, which render proportionally.
- Category deletion, manual color choosing and category reorder do not exist.
- No direct inline subtask editor in the expanded checklist; “Edit steps” opens task modal.
- Task due dates do not automatically populate all-day calendar chips.
- No search, recurring event rule, invitations, external feed, reminders, offline data persistence, export, print, statistics, pomodoro, third tab, dashboard, or dedicated AI chat.
- Preview does not offer per-action toggles/editing; edit the command and resend if the proposed operation is wrong.
- The existing rule-based parser understands only a small set of examples and may duplicate existing tasks/projects.
- Current UI has no user-facing drag to reorder tasks/projects and no standalone priority sorting.
- The initial day-column range is generated around browser date and extended near edges; it is not an infinite database of persisted calendar records.
- The demo uses a bundled older offline React runtime to work without npm/network. The modern source uses React 18 via Vite; the current deliverable has been browser-tested as the standalone bundle, not an external production deployment.

---

## 8. Files and building

```text
bloom-planner/
  AGENT_HANDOFF.md          # this exhaustive specification
  README.md                 # setup and project summary
  Bloom-Planner-Demo.html   # one-file standalone demo (generated)
  index.html                # modern Vite HTML entry
  src/App.tsx               # modern React source
  src/app.tsx               # offline-compatible mirrored source
  src/style.css             # visual system, calendar grid, responsive CSS
  src/modern.css            # Tailwind import + CSS
  src/main.tsx              # React 18 app mount
  scripts/build.cjs         # compile offline app + make standalone HTML
  dist/index.html           # fully local multi-file offline entry
  dist/app.js
  dist/style.css
  dist/vendor/react.min.js
  dist/vendor/react-dom.min.js
```

- Offline rebuild (does not need npm registry when TypeScript is available): `npm run build:offline`.
- Modern dev server (requires npm dependencies): `npm install && npm run dev`.
- Modern bundler: `npm run build`.
- Browser-test the standalone HTML. In environments that block `file://` navigation, serving over localhost or injecting document content for testing is acceptable; this is not a web API dependency.

**The core mental model for the agent:** **Calendar = everything that occupies a date/time. Tasks = things to accomplish, optionally grouped in projects and steps. The shared local-AI composer proposes operations against those same entities, but never changes them before user approval.**
