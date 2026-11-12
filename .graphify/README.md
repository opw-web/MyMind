# MYMIND Graphify integration

All substantive tooling lives here. Graphify is developer tooling; MYMIND's runtime and installer do not depend on it.

| Folder/file | Purpose |
| --- | --- |
| `env/` | Isolated graphifyy 0.9.89 environment, ignored |
| `requirements.lock.txt` | Exact installed Python tooling dependency versions |
| `skill/` | Canonical upstream skill and references |
| `output/` | Portable graph, report, HTML, semantic snapshot, content hashes and diagnostics |
| `obsidian/` | Obsidian vault: linked symbol/community notes, canvas and current source-document/image mirrors |
| `runtime/` | Ignored watcher PID, heartbeat, errors, logs and locks |
| `run.cjs`, `project.py` | Pinned CLI wrapper and coordinated builder/checker/watcher |
| `*-watch.ps1`, `install-hooks.ps1` | Windows lifecycle, user sign-in startup and Git hook registration |
| `AGENT_GUIDE.md` | Required Codex/Claude workflow |
| `SETUP.md` | Portable install/map/verify instructions for any repository |
| `VERIFICATION.md` | Actual checks and limitations |

Only standard discovery entry points stay outside this folder: AGENTS.md, CLAUDE.md, thin skill wrappers, assistant hook JSON, `.graphifyignore`, npm script entries and Git hooks. Existing user changes were preserved.

## Use

```powershell
npm run graphify:status
npm run graphify -- query "PlannerAssistant prepareDraft" --budget 1500
npm run graphify -- explain "src/main/database.ts::PlannerDatabase"
npm run graphify -- path "src/main/assistant.ts::PlannerAssistant" "src/main/database.ts::PlannerDatabase"
npm run graphify:build
npm run graphify:check
npm run graphify:watch:start
npm run graphify:watch:stop
npm run graphify:hooks
```

Open **.graphify/obsidian** as a vault in Obsidian. Use **Graph view** or open **graph.canvas**. Symbol notes have wikilinks, source locations, confidence and community tags. `SourceDocuments/` mirrors current docs/images. Keep personal notes in another folder; generated notes are managed exports. The exporter only prunes notes it owns and preserves unrelated vault notes/preferences.

Codex uses `$graphify`; Claude uses `/graphify`. Read [AGENT_GUIDE.md](AGENT_GUIDE.md) for their graph-first and mandatory completion-check instructions. Query results guide targeted source reads. Qualify ambiguous symbols with `path::symbol`.

## Automatic maintenance

A hidden watcher polls every three seconds, waits for stable changes, and refreshes graph/report/HTML plus Obsidian for any detected addition/edit/deletion, including uncommitted work from other editors. A user-scoped Windows Startup shortcut restarts monitoring at sign-in. Git post-commit/post-checkout/post-merge hooks call the same coordinator. Claude's Stop hook refreshes and checks completion. Codex has persistent AGENTS guidance and an independent watcher; its upstream PreToolUse hook is intentionally a no-op on this desktop.

Watcher and hook builds share a process lock. Errors remain visible in `runtime/watch-status.json` and are retried. A graph/vault synchronization fingerprint prevents a failed export from being certified current. No-change builds reuse the AST snapshot without parsing. Source changes rerun cross-file extraction, using upstream caches where supported; Graphify intentionally bypasses JS/TS per-file caches. An intentional manual deletion may require `npm run graphify -- build --force`; the debounced watcher accepts observed deletions automatically.

Stop monitoring with `graphify:watch:stop`. To disable future sign-in starts, remove the generated shortcut recorded in `runtime/hooks.json`. `npm run graphify:hooks` restores registration after a clone/move. A stopped/crashed watcher, moved folder, switched branch lacking tooling, unavailable environment or powered-off computer cannot guarantee immediate updates; agent/Git checks and sign-in startup provide recovery. No literal permanent guarantee is claimed.

## Semantic freshness and coverage

The initial host-agent pass mapped current and legacy documents plus images into `output/semantic.json`, with relative provenance, real source locations, confidence and SHA-256 hashes. Changed documents/images are automatically mirrored to Obsidian and indexed at file/heading level; stale semantic claims are removed. They appear in `pending_semantic` and strict check fails until Codex/Claude actually re-extracts them. The running session can do this without a separate API key. Unattended rebuilds make no model calls. Unknown initial semantic token counts are disclosed in the report.

Ignored inputs include dependencies, compiled/release output, speech binaries/environments, graph/vault output, installed skills/control files, lockfiles/license copies and private databases/audio/secrets. Source, tests, scripts, manifests/config, speech requirements, project docs and screenshots remain mapped. Some files have only file-level coverage because the parser returns no symbols. Dynamic dispatch/IPC and runtime behavior still need targeted verification. The directed navigation graph resolves reference endpoints; upstream aggregates some parallel relationships and retains self-loops. Counts and raw diagnostic limits are recorded in [VERIFICATION.md](VERIFICATION.md).

Install on a fresh machine using [SETUP.md](SETUP.md), restore the local environment (`uv pip install --python .graphify/env/Scripts/python.exe -r .graphify/requirements.lock.txt` on Windows after creating it), and run `npm run graphify:hooks`. The lock records the tested Python 3.12 tooling versions; verify dependency compatibility when changing Python/OS. The repository includes the portable semantic seed. Generate the graph and vault in each checkout.

Upstream: https://github.com/Graphify-Labs/graphify
