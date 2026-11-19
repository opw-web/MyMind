# MYMIND Bloom

MYMIND is a private Windows planner with one calendar, a task checklist, and an assistant powered by local Ollama and Whisper.

## Calendar and Tasks

Calendar opens with today on the left. Scroll horizontally through days and vertically through hours. Use **New block**, click an empty slot, or drag across a time range to create a block. The all-day lane holds untimed entries. Scheduled work and past activity share the same grid. **Categories** shows, hides, adds, and renames labels.

Tasks can stand alone or belong to a project. Use the **Active**, **Completed**, and **All** filters with **Any schedule**, **Scheduled**, or **Unscheduled**. Due dates live on tasks. Use **Schedule on Calendar** to add a linked block. A task can have several linked blocks and independently completed checklist steps. Removing a task leaves its calendar blocks in place and unlinks them. Removing a project moves its tasks to the standalone list.

## Local assistant

Type a request or record a longer explanation in the composer. Once you send it, the assistant resolves the items and applies the complete validated request. If it needs a required detail, it asks before saving any part of that request.

Open the conversation to see the changes. Hover, focus, or tap a card to reveal the changed item in Calendar or Tasks. The green tick acknowledges the card visually. The red trash button reverses that card's change. An overlapping later edit can block a reversal. The card explains which conflict to resolve before trying again.

Voice settings in the composer default to **Edit before Send**. **Send on stop** sends the final transcript once after you intentionally stop recording. Review recovered or interrupted recordings in the composer. Interim transcripts and edits stay local.

### AI-only assistant contract

**This is a standing product requirement for every future session.** Ollama interprets every submitted assistant message and chooses the actions through tool calls. This applies to typed messages, sent Whisper transcripts, task lists, calendar edits, deletions, corrections, and navigation. Changes to this contract require an explicit new user request.

The required flow is as follows.

1. **Send the message to Ollama.** Whisper converts voice to text. The app supplies the submitted text, available tools, current date and time zone, conversation context, and a bounded sample of planner records.
2. **Let Ollama look up records when needed.** The model calls `find_items` with search words and optional filters. The app searches local planner records and returns matching records and IDs. Ollama selects the target or asks for clarification. Creating new tasks can proceed directly to staging.
3. **Let Ollama stage every edit.** Its `stage_changes` call specifies the records and fields to create, update, or delete. The app validates the supplied fields, resolves explicit references, and returns the staged result. Staging leaves saved planner data untouched. The model can repair a rejected tool call.
4. **Let Ollama finish the request.** Its `finish_request` call chooses `apply`, `clarification`, or `no_change`. `apply` commits the complete validated batch once. `clarification` asks for a required missing detail. `no_change` answers without committing planner edits. Requested navigation comes from model-supplied `viewActions`. Separate model tools support restoration and undo.
5. **Show the result.** A successful transaction produces receipts, updates the views, and creates per-action preview and undo cards. Model text alone never establishes that something was saved.

#### Rules for future changes

- Every fresh submitted assistant request must invoke the selected local model. Retries of an already completed request reuse its stored result to prevent duplicate edits.
- Never add natural-language parsers, regex or keyword intent routing, task-list splitting, hardcoded interpretations, canned actions, or model-free fallbacks that create, edit, delete, schedule, or navigate on the assistant's behalf. Never have application code decide which tools a message may use by matching its wording.
- Never have application code extract, invent, or silently rewrite user intent into task titles, dates, checklist steps, relationships, categories, or additional actions. Ollama supplies those decisions through its tools.
- Handle a model failure through a visible error or a model retry. Keep the planner unchanged when inference, validation, cancellation, or concurrency prevents completion. Never substitute a deterministic action for a failed model call.
- Keep schema checks, tool-argument decoding, explicit ID/reference lookup, transactional persistence, idempotency, rendering, transcription, and model settings in application code. Explicit manual button presses and per-card undo execute their existing direct behavior.
- Keep legacy rule-based interpretation code isolated from the production `PlannerAssistant.chatApplied` entry point. Historical documentation and prototype instructions must be read alongside this contract before reusing older behavior.

#### Required regression checks

Preserve `tests/assistant-applied.test.ts` and run it whenever changing this flow. Tests must verify that the model is called, the planner has zero writes before the model stages and finishes a valid batch, and navigation also requires a model tool call. A model `no_change` result must leave even familiar action wording without planner edits. Invalid or canceled batches must leave saved data intact.

Keep the regression input `I have these tasks- Class participation email, WOCO card email, Art case 7elements worksheet, Job negotiations 7elements worksheet, layerling first design`. Verify that Ollama issues `stage_changes` and `finish_request` for all five tasks. Never change this test to expect zero model calls or implement a phrase-specific workaround to pass it. Use an isolated database for live-model verification.

## Local setup and storage

Install Windows x64 Node and [Ollama](https://ollama.com/download/windows) and make the default tool-capable model available with `ollama pull qwen3.5:4b`. MYMIND uses the existing local model installation. The bundled Whisper worker handles live and final transcription. Manual planning is available while the assistant starts or if a runtime is unavailable.

Planner data and chat recovery live in `%LOCALAPPDATA%\MYMIND\planner.sqlite`. Unsent dictation uses a separate local `dictation.sqlite` file. Closing MYMIND normally clears conversation history and its undo cards. Relaunch after an unexpected exit to recover committed previews and see which requests were interrupted. Planner changes and voice preferences persist after quit.

The schema upgrade preserves existing IDs, notes, links, and legacy fields and keeps a SQLite backup of the previous schema. Close the app before making a manual backup of the data directory.

## Build and verify

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:desktop
node tests/bloom-ai-desktop.cjs
npm run graphify:build
npm run graphify:check
npm start
```

Electron tests use isolated data. To rebuild the bundled speech runtime, use Python 3.12, install `speech/requirements.lock.txt` in `.speech-env`, and run `npm run build:speech`. Installer commands are `npm run package` and `npm run package:msi`.

The [Bloom handoff](mymind%20UI%20update/bloom-planner/AGENT_HANDOFF.md) describes the UI prototype. The [legacy V1 readme](docs/legacy/V1_README.md) and [V2 plan](docs/V2_PLAN.md) document earlier product designs.
