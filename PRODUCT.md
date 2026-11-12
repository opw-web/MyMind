# MYMIND Bloom
<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop, Electron and React.

## Users

The owner plans personal and project work privately, using direct controls, typed conversation and reviewed dictation.

## Product Purpose

Connect a visible calendar and practical tasks to one local assistant while keeping the user in charge of saving AI changes.

## Operating Context

Calendar uses a horizontal day/time grid. Tasks offer Inbox, projects, sections, categories, steps, prerequisites, completion, archive and Flowchart. A bottom composer remains present; conversation expands above it. SQLite stores planner data locally. Ollama and bundled speech run on this computer.

## Capabilities and Constraints

- A task has an independent optional deadline. The calendar derives its all-day Deadline marker. Work sessions are independent event records: many per task, optionally linked to a step, with their own title, notes, quick notes, dates and times.
- Planned sessions and actual activity are distinct. Reporting sleep or work does not complete a task. Actual activity needs an explicit interval; missing AM/PM or endpoints produces a required question. Overnight sessions span real calendar dates.
- Standalone sessions have no completion checkbox. Linked controls reflect their task or step. Completing a parent leaves step flags intact; reopening a linked step under a completed parent reopens that parent and step while preserving other flags.
- Every AI mutation path builds one pending preview. Typed instructions, dictated instructions, direct shortcuts, corrections, deletions and conversational Undo all obey Apply. Required questions block the whole batch; Dismiss saves nothing. Manual controls save immediately unless they edit proposal-owned records or references.
- One Apply saves one atomic undoable batch. Repeated Apply is idempotent; concurrent saved edits require explicit refresh and conflict choices. Proposed records never appear as saved receipts.
- Recording → Stop → transcript review → Send. Preserve recoverable audio/transcript drafts, retry, cancel and interruption. Spoken replies: Read AI replies aloud using a local voice. Off by default.
- Settings provides Light/Dark/System, eligible installed local Ollama library models and context size. Existing appearance defaults Light and qwen3.5:9b remains the model default. Unavailable saved models have an explanation and a recovery picker, never a silent replacement. Larger contexts use more memory.
- Completed tasks archive after 24 elapsed hours; sessions remain on Calendar. Deleting tasks/steps detaches sessions. Migrations and Undo preserve independent deadline/session identity with WAL-safe backups.
- No cloud inference, model download/uninstall, external calendar sync, automatic recurrence, reporting dashboard, weight training or personal learned-memory system is added. Conversation is transient; saved planner and recoverable dictation remain local.
- Verification uses isolated data. Preserve the owner's data and unrelated work.

## Brand Commitments

Bloom is authoritative: rounded Nunito text, Silkscreen pixel headings, pastel calendar blocks, pixel flowers/cat, existing layout and playful geometry. Dark adapts the same world to warm charcoal. Earlier aerospace/Figma directions are historical.

## Evidence on Hand

Current implementation, the approved Bloom calendar/AI plan, deterministic tests, native Electron captures and real Ollama acceptance reports. DESIGN.md records the current tokens and interaction states.

## Product Principles

Keep manual planning usable while inference is busy or unavailable. Review voice text deliberately. Show proposals truthfully. Keep compact actions reachable. Preserve independent records and recoverable work.
