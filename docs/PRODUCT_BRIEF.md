# Original product brief

The original request was a personal Windows app based on a useful Miro workflow: horizontal month rows, dates within them, crossed-out past days, sticky-note events, and a to-do list on the right. The image illustrated functionality; copying Miro's visual design was not required.

Manual controls and a small local Ollama model were both essential. The user already had `qwen3.5:4b` and wanted to tell it what needed doing, what had been done, and what should change. Actual application tools should make those changes. The other central requirement was complete shutdown: Start menu launch, a taskbar window, and Close terminating everything the app started, including Ollama.

## Accepted version 1.0 direction

- Readable fixed-width day cells, scrolling and zoom; one row per month.
- Independently designed dark interface with subdued month colors.
- Notes, colors, optional times and inclusive multi-day events.
- Projects/sections, task ordering, and Inbox for unassigned work.
- Dated tasks displayed as synchronized calendar checkbox cards.
- Clear AI requests apply immediately with Undo; ambiguity asks a question.
- Typed chat initially, and a Start menu shortcut without sign-in autostart.
- Local SQLite; Electron, React, TypeScript and Vite.
- Native Ollama tool calling with validated drafts, atomic commits, bounded loops, cancellation, revision checks and request deduplication.
- A dedicated owned Ollama process, private loopback port, shared downloaded model files and Windows Job Object cleanup.
- Default 4,096-token context, with 2,048 fallback under GPU memory pressure.
- Empty initial data; no screenshot import.

## Acceptance criteria

Manual changes must survive reopening. Task and calendar checkboxes must agree. Moving a multi-day event preserves its duration. Past dates cross out as days change. One Undo restores a whole assistant batch. Real-model tests must cover event creation/movement, combined completion and creation, and duplicate-name clarification.

The installed app runs without a development server. Repeated launches focus the existing window. Closing during loading/inference and forced main-process termination must remove owned workers and their ports and release GPU memory. Other Ollama instances remain separate. GPU residency is measured on the target PC.

## Version 1.1 extension

The user asked for a microphone next to Send, local Faster Whisper, visible capture/transcription, and a Clicky-like interactive flow. They also requested verified event/task creation and deletion, a prominent upper-left Undo button, and Ctrl+Z.

Version 1.1 adds microphone PCM capture, a level meter, live drafts, final recognition, optional sending after a pause, cancellation, and a bundled CPU worker. The speech process follows the same shutdown rule. Real CRUD and voice-to-planner checks verify the operations.

The requested public GitHub repository is **MyMind**. Its README captures both the original intent and the shipped capabilities. Private planner data, credentials, recordings, build environments and model caches are excluded.
