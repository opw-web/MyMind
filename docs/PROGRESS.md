# MYMIND migration progress

Updated 2026-11-12.

## Source and Windows installation

- GitHub `main` contains the recovered 2.4.0, 2.5.0, and installed Electron 2.5.1 source snapshots. Tauri 2.6.0 is tagged `v2.6.0-source`. The publication used synthetic fixtures in place of personal test transcripts.
- The corrected native Tauri MSI passed upgrade, retained-data, and rollback checks in an isolated Windows guest. The packaged app also migrated committed v8 write-log data to v9 and retained it in the backup.
- Smart App Control returned error 4551 for the unsigned native executable on the Desktop PC. The original **MYMIND** shortcut opens the working Electron 2.5.1 install.

## Tauri Desktop fallback

- **MYMIND Tauri (WSL)** starts the Linux Tauri 2.6.0 app through WSLg. It uses a separate local copy of the existing planner. The copies do not sync.
- The app owns its local CPU Ollama server and Qwen 3.5 4B runner. Ollama reads the existing model files and uses a verified 32K context. Linux speech runs the bundled models through a private Python environment.
- Closing the app stops the model server, runner, and speech worker. The WSL launcher also stops helpers it started, including WebKit and accessibility processes that can run in separate sessions. The shortcut close test observed all 11 tracked processes exit and the model port close. A separate test with speech active confirmed that its process and port closed.

## Desktop readability and Settings

- The old WebKit Settings dialog reserved 40 CSS pixels for 653 pixels of controls and text. Its Appearance control started below the visible content, even in a large window.
- The WSL shortcut starts maximized at 150%. Use **Ctrl + Plus** and **Ctrl + Minus** to adjust between 100% and 200%, and **Ctrl + 0** to restore 150%. The WSL app remembers your scale.
- Settings uses a taller, wider layout with readable controls, a scrollable content area, and a header and footer that stay in view. It keeps the appearance, model, context, and speech settings available in smaller windows.
- Closing Settings returns keyboard focus to the Settings button. The native smoke test checks that the content area has room for its controls and that the Appearance selector is visible.

## Verification and deployment

- WebKitGTK tests at 1440 × 900 and 940 × 620 confirmed that Settings shows Appearance and keeps the header and footer in view. With the 150% scale, the content area measured about 447 and 260 CSS pixels respectively. The smaller window scrolled to the last control without horizontal overflow.
- Zoom in and reset changed the measured viewport, and the chosen scale survived a reload. Electron UI tests covered keyboard navigation, light and dark appearance, and window sizes down to 320 × 260.
- The native desktop smoke test passed Settings, calendar startup, deletion preview, Apply, Undo, and binary dictation recovery. It now opens a visible test window to measure layout and uses a prompt that matches the synthetic deletion fixture.
- The existing Tauri shortcut was relaunched and verified against the rebuilt executable. The new window filled its monitor work area. The previous executable is retained at `/opt/mymind-desktop/rollback/MYMIND-before-display-settings` for local rollback.
