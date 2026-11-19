# MYMIND agent instructions

## Mandatory AI action flow

Read `README.md` under **AI-only assistant contract** before changing assistant, voice, planner actions, navigation, prompts, tools, or tests. Every submitted assistant message must reach Ollama. The model must interpret the request and issue the tool calls that choose and initiate its actions. Preserve `find_items` → `stage_changes` → `finish_request` as the supported lookup, staging, and commit protocol, with lookup used when needed.

Never add a natural-language parser, regex intent router, keyword authorization gate, deterministic task-list splitter, canned-action handler, or fallback that performs assistant actions without model tool calls. Never infer or rewrite task titles, dates, steps, relationships, or actions from the user's wording in application code. Fix model behavior through its tools, prompt, context, or surfaced errors. Keep legacy interpretation helpers unreachable from the production assistant. Any exception requires an explicit new user request changing this contract.

Retain deterministic tool validation, ID lookup, persistence, transactions, UI rendering, and explicitly clicked manual controls. These implement the model's tool requests and the user's direct controls. Preserve the model-call regression tests in `tests/assistant-applied.test.ts`, including the five-task example. Changes touching this flow must verify that a message reaches Ollama and that assistant edits and navigation occur only after model-issued tool calls.

Read `.graphify/AGENT_GUIDE.md` before exploring or editing this codebase. Use `npm run graphify -- query "<question>" --budget 1500` before broad source searches. The persistent map lives in `.graphify/output/`; the Obsidian vault is `.graphify/obsidian/`.

After every batch of codebase edits, run `npm run graphify:build` and `npm run graphify:check` before finishing. Refresh changed document/image semantic fragments first when required. Do not finish with a stale map or vault, or advance hashes without actual extraction. The background watcher and Git hooks are additional safeguards, not permission to skip completion checks.

Use the project `$graphify` skill; its canonical instructions live in `.graphify/skill/SKILL.md`. If the environment/watcher is missing, restore it using `.graphify/SETUP.md` and `npm run graphify:hooks`. Preserve unrelated user work.
