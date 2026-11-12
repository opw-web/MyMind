# Install, map and verify Graphify in this project

**Instruction to Codex:** Execute this guide against the current project root. Complete installation, mapping and verification. Preserve existing user work. Do not stop at a plan or claim success because installation alone passed. This guide is portable: it contains no MYMIND-specific machine paths. Adapt to the repository and actual tool version; environmental failures must be reported accurately rather than described as flawless.

Official upstream: https://github.com/Graphify-Labs/graphify
Official Python package: **graphifyy** (double y); CLI: **graphify**.
Baseline tested version: **0.9.89**, with Python **3.12** on Windows.

## 1. Inspect and install

1. Identify the project root, OS, shell, Git status, existing AGENTS instructions, installed Graphify/skills, supported source languages and build/generated/data directories. Respect existing instructions and preserve unrelated edits. Do not scan node_modules, venvs, vendored binaries or private databases to discover the application.
2. Verify current official upstream installation and CLI instructions. Pin an explicit release; use 0.9.89 for the tested baseline or select and verify a newer release. Do not install similarly named unaffiliated packages. Never change an app's runtime dependencies to add developer Graphify tooling.
3. Use an isolated project environment `.graphify/env`, preferably Python 3.12. Reuse it only if its package/version/imports check out. If it belongs to other tooling, choose another name. Quote all paths and use this environment's absolute interpreter/CLI path instead of trusting a global PATH entry.

Windows PowerShell baseline (check each native exit code; stop on failure):

```powershell
python --version
python -m venv .graphify/env
& ./.graphify/env/Scripts/python.exe -m pip install 'graphifyy==0.9.89'
& ./.graphify/env/Scripts/graphify.exe --version
& ./.graphify/env/Scripts/graphify.exe install --project --platform codex
& ./.graphify/env/Scripts/graphify.exe install --project --platform agents
```

macOS/Linux baseline:

```sh
python3 --version
python3 -m venv .graphify/env
.graphify/env/bin/python -m pip install 'graphifyy==0.9.89'
.graphify/env/bin/graphify --version
.graphify/env/bin/graphify install --project --platform codex
.graphify/env/bin/graphify install --project --platform agents
```

If Python/venv/pip is missing, use an available trusted runtime or `uv venv --python 3.12 .graphify/env` and `uv pip install --python <environment-python> 'graphifyy==0.9.89'`. If network/dependencies are unavailable, report the actual blocker and preserve existing output. Do not claim completion. Do not install every optional extra: add PDF/Office/SQL/transcription support only when the project needs it.

