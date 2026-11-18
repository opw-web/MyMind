# Bloom Planner 🌷 — Single Calendar Edition

A cozy **frontend-only React/TypeScript UI prototype** inspired by PixelPetals/Bloom. Exactly two tabs (**Calendar** and **Tasks**) and one shared simulated local-AI command composer.

**Please read [`AGENT_HANDOFF.md`](./AGENT_HANDOFF.md) before adding local AI.** It contains the complete feature inventory, every button/field/gesture, entity model, integration action proposal, invariants, and limitations.

## One unified calendar

There is **one calendar** for all events and activities. The former **Scheduled | Actual** calendar switch and event **Entry type** control have been removed. Past-activity commands create ordinary calendar blocks visible alongside other entries. **Categories** are colored tags within that single calendar; the Tasks screen's “Scheduled / Unscheduled” filter only indicates whether a task has at least one linked block.

## Launch immediately, offline

- Open `Bloom-Planner-Demo.html` in a desktop browser. This is a single, self-contained HTML demo with bundled JavaScript and styles.
- Alternatively open `dist/index.html`; its CSS and React assets are stored beside it.
- Data resides in React memory; refreshing restores sample data. No internet connection, backend, database, login, analytics, telemetry, real AI, or microphone access.

## Modern React + TypeScript edition

```bash
npm install
npm run dev
```

Modern files: `src/App.tsx`, `src/main.tsx`, `src/modern.css`, `src/style.css`. The project uses React 18, Vite, Tailwind v4 and hand-built pixel SVG elements. Build modern output with `npm run build`.

## Offline build

```bash
npm run build:offline
```

`src/app.tsx` compiles to `dist/app.js`, copies `src/style.css` to `dist/style.css`, and regenerates `Bloom-Planner-Demo.html` with bundled local React vendor scripts. Keep `src/App.tsx` and `src/app.tsx` in sync for every functional change.

## What works

- **Calendar:** starts with today's date leftmost; continuous day-column horizontal scroll; 24-hour vertical scroll; sticky aligned headers/time gutter; all-day lane; precise timed blocks; click/drag create; edit/delete; color-category visibility and management; task linking; one unified event collection.
- **Tasks:** optional projects, tasks and checklist steps; standalone tasks; independent completion; create/rename/edit/delete; due dates, priority, duration estimate, notes, category; task project reassignment; active/completed and scheduled/unscheduled filters; multiple scheduled blocks linked to the same task.
- **Command composer:** typed examples; simulated microphone with interim and editable final transcript; explicit Send → preview → Approve/Cancel; approved demo actions update the same mock state.

## Boundaries

This is a functional **UI prototype**, not a persisted productivity service. “Recording” and “Local AI” are intentionally labeled **simulated**. No actual Whisper/Ollama connection, network API, or real microphone capture is included. See [`AGENT_HANDOFF.md`](./AGENT_HANDOFF.md) for control-by-control specifics and a proposed future local-action API.
