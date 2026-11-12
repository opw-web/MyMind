# Always-current map workflow for Codex and Claude

All substantive Graphify tooling, graph outputs, logs, documentation and the Obsidian vault are under `.graphify/`. Root AGENTS.md/CLAUDE.md, thin skill discovery files, assistant hook config, `.graphifyignore`, package scripts and Git hooks are the standard-location entry points.

## On a codebase question

1. Run `npm run graphify:status` once per session. If source is stale, run `npm run graphify -- hook` to refresh current code and vault immediately. Any `pending_semantic` entries still require host-agent extraction before strict verification can pass.
2. Run `npm run graphify -- query "<question>" --budget 1500` before your first broad grep/source read. Use the returned paths for targeted inspection. For ambiguous names, use qualified symbols, for example `npm run graphify -- explain "src/main/database.ts::PlannerDatabase"`.
3. Trace relationships with `npm run graphify -- path "src/main/assistant.ts::PlannerAssistant" "src/main/database.ts::PlannerDatabase"`. A map guides source reads; it does not prove runtime behavior. If a concept is missing or file-only, run a narrow source search. Read `.graphify/output/GRAPH_REPORT.md` only for broad architecture.

## After edits, before finishing

1. Update semantic extraction for any changed/new docs, images or other semantic inputs. Read `.graphify/skill/SKILL.md` and its `references/extraction-spec.md`; use the running host session, no separate API key required. Preserve unchanged fragments in `.graphify/output/semantic.json`. Replace affected nodes/edges/hyperedges with actual extracted content and update only source hashes for content you inspected. Node provenance in the saved snapshot uses repo-relative paths. Keep deterministic IDs, honest confidence and `_origin: semantic`. Never stamp a file as extracted just to suppress an error.
2. Run `npm run graphify:build` then `npm run graphify:check`. This refreshes **both** the map and the Obsidian vault. If the upstream shrink guard detects an intentional deletion, inspect the diff and use `npm run graphify -- build --force`.
3. Do not complete the task with stale outputs or pending semantic extraction. If a real environment/dependency failure prevents the update, report that concrete failure and preserve the last valid map. Never claim universal/permanent freshness when the machine is off, the watcher is stopped, the project moved, or an unsupported input cannot be parsed.

## Automatic safeguards

- A hidden Python watcher checks supported project inputs every three seconds, debounces until two observations match, and refreshes graph/report/HTML/Obsidian after source changes. No model calls during unattended refresh. It retries failures, records heartbeat/error state in `.graphify/runtime/watch-status.json`, and refreshes after restart/sign-in. It detects additions, modifications, deletions and ignore-policy changes, including uncommitted edits by any editor.
- Git post-commit, post-checkout and post-merge hooks run the same refresh command. Existing hooks are preserved. They are installed by `npm run graphify:hooks` on each clone and share a build lock with the watcher.
- Claude gets graph-first read/search hooks and a Stop hook that performs refresh and requests semantic extraction when needed. Codex's hook is upstream's no-op because this desktop rejects additionalContext; root AGENTS instructions and the independent watcher provide the safeguards.
- Changed documents/images cannot be semantically interpreted by an AST-only watcher. It removes stale semantic claims, indexes current filenames/headings, mirrors the latest docs/images into Obsidian, and marks `pending_semantic`. Strict check fails until an agent does real extraction. This keeps current code and source documents available without pretending new document meaning was already understood.

## Commands and paths

Use `npm run graphify:watch:start`, `npm run graphify:watch:stop`, or foreground `npm run graphify:watch`. Inspect the watcher PID/heartbeat and logs under `.graphify/runtime/`. A Windows Startup shortcut restarts it at user sign-in; the shortcut and Git hooks are restored with `npm run graphify:hooks`. Stopping the watcher affects current monitoring; remove the generated Startup shortcut recorded in `runtime/hooks.json` if you want monitoring disabled across sign-ins.

Open `.graphify/obsidian` as an Obsidian vault. Use Graph view or `graph.canvas`. Generated symbol/community notes are managed exports. Keep your own notes in another folder inside the vault; refresh prunes only exporter-owned notes. `SourceDocuments/` contains generated mirrors of current documents/images. They are not source files to edit. The vault's `.obsidian/workspace*.json` is ignored.

The pinned tool is `.graphify/env` with graphifyy 0.9.89. `npm run graphify -- ...` selects this environment and sets `GRAPHIFY_OUT` correctly. Do not run bare global graphify or upstream `update/watch` here: those bypass project vault/freshness coordination. The project builder reuses a complete AST snapshot when code is unchanged; source changes rerun cross-file extraction because upstream intentionally bypasses JS/TS per-file caches.
