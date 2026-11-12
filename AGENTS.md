# MYMIND agent instructions

Read `.graphify/AGENT_GUIDE.md` before exploring or editing this codebase. Use `npm run graphify -- query "<question>" --budget 1500` before broad source searches. The persistent map lives in `.graphify/output/`; the Obsidian vault is `.graphify/obsidian/`.

After every batch of codebase edits, run `npm run graphify:build` and `npm run graphify:check` before finishing. Refresh changed document/image semantic fragments first when required. Do not finish with a stale map or vault, or advance hashes without actual extraction. The background watcher and Git hooks are additional safeguards, not permission to skip completion checks.

Use the project `$graphify` skill; its canonical instructions live in `.graphify/skill/SKILL.md`. If the environment/watcher is missing, restore it using `.graphify/SETUP.md` and `npm run graphify:hooks`. Preserve unrelated user work.
