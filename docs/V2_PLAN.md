# MYMIND V2 — conversational, spacious, intelligently organized

## Direction and confirmed problems

Build V2 around useful, dependable assistance and an interface that feels responsive. Preserve Electron, React, SQLite, transactional changes, Undo, and complete worker shutdown. Replace the interaction architecture and workspace layout.

The V1 audit identified action-biased prompting, conversational answers discarded after a commit, date words accidentally treated as title keywords, only two previous exchanges supplied to the model, Whisper base with automatic language detection and a short silence cutoff, a fixed narrow task sidebar and shallow chat drawer, and default colors without categories.

Confirmed choices: entirely local AI; quality first; English input and optional spoken replies; horizontal month timelines; automatic category assignment/creation; fresh chat every launch. The user rejected all persistent conversation memory, summaries, embeddings, profiles, or learned preferences.

## Workspace and perceived responsiveness

- Calendar, Tasks, and Chat each occupy the main workspace. Open into Calendar and provide assistant access everywhere.
- Optional resizable side chat defaults to 420 px and docks only if at least 720 px remains for the planner. Otherwise use full Chat.
- Compact navigation rail, restrained charcoal surfaces, readable 15–16 px primary text, clear contrast, category colors, and smaller functional headings.
- Horizontal month rows have readable event cards and a separate overview using markers/counts. Do not shrink event text into miniature cards.
- Clicking a date opens its complete agenda. Preserve Today navigation, past days, multi-day events, and synchronized dated tasks.
- Tasks has project/section grouping, Today/Overdue/category filters, inline editing, and completion controls.
- Chat has a growing composer, microphone, separate saved-action cards with Open/Undo, and no ordinary raw UUID output.
- Immediate input acknowledgement; real execution stages; streamed replies; manual planning available during inference; Stop during generation and playback. Never mark an action saved before commit.
- Preserve the reader's scroll position and show a new-response indicator while reading older messages.

## Conversation, tools, context, and voice

- Distinguish conversation, questions, change requests, and mixed requests before exposing mutations. Explanations, hypotheticals, and negations must never create entries.
- Supply accurate application capabilities. Allow general reasoning and conversation; external actions remain planner-only.
- Understand → retrieve → stage → commit → conversational response. Saved receipts and conversational text are separate.
- Resolve references from visible selection, current conversation, and verified results; recheck actual records. Dates and title words are separate filters, with pagination and typed records.
- Repeated deletion reports already removed. Restoration preserves the original ID and fields.
- Preserve atomic batches, revision checks, cancellation, request deduplication, and truthful cancellation after commit.
- Conversation/tool context lives only in RAM. New chat and closing clear messages and referents; closing stops workers. Planner records, categories, settings, and Undo remain saved application data.
- Budget context by tokens, reserve reply/tool space, discard whole old exchanges, and make the context boundary discoverable. No conversation/audio in production logs.
- Qwen 3.5 9B, 8,192-token context, GPU/CPU offload without silent reduction to 2,048 tokens; validate on the target laptop.
- Final transcription: Whisper large-v3-turbo, English, CPU int8. Vocabulary hints, recording until manual Stop, then final transcription and review before Send; there are no provisional transcription requests or recording duration cutoffs.
- Visible/correctable complete final transcript. All dictation and explicitly started voice sessions require Stop and review before Send; messages are limited by available model context rather than 4,000 characters.
- Optional local Kokoro-82M ONNX spoken replies on CPU. Pin and verify model/runtime versions and retain licenses before packaging.
- Immediate Stop controls and suppression of microphone capture during synthesis/playback. No wake word or background listening.

## Intelligent categories and interfaces