4. Inspect which files the upstream installer actually wrote. It may use `.codex/skills` for Codex and `.agents/skills` for generic discovery; retain the installed SKILL.md **and references/**. Read the installed Graphify skill before running its extraction workflow. The installer should merge its guidance into AGENTS.md, preserving prior content. Correct any instructions that would invoke the wrong global CLI. Do not overwrite user config or enable global multi-agent settings without a need; sequential host extraction can cover docs when delegation is unavailable.
5. Add the local environment/caches/scratch files to `.gitignore`, merging rather than replacing. Create/merge `.graphifyignore` to exclude dependencies, compiled/release output, caches, local databases/audio, secrets, generated graph output and installed agent tooling. Keep real source, tests, scripts, app manifests/config/schema files and project docs. Make exclusions explicit in the coverage report. Never assume ignore rules worked: validate detected paths.
6. Record the tested interpreter and package versions in a `.graphify/requirements.lock.txt` or equivalent tooling lock. On an existing integrated project, restore that lock instead of blindly resolving newer transitive dependencies. Adapt platform-specific dependencies and verify the resolved install when moving between Python versions/operating systems.

## 2. Map the working tree and wire future sessions

**Required layout:** Put substantive tooling in **one `.graphify/` folder**: `env/`, `skill/` (full upstream SKILL.md and references), `output/` (graph/report/HTML/semantic snapshot/hashes/manifest), `obsidian/` (vault), `runtime/` (ignored PID/heartbeat/logs/locks), wrapper/build/watch/hook scripts, agent guide and verification record. Keep only thin discovery/configuration entry points in standard locations: root AGENTS.md and CLAUDE.md, `.agents/skills/graphify/SKILL.md`, `.codex/skills/graphify/SKILL.md`, `.claude/skills/graphify/SKILL.md`, assistant hook JSON, root `.graphifyignore`, package commands and installed Git hooks. Discovery wrappers must instruct the agent to read the canonical central skill/guide. Preserve full upstream references centrally. Set `GRAPHIFY_OUT` to `.graphify/output` **before importing Graphify**; derive paths from the project root, not machine-specific defaults. Inspect and migrate only files created for this integration; preserve existing skills/config.

1. Detect the supported corpus using the installed skill. Map actual current files, including legitimate uncommitted source. Report code/docs/images/PDF/media counts and any unsupported or excluded inputs. A binary-only or empty repository cannot yield a complete source map; state that limit.
2. Run local AST extraction for code. For docs, PDFs, configs classified as documents, and images, perform the skill's semantic extraction with the running Codex session or an already authorized configured backend. No separate API key is required for host extraction. Inspect images visually and distinguish historical screenshots/docs. Never represent a code-only run as mapping documents. Transcribe relevant media using the upstream workflow when necessary.
3. Follow the skill's merge/build pipeline, using one consistent project root. Preserve source provenance, real locations, deterministic IDs, confidence and `_origin` tier tags. Use a directed graph where calls/dependencies matter. Resolve dangling endpoints and conflicting IDs. Account explicitly for files with no extracted symbols using honest file-level nodes, or report them as coverage gaps. Do not invent calls to fill gaps.
4. Persist `.graphify/output/graph.json`, `GRAPH_REPORT.md`, and `graph.html`. Keep the manifest needed for incremental updates. Use relative source paths so a graph remains usable after cloning. Preserve semantic fragments/cache with provenance, source content hashes and version metadata. Do not commit machine-specific environment paths or private data. If host token usage is unavailable, state that; zero placeholder counters do not mean zero semantic cost.
5. Add a project-native wrapper (`npm run graphify -- ...` for Node projects, or equivalent) that selects the pinned local interpreter, handles paths with spaces, forwards exit status and reports a missing environment clearly. Provide commands for **build/update, freshness/status, verify, query, explain and path**. Avoid bare global graphify if its version differs. When implementing wrappers, use subprocess argument arrays rather than shell-string interpolation.
6. Add/merge a concise AGENTS.md section: consult the graph first for codebase questions, use scoped query output (about 1,500 tokens), use explain/path for relevant concepts, then read only located source to verify behavior. Read the full report only for broad architecture. If queries miss, use a targeted source search. Check freshness once at session start and refresh after source changes. Code refresh must reuse cached AST and preserve validated semantic content; changed docs/images require actual re-extraction before their hashes advance. Document how to restore the environment in a fresh clone. Do not blindly rewrite AGENTS with a template.
7. Make updates explicit and efficient. Hash supported inputs and ignore policy to detect new/modified/deleted/excluded files. A stale semantic map must fail verification or clearly report pending extraction. Rebuild after intentional deletions and honor upstream shrink guards; force only after inspecting the deletion. Choose project commands over intrusive watchers or hooks unless requested. If adopting upstream Git hooks, preserve preexisting hooks and verify their execution/environment.

## 2b. Obsidian and automatic refresh — required

The user requests automatic maintenance and an Obsidian vault. Implement and test these, not just instructions about them:

1. Export the graph with the official Obsidian exporter to `.graphify/obsidian`, including linked node/community notes, community colors and a `.canvas` file. Tell the user to open that exact folder as a vault. Generated content must remain distinct from personal notes. Use the exporter's ownership manifest to prune only managed notes after deletions. Preserve user-created notes and `.obsidian` preferences; ignore workspace state. Mirror latest source documents/images into managed vault notes, preserving original source provenance. Never edit source by editing a mirror.
2. Every successful build/update must regenerate JSON/report/HTML **and Obsidian**. Write freshness metadata only after all exports succeed. Store a vault synchronization fingerprint of graph.json; verification must reject a missing/outdated vault. A partial export failure must remain stale and retryable, even if graph.json was already written. Use a process lock to avoid watcher, hooks and agent builds racing.
3. Install an editor-independent file watcher that detects supported inputs and ignore-policy changes, including uncommitted additions/edits/deletions. Use a short polling interval or appropriate filesystem events with a stable-change debounce, bounded work and retry handling. Avoid indexing outputs, environment or vault back into the graph. Confirm actual idle resource use is reasonable; no repeated AST parsing when nothing changed. Reuse an unchanged full AST snapshot where upstream deliberately bypasses JS/TS per-file caches. On a change, keep cross-file resolution correct rather than stitching unsafe per-file caches.
4. Make monitoring persistent for the user's OS. On Windows, provide hidden start/stop commands and a user-scoped Startup shortcut (or a verified scheduled task) so monitoring resumes on sign-in. Use `python.exe` under a hidden launch when child CLI exports require stdout; do not assume pythonw behaves identically. On macOS/Linux use an appropriate user service/login mechanism and verify it. Store lifecycle/log/heartbeat state inside `.graphify/runtime`. Provide a clear disable/uninstall path. Do not weaken OS protections. A moved/cloned project needs its environment and OS/Git registration restored; document that honestly.
5. Install Git post-commit, post-checkout and post-merge refresh adapters, preserving existing hooks and honoring `core.hooksPath`. Track installation scripts under `.graphify` because `.git/hooks` does not travel with a clone. Hooks must use the pinned wrapper and refresh Obsidian as well. Test hooks by invoking them without creating unwanted commits.
6. Install both **AGENTS.md** (Codex) and **CLAUDE.md** (Claude), requiring graph-first navigation and a successful map/vault refresh before every completed editing task. Install Claude's supported graph-first read/search hook and a **Stop hook** that refreshes and checks the map/vault, returning valid hook JSON and requesting unresolved semantic extraction when needed. Avoid recursive/infinite stop-hook blocking. Respect Codex's actual hook support: if its hook is a no-op, use persistent AGENTS guidance plus the independent watcher instead of inventing unsupported hooks. Do not claim an instruction file alone enforces every possible agent/tool action.
7. An unattended AST watcher cannot infer new document/image meaning without a host agent or configured model. It must still update current code, filenames/headings and source-document/image vault mirrors, remove stale semantic claims, mark affected inputs `pending_semantic`, and fail **strict** verification until the running agent extracts them. Never silently retain outdated concepts as current, advance semantic hashes without extraction, require an unprovided API key, or pretend the watcher's deterministic refresh is a semantic model. If an already authorized local model is configured, semantic automation may be added with explicit error/cost handling; otherwise agent completion instructions/Claude Stop handle pending extraction.
8. Verify unattended add/change/delete updates by waiting for the watcher rather than manually invoking builds. Confirm corresponding Obsidian note insertion/replacement/removal. Test a new/changed document: current content must be mirrored, semantic pending state visible, and strict verification must reject it. Test restart, duplicate-start prevention, hook invocation, concurrent-build locking and failure retry. Ensure no test fixture remains. Record observed refresh latency and any limits. No process can promise literal "forever" across power-off, crashes or unsupported inputs; report implemented safeguards and recovery precisely.

## 3. Verify with evidence

Complete these checks before declaring success:

- Import the pinned package and confirm CLI version; verify the project skill and sidecar references are installed and AGENTS guidance uses the intended executable.
- Parse graph JSON; verify nonempty unique node IDs, valid edge endpoints and directed semantics where applicable. Run upstream graph diagnostics; disclose aggregation/self-loop/dangling warnings and actual parser limitations.
- Compare **every detected input** to graph provenance. Verify exclusions are absent. Report exact file-level versus symbol-level coverage; unsupported files cannot be called fully mapped.
- Also compare the repository's actual application-source inventory to detection. Common omissions such as CSS must not disappear silently: supplement unsupported source types with honest file-level nodes and freshness/watch coverage (respecting ignore rules), or explicitly list the remaining omission. File-level inclusion is not a claim that language semantics were parsed.
- Verify nonempty report, HTML and incremental manifest. Open/inspect HTML when a browser is available and confirm it renders and can search a known project symbol; otherwise explicitly say visual interaction was not checked.
- Run at least three real project queries spanning different subsystems. Run `explain` for a known class/function and `path` for a real connected pair. Confirm results identify correct files/locations against targeted source reads. A zero-exit query with no relevant result is not a passing check.
- Verify freshness detects a temporary new source fixture, changed fixture symbol and deleted fixture. Rebuild/update at each stage; confirm insertion, replacement and removal in the graph. Keep fixtures synthetic, remove them afterward and restore the final map. Check a no-change rebuild uses the cache and preserves semantic nodes. Do not modify existing application files just to exercise freshness.
- Verify changed documents/images become pending semantic extraction rather than being falsely certified current. Test against a disposable copy or restore a synthetic fixture carefully. Verify stale/noncurrent graph checks fail with a nonzero status.
- Run applicable lightweight repository checks if integration altered executable tooling or configuration. Do not run expensive model/speech/packaging tests merely for agent-map metadata.

Write a short project verification record containing package/Python versions, date, corpus counts, graph counts, successful query/path examples, update lifecycle results, commands, exclusions and remaining limitations. State whether HTML was visually checked. Preserve existing app work. Do not claim measured token savings without a relevant benchmark.

## Required completion response

Provide links to the project guide, graph report, interactive graph, and verification record. Explain how to invoke the skill (`$graphify` in Codex) and the wrapper commands in a future session. Confirm that installed skills will be discovered in a new session/next turn, while current commands already work. Clearly distinguish completed checks from blocked or unsupported features. No guide can guarantee flawless execution across all machines; this guide requires verification and accurate failure reporting.
