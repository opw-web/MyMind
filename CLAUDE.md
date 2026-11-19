# MYMIND Claude instructions

Read and follow `AGENTS.md` under **Mandatory AI action flow** and `README.md` under **AI-only assistant contract** before changing assistant behavior. Every submitted message goes to Ollama. All assistant actions and navigation must originate in the model's tool calls. Never introduce parsers, regex intent routing, canned actions, or deterministic fallbacks that bypass model decisions. Keep legacy interpretation helpers unreachable from the live assistant and preserve the model-call regression tests in `tests/assistant-applied.test.ts`. An exception requires an explicit new user request changing this contract.

Read `.graphify/AGENT_GUIDE.md` before codebase exploration or edits. Consult the map through `npm run graphify -- query "<question>" --budget 1500`, then verify relevant behavior in the located source files.

After every batch of edits, refresh changed document/image semantic fragments and run `npm run graphify:build` plus `npm run graphify:check` before finishing. Both the map and `.graphify/obsidian/` vault must be current. The Stop hook, watcher and Git hooks provide additional safeguards; never skip a failed check or simply advance semantic hashes.

Use `/graphify` with canonical skill instructions at `.graphify/skill/SKILL.md`; use the pinned project wrapper instead of bare global commands. Restore missing tooling/hooks from `.graphify/SETUP.md`. Preserve unrelated user work.