- Keep item type, category, and project organization distinct. A dated task is one task visible on the calendar.
- Submitting an assignment by Friday is a task/deadline; an exam on Friday is an event; explaining assignments is conversation.
- Reuse fitting categories before creating reusable new ones such as Assignments, Exams, Submissions, and Errands. Avoid per-item category names.
- Stable colors and visible labels; color must not be the sole indicator. Quiet month styling lets category colors communicate meaning.
- Immediate category correction; preserve explicit choices. Rename/merge existing categories only on request.
- Category creation and item assignment share one undoable transaction.
- Migration preserves existing data/colors and offers a reviewable Organize existing items batch with Undo.
- Extend shared types with categories, references, color overrides, selected-item context, request-scoped progress/text/receipt/completion/error events, chat reset, and speech controls.
- Keep a capability registry separate from orchestration for future integrations. Validate and mutate in the main process; upgrade SQLite transactionally with a recoverable backup.

## Acceptance and delivery

Implementation sequence: regressions/reference archive → execution/categories → adaptive workspace/streaming → voice → packaged verification.

- Replay today's event → delete once → repeated deletion → exact restoration → explanation without creation → combined delete/explanation.
- Cover negations, hypotheticals, duplicate titles, ambiguity, corrections, date rollover, multi-day events, and type classification.
- Zero unintended mutations in conversational/negated cases; at least 95% correct outcomes in a broader repeated real-model suite.
- Category creation/reuse/correction/colors/migration/Undo.
- New chat, context exhaustion, closing/reopening, cancellation before/after commit, and no conversation/audio persistence.
- Natural English audio with accents/pauses/noise plus planner vocabulary: to-do list, cornhole, assignments, exams, submissions. Synthetic speech alone is insufficient.
- Measure acknowledgement, transcription, first response, completion, interruption. Target visible acknowledgement within 100 ms and Stop feedback within 150 ms; report actual model latency.
- Layout at 1280×800, Windows scaling through 175%, keyboard use, long titles.
- Installed MSI, data preservation, offline speech, and cleanup of owned workers.
- Retain [the original screenshot and provenance](legacy/README.md), linked from README and the original brief. The screenshot is a historical workflow reference, not a visual specification.

## Implementation notes

Qwen's initial live replay demonstrated that prompting alone could still produce an unsaved deletion claim. V2 therefore validates and executes unambiguous selected/referenced deletions, exact restoration, and named task completion/reopening directly through the shared planner service. The model then supplies the conversational response; general and multi-part requests continue through the tool registry.

Ollama chooses GPU allocation with 1.5 GiB of reserved headroom and retains the full 8,192-token context. The 2D interface uses software rendering so GPU inference cannot monopolize its compositor. Actual model performance depends on concurrent workloads and is recorded during validation.

Natural-speech fixtures are development-only, downloaded public corpus samples under ignored test-results. They are not ambient recordings or runtime memory. Verification coverage and any remaining limitations belong in VALIDATION.md.

The deployed speech model is the pinned on-disk int8 large-v3-turbo distribution (`vokasug/faster-whisper-large-v3-turbo-int8`, revision `955eeeca9313352edb2ee4857ac836e599722da0`). It keeps the same model family and CPU int8 inference while reducing installer size. The bundled runtime is self-contained and performs no first-use download.

Executable resource edits were blocked by Device Guard on this PC. The final package retains the unmodified Electron binary and standard unpacked application files; no Windows policy or trust settings are changed. Actual installation, launch, file fingerprints, and existing-planner fingerprints are verified before delivery.

## Version 2.0.1 — manual dictation and startup

The October 11 correction replaces preview/endpoint-controlled dictation with in-memory WebM/Opus capture and transcription only after Stop. Voice sessions require manual Stop and Send on every turn. Cancel preserves typed text, aborts only the active request, and keeps loaded speech models available until app exit. New chat and backgrounding discard recordings; failures retain audio for Retry. Longer transcripts remain complete and editable, with read-only context preflight before submission.

Ollama starts alongside the window, uses automatic GPU allocation with reserved headroom, and records startup phase timings. Speech ships the unmodified signed Python runtime rather than a modified executable bootloader. Audio decoding uses the bundled PyAV 19 API directly, including resampler flushing and cancellation checks between frames.
