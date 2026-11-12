# Current product brief — Bloom

MYMIND is a private Windows planner for personal/project tasks and a day/time calendar, with local Ollama assistance and reviewed local dictation. The current Bloom template is the design authority: pastel blocks, pixel flowers/cat, Nunito and Silkscreen. Historical Miro and V2 references explain provenance; their month-row layout, shared Date coupling and immediate AI saving do not describe current behavior.

Tasks have optional independent deadlines, displayed as derived all-day Deadline markers. Each task can have many planned or actual sessions with independent dates, times and notes. A session can link to a checklist step. Standalone sessions have no completion checkbox. Activity reports do not imply completion. Completed tasks archive after 24 hours, while their calendar sessions remain; deleting tasks or steps detaches sessions.

Every AI action produces one pending preview, including corrections and conversational Undo. Clear work waits with unresolved required details until the whole batch is ready. Hover/focus reveals changes; Apply saves one atomic undoable batch and Dismiss saves nothing. Manual editing remains immediate except when editing proposed records or proposal-only references. Concurrent edits require refreshed review and explicit conflict choices.

Explicit deletion is resolved against planner records, including corrections that keep a previously named item. Associated sessions are included only when requested and only through their stored task links. Ambiguous deletion requests ask for clarification before producing a proposal.

Settings persists Light, Dark or live System appearance. Existing users start in Light. Dark uses warm charcoal while preserving the Bloom world. The model picker lists installed local Ollama library weights with verified completion and tool capabilities. The default is qwen3.5:4b with a 16,384-token requested context. Invalid saved choices stay visible as unavailable with a route to choose an eligible model. Context settings report actual active context and larger windows consume more memory.

Recording → Stop → transcript review → Send. Unsent audio and transcript versions persist locally for recovery. Read AI replies aloud using a local voice. Off by default. Closing quits all owned local processes; minimizing keeps the planner running. Other Ollama instances stay separate.

Acceptance requires exact no-write-before-Apply assertions, independent sessions/deadlines and completion, overnight/midnight/category reuse, stale/conflict handling, compact Light/Dark/System native interaction, reviewed dictation safety, real-model mixed tool proposals/corrections/Apply, restart persistence and fresh Graphify map/vault. Test data must be isolated from the owner's planner. No cloud inference, downloads, sync, recurrence, dashboard or weight training is introduced.

See [PRODUCT.md](../PRODUCT.md), [DESIGN.md](../DESIGN.md), [README.md](../README.md) and [VALIDATION.md](../VALIDATION.md) for current scope, operation and evidence. The [legacy screenshot](legacy/README.md) and [V1 README](legacy/V1_README.md) remain historical references.
