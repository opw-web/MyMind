# Bloom Planner — Complete Agent Handoff Package

This is the entire single-calendar Bloom Planner frontend prototype in ONE ZIP file.

## Open the working demo

Extract the ZIP, then open `bloom-planner/Bloom-Planner-Demo.html` in your browser.

## Give the project to your coding agent

Give the agent the extracted `bloom-planner/` directory. Have it read:

1. `bloom-planner/AGENT_HANDOFF.md` — exhaustive feature/button/gesture and data-action specification.
2. `bloom-planner/README.md` — overview, install/build commands, project caveats.
3. `bloom-planner/src/` — the actual editable React + TypeScript source code.

The `bloom-planner/dist/` directory contains an offline-bundled browser build.
The `previews/` directory contains reference screenshots.

## Important product constraints

There are exactly two main tabs: Calendar and Tasks. All calendar entries, including
activity logs, are displayed in ONE unified calendar. No Scheduled / Actual switch.
The bottom AI command composer is a simulation awaiting a future local Ollama/Whisper
integration. No backend, auth, database, or network AI connections have been added.
