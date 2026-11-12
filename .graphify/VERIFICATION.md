# Graphify verification — 14 October 2026 (Asia/Kolkata)

Installed official `graphifyy==0.9.89` with Python 3.12.10 in `.graphify/env`. The canonical upstream skill/references live in `.graphify/skill`, with thin project discovery entries for Codex, generic agent skills and Claude. Root AGENTS.md/CLAUDE.md require query-first navigation and map/vault maintenance before completing edits. Existing app changes were preserved; this integration adds developer tooling only.

## Final map

| Check | Result |
| --- | --- |
| Supported corpus | 130 inputs: 111 code/config/style files, 11 documents, 8 images |
| Directed graph | 1,134 nodes, 2,266 edges |
| Semantic nodes | 93 document/image nodes, 19 source files |
| File-only coverage | 17 code/style files; explicitly listed in GRAPH_REPORT.md |
| Missing supported source files | 0 |
| Excluded/deleted source files still mapped | 0 |
| Duplicate node IDs / dangling exported edge endpoints | 0 / 0 |
| Absolute source paths / absolute manifest keys | 0 / 0; portable across clones |
| Pending semantic extraction / stale input hashes | 0 / 0 at completion |
| Obsidian export | 1,205 symbol/community notes; additional current document/image mirrors and START_HERE.md |
| Canvas | 1,205 nodes; 200 preview connections; every note target exists |
| Vault synchronization | graph.json SHA-256 matches exported vault certification |
| HTML | Nonempty; all 3 inline JavaScript blocks parse |

The canvas uses upstream's preview connection limit; the linked symbol notes and graph JSON retain the exported navigation graph. Open `.graphify/obsidian` as the vault and use Graph view for linked-note exploration.

## Successful behavioral checks

- Three real scoped queries located assistant/draft code, Whisper recognition/preview worker code, and task-flow/blocker code. Representative locations were verified against source: PlannerAssistant at `src/main/assistant.ts:25`, its database import at line 4, PlannerDatabase at `src/main/database.ts:13`, task-flow layout at `src/shared/task-flow.ts:6`, and local Whisper model loading in `speech/worker.py:61`.
- Qualified `explain src/main/database.ts::PlannerDatabase` returns its methods/importing files. Qualified path from PlannerAssistant to PlannerDatabase returns a 2-hop contains/imports path. Bare database names are ambiguous in this repo, so the guide uses qualified symbols.
- A no-change build prints `AST snapshot reused: 111 unchanged code files; no parsing.` It preserves all 93 semantic node IDs and regenerates both visualization outputs.
- Background watcher **without manual build commands** inserted a new synthetic source function into graph and vault, replaced it after editing, removed the old generated note, and pruned graph/note entries after deletion. Rapid edits during exports exposed a certification race; the final coordinator captures input hashes before parsing, marks rebuilds incomplete until verification passes, and retries changes made during a build. The final lifecycle run passed.
- A supplemental CSS fixture was automatically added to the map/vault, its modified content hash was refreshed, and its entries were removed after deletion. All current `src/` files, including `styles.css`, are represented.
- A synthetic new document was automatically mirrored with its latest text, indexed at file/heading level, and marked `pending_semantic`. Strict verification rejected it. Claude's Stop hook returned valid blocking JSON requesting real extraction. Deleting the fixture removed the pending state and mirror automatically.
- An intentionally malformed semantic snapshot caused a visible `retrying` watcher state while preserving the existing graph. Restoring the snapshot triggered recovery/reverification. The incomplete-build marker remains until successful map/vault validation; it prevents failed exports or transient input errors from being falsely certified current.
- Start/stop/restart and duplicate-start prevention were verified. The watcher runs hidden with a heartbeat/PID/logs, and the user-scoped Windows Startup shortcut was created and inspected. Sign-out/reboot itself was not performed.
- Git post-commit/post-checkout/post-merge adapters were installed without overwriting existing hooks and invoked directly without creating commits. Claude Stop hook emits `{}` for a fresh map. JSON hook configs, Python syntax and Node wrapper syntax were checked. Build locking serializes watcher/hook/manual operations; hook invocations during the error test reported the error and succeeded after recovery.
- The final test left no synthetic source/document fixtures. Environments, caches, runtime state and Obsidian workspace state are ignored by Git. Application runtime dependencies and packaging file selection were preserved.

Rerun the unattended lifecycle test with the watcher running:

```powershell
npm run graphify:watch:start
.graphify/env/Scripts/python.exe .graphify/tests/verify-watch.py
npm run graphify:check
```

The synthetic tests may temporarily report stale/pending/error states by design. Do not run them concurrently with other source edits. Live results and watcher errors are recorded under `.graphify/runtime` (ignored).

## Limits actually observed

- Raw extraction includes 157 unresolved endpoint references; upstream resolves them into reference nodes during build. The exported graph has zero dangling endpoints. Raw extraction also contains 26 self-loops and 107 same-endpoint relationships that the upstream directed navigation graph aggregates. `output/diagnostics.json` and GRAPH_REPORT.md disclose these limits. This is a navigation map, not a lossless runtime call graph.
- Some top-level scripts/tests/configs have only file-level coverage; dynamic callbacks, Electron IPC and runtime behavior may need targeted source inspection. Legacy documents contain historical behavior and a context-size discrepancy, represented with historical/ambiguous provenance rather than assumed current truth.
- Upstream detection omits CSS. The project coordinator supplements `src/**/*.css` with honest file-level nodes and uses Graphify's ignore predicate; every file currently under `src/` is represented, and stylesheet edits participate in freshness/watching. CSS selectors/cascade semantics are not parsed.
- Initial semantic extraction used the host Codex session. Exact token counts are unavailable; zero report counters are disclosed placeholders. Automatic AST/vault refresh makes no model calls. No token-saving percentage is claimed.
- The browser tool rejected the local HTML URL because its policy permits only HTTP/HTTPS. No alternate browser route was attempted. HTML structure/inline scripts and Obsidian canvas/links were verified as files; interactive browser/Obsidian rendering was **not** visually verified.
- Monitoring requires this machine, the project environment and a running watcher. It resumes at sign-in and retries failures, but a stopped process, powered-off computer, moved checkout or unsupported input cannot have a literal forever guarantee. New clones need environment restoration plus `npm run graphify:hooks`. Semantic understanding of changed docs/images still requires an agent or configured model; current source mirrors remain automatic.
