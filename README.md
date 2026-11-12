# MYMIND Bloom

A private Windows calendar and task planner with a local assistant. Bloom keeps pastel sessions, pixel flowers/cat and a useful bottom composer in a compact day/time workspace.

[Product](PRODUCT.md) · [Design](DESIGN.md) · [Current brief](docs/PRODUCT_BRIEF.md) · [Verification](VALIDATION.md)

## Calendar and Tasks

Calendar is a horizontally scrolling day/time grid with Today navigation, an all-day lane, planned/actual filters, overlap lanes, drag-to-create/move and timed resizing. Select a day for its agenda. Tasks provide Inbox, projects, sections, categories, ordered checklist steps, prerequisites, filters, completion and reopening. Checklist and Flowchart share the same tasks; Flowchart supports zoom, Fit, pan and scrolling. Completed tasks archive after 24 elapsed hours. Calendar sessions remain visible.

A task's optional **Deadline** is independent of its sessions. Deadline markers are derived all-day calendar entries, not extra event records. **Schedule work** creates a session with its own title, dates, optional times, notes and quick notes. A task can have many sessions, optionally linked to a step. Moving a session never moves its deadline. Planned sessions and actual activity remain distinct; reporting work or sleep does not mark a task complete. Actual intervals with missing or ambiguous times stay unresolved until clarified. Overnight intervals use both dates.

Standalone sessions have no completion checkbox. Linked session controls reflect the task or step. Completing a task does not rewrite its step flags. Reopening a linked step under a completed parent reopens that parent and step while retaining other step flags. Deleting a task or step detaches sessions rather than deleting them. Notes and quick text boxes belong to each record independently.

## AI preview and deliberate saving

Ask for tasks, calendar sessions, corrections, deletions, factual activity or explanations. Every AI write path builds **one pending preview**. Proposed records remain unsaved while you review them. Hover or keyboard-focus an item to reveal it on Calendar or Tasks without losing composer focus. Edit proposed records directly or send a correction; new requests join the pending batch.

Press **Apply** to save the entire validated batch once. **Dismiss** saves nothing. Required questions block the whole batch. A manual edit made during preview is retained; refresh the preview and choose each conflicting value explicitly before Apply. Ordinary manual actions save immediately, while edits to proposed records or references remain in the proposal. One planner Undo reverses the whole applied batch. Asking the assistant to Undo prepares another preview. Ctrl+Z edits ordinary text normally.

The assistant never uses conversational text as proof of saving: saved receipts come from successful Apply. Questions and hypotheticals remain read-only. New chat clears transient conversation, selections and the pending proposal. There is no conversation archive, embedding store or learned-preference memory.

For explicit deletion, the planner resolves the named tasks and events before preparing the preview. Corrections such as “actually, keep New Age” take precedence. If you ask to remove a task and its associated events, only sessions linked to that task are included. An ambiguous name needs clarification before any deletion is proposed.

## Appearance and local model

Settings offers **Light**, **Dark** and **System**. Light preserves the approved Bloom template and is the default for existing users. Dark uses warm charcoal and readable pastels. System follows the operating-system preference live, including native controls. Reduced motion is respected throughout.

The model picker lists only installed local Ollama library weights with verified completion and tool support. hf.co, remote/cloud and unreadable/ineligible models are hidden; no model is removed or downloaded by MYMIND. An unavailable saved model is explained and Settings remains available to choose an eligible replacement. MYMIND never silently switches models.

The default is **qwen3.5:4b**, with a requested **32,768-token context**. Its regular planner turns use temperature 0.2, thinking off and a 2,048-token output cap. Settings can select other eligible models and reports the verified active context used by the assistant's budget. Larger windows use more memory. See the verification record for the Qwen 4B sampling comparison.

## Local voice

**Recording → Stop → transcript review → Send.** The meter, elapsed time and live text remain visible while recording. Pauses and view changes do not stop capture. Stop runs full local transcription; the complete transcript remains editable before Send. Cancel and transcription failures retain recoverable work. Saved dictation drafts offer review, retry, copy and discard after a restart/crash. No user microphone is captured by automated acceptance tests.

**Spoken replies:** Read AI replies aloud using a local voice. Off by default. Bundled Kokoro-82M uses the British English bm_george voice on CPU; Stop interrupts speech. Whisper base provides live text and large-v3-turbo provides the final English CPU int8 transcript. Speech assets and their Python runtime are bundled; no API key or first-use speech download is needed. Audio goes only to an authenticated loopback worker and local recovery storage. There is no wake word or always-on listening.

## Storage and lifecycle

Planner data lives in `%LOCALAPPDATA%\MYMIND\planner.sqlite`; recoverable audio/transcripts use the separate `dictation.sqlite`. Settings, records and up to 50 Undo batches persist locally. Schema v9 migrates the earlier shared Date model to independent deadlines and sessions, preserving historical Undo through WAL-safe backup/normalization. Existing calendar placements become independent sessions; data and notes remain intact. Earlier migration descriptions in legacy documents are historical.

Close the app before copying the entire data directory for a manual backup; keep SQLite/WAL companions together. Conversation text and microphone audio do not enter production logs. Unsent dictation remains local until successful Send or explicit Discard.

**Minimize keeps running. Close quits completely.** Owned Ollama and speech workers use Windows Job Objects. Other Ollama instances remain separate. There is no tray mode or sign-in autostart. Manual planning remains available while inference starts or fails. GPU offload is bounded by free startup memory, weight size and layer count with 1.5 GiB headroom; remaining layers run on CPU. Hardware and other applications affect latency.

## Build and verify

Development needs Windows x64, Node 22.13+ and an existing [Ollama installation](https://ollama.com/download/windows) with eligible local weights. Install qwen3.5:4b in Ollama before using the default. Python 3.12 and the pinned speech build environment are needed only when rebuilding bundled speech assets.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:desktop
node tests/preview-desktop.cjs
node tests/preview-review-desktop.cjs
node tests/appearance-desktop.cjs
node tests/deadline-desktop.cjs
node tests/text-box-desktop.cjs
npm run test:qwen4 -- --release-gate --profile=deployed --model=qwen3.5:4b --context=16384
npm run test:qwen4 -- --release-gate --profile=deployed --model=qwen3.5:4b --context=32768
npm run graphify:build
npm run graphify:check
```

The Qwen release gate runs each workflow five times, including the verbatim deletion, a semantic deletion that requires inference, and a long dictation. It checks exact outcomes, zero writes before Apply, and Undo restoration in isolated databases. Both context sizes use the same fixtures and report the installed model digest, active context, GPU residency, tool calls and warm latency. The older `test:model` commands remain the historical 9B comparison. Native tests use isolated data and deterministic Ollama or speech boundaries where stated.

To rebuild speech, create `.speech-env`, install `speech/requirements.lock.txt`, then `npm run build:speech`. Packaging commands are `npm run package` or `npm run package:msi`. No installer/deployment is implied by passing development checks. Historical [V1](docs/legacy/V1_README.md) and [V2](docs/V2_PLAN.md) documents retain earlier product history.
