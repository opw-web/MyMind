# MYMIND Claude instructions

Read `.graphify/AGENT_GUIDE.md` before codebase exploration or edits. Consult the map through `npm run graphify -- query "<question>" --budget 1500`, then verify relevant behavior in the located source files.

After every batch of edits, refresh changed document/image semantic fragments and run `npm run graphify:build` plus `npm run graphify:check` before finishing. Both the map and `.graphify/obsidian/` vault must be current. The Stop hook, watcher and Git hooks provide additional safeguards; never skip a failed check or simply advance semantic hashes.

Use `/graphify` with canonical skill instructions at `.graphify/skill/SKILL.md`; use the pinned project wrapper instead of bare global commands. Restore missing tooling/hooks from `.graphify/SETUP.md`. Preserve unrelated user work.
