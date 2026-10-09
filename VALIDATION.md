# Verified build — 9 October 2026

MYMIND 1.0.0 is installed at `%LOCALAPPDATA%\Programs\MYMIND\MYMIND.exe`, with a Windows Start menu shortcut. The installed `app.asar` matches the final packaged build by SHA-256. The installer is `release/MYMIND-Setup-1.0.0.exe` (about 108 MiB).

Passed checks:

- TypeScript checks and production build.
- 13 automated data/assistant tests: valid dates and leap years, timezone rollover, foreign-key validation, atomic saves and rollbacks, Undo, request/stage deduplication, cancellation, duplicate-name clarification, and references between newly created projects, sections, and tasks.
- Actual Electron interface: manual creation/editing, multi-day drag rescheduling, synchronized task checkboxes, project/section deletion and restoration, Today/overdue views, fit/zoom, year navigation, and saved data after reopening.
- Layout at 1280×800, 125%, 150%, and the machine's native 175% scaling, including chat and editor dialogs.
- Real `qwen3.5:4b`: create an exam next Friday, move it to Monday, complete Cornhole while adding Packaging for tomorrow, clarify duplicate Walls tasks, apply a “the one in VIP” follow-up, create School → Homework → Math worksheet in one transaction, and answer a due-date query.
- The installed executable applies a real assistant request, focuses its existing window on a second launch, and runs the model fully on GPU at a 4,096-token context. `ollama ps` independently reports **100% GPU**.
- Final installed-app cleanup: closing during model loading took 104 ms; closing during inference took 131 ms; forced termination of the actual Electron main process cleared its owned processes in 55 ms. The Ollama port closed and GPU memory was released. An independent Ollama server remained alive throughout these checks.

Test fixtures use isolated folders under `test-results`; the user's planner starts empty. The app is left closed after verification. Detailed model and lifecycle results are in `test-results/model-report.json`, `test-results/model-organization-report.json`, and `test-results/lifecycle-report.json`.

Windows packaging uses `scripts/package.cjs` with the pinned electron-builder version. It preserves the Windows environment for the NSIS helper and can use electron-builder's own static uninstaller reader if Windows rejects that temporary helper. No system security settings are changed.

## Version 1.1 — 10 October 2026

- Added bundled offline Faster Whisper base/CPU int8 dictation, microphone beside Send, audio-level feedback, live previews, final transcription, optional sending after a pause, and cancellation.
- Real transcription returned a live draft “Add an exam next…” and final “Add an exam next Friday.”
- The actual installed app passed voice → transcript → Qwen → saved event, automatic sending after a pause, keyboard Ctrl+Z from the empty chat box, and the upper-left Undo button.
- Cancellation restores the prior typed input; closing the chat releases capture. App exit removes both app-owned speech and Ollama workers.
- The real model created/deleted an event, created/deleted a task, completed/reopened a task, and Undo restored both deletions.
- All 13 unit tests, type checks, production build, and updated desktop interaction checks passed.
- Microphone tests use synthetic audio through Chromium's fake input device; they do not record ambient audio. Physical microphone selection/access remains dependent on the user's Windows configuration.
- Installed 1.1 lifecycle verification passed with both workers loaded: closing during inference cleared owned processes in 154 ms, and forced main-process termination cleared them in 77 ms. Both private ports closed; the independent Ollama server remained alive.
- The public repository's Windows GitHub Actions run passed type checks, the 13 tests and the production build.
- The final MSI installer completed with exit code 0 and its installed `app.asar` matched the latest packaged payload by SHA-256. A rebuilt NSIS EXE was blocked by Windows application control, so the release uses standard Windows Installer instead. No security settings were changed.
