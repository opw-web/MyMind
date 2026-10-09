# MyMind 1.1.0

Install `MYMIND-Setup-1.1.0.msi`, then open **MYMIND** from the Windows Start menu. Install Ollama and download `qwen3.5:4b` if you do not already have them. The installer bundles Faster Whisper and its base model; it does not require Python or a speech API key.

- Horizontal month-row calendar, colored events, multi-day/time support, and synchronized dated tasks.
- Projects and sections, Today/overdue lists, completion and reopening.
- Local Qwen tools that create, edit, move and delete planner records, with clarification and atomic changes.
- Microphone beside Send, visible live transcription, audio-level feedback, final transcription, cancellation and optional sending after a pause.
- Upper-left Undo and Ctrl+Z, including after an AI request with the empty chat box focused.
- Closing or crashing the app terminates its owned Ollama and Whisper processes.

Real Qwen creation/deletion/completion/reopening and voice-to-calendar tests passed. Verification uses synthetic microphone input; check your selected physical input device in Windows. Planner data is stored under `%LOCALAPPDATA%\MYMIND` and is kept separate from the install folder.

The MSI was installed and its payload verified on the target Windows PC. The public README records the original vision, current scope, architecture, building, tests and privacy behavior. SHA-256 checksums accompany the download.
