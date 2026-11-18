# MYMIND Bloom

MYMIND is a private Windows planner with one calendar, a task checklist, and an assistant powered by local Ollama and Whisper.

## Calendar and Tasks

Calendar opens with today on the left. Scroll horizontally through days and vertically through hours. Use **New block**, click an empty slot, or drag across a time range to create a block. The all-day lane holds untimed entries. Scheduled work and past activity share the same grid. **Categories** shows, hides, adds, and renames labels.

Tasks can stand alone or belong to a project. Use the **Active**, **Completed**, and **All** filters with **Any schedule**, **Scheduled**, or **Unscheduled**. Due dates live on tasks. Use **Schedule on Calendar** to add a linked block. A task can have several linked blocks and independently completed checklist steps. Removing a task leaves its calendar blocks in place and unlinks them. Removing a project moves its tasks to the standalone list.

## Local assistant

Type a request or record a longer explanation in the composer. Once you send it, the assistant resolves the items and applies the complete validated request. If it needs a required detail, it asks before saving any part of that request.

Open the conversation to see the changes. Hover, focus, or tap a card to reveal the changed item in Calendar or Tasks. The green tick acknowledges the card visually. The red trash button reverses that card's change. An overlapping later edit can block a reversal. The card explains which conflict to resolve before trying again.

Voice settings in the composer default to **Edit before Send**. **Send on stop** sends the final transcript once after you intentionally stop recording. Review recovered or interrupted recordings in the composer. Interim transcripts and edits stay local.

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
