---
name: MYMIND Bloom
description: A playful personal planner with pastel calendar sessions and a deliberate local assistant.
---

# Bloom visual system

The current Bloom template and rendered application are the visual authority. Preserve the pixel flowers, cat, Silkscreen identity, rounded Nunito text, pastel blocks and existing geometry. Earlier MYMIND Command/Figma aerospace references are historical, not the current design target.

## Operating surface

This is a Windows Electron planner used to work in Calendar, Tasks and Flowchart. Keep primary actions and the persistent bottom composer reachable at the supported 900×600 outer window. Calendar is a horizontally scrolling day-and-time grid, with an all-day lane and time axis. The conversation opens as a sheet above the same composer. It does not reserve a permanent right column. Native modal dialogs protect focused editing; quick notes remain anchored to their owning record.

## Type and geometry

Self-hosted Bloom Rounded (Nunito, variable 200–1000) carries body text and controls. Bloom Pixel (Silkscreen, 400/700) carries identity, selected headings and date labels. Retain the current 14px base, compact 10–13px helpers, 23px calendar heading, 70px sidebar, 80px top bar, rounded controls and the pinned pixel art. Keep time and count numerals readable. Existing Bloom hard offset shadows are part of the approved world.

## Light, Dark and System

Light is the default, including existing preferences without an appearance value. Settings persists Light, Dark or System. System observes the operating-system color preference live. Native theme, window startup background, renderer, native form controls, dialogs and body portals share that choice. The initial window remains hidden until ready; the resolved initial theme is passed to renderer bootstrap.

Light retains the template palette: cream canvas #fff8f0, paper #fffdf9, brown ink #59443e, muted brown #8e7770, terracotta #c27a6b and pale boundaries #ecdfd3. Existing per-rule fallbacks preserve the finer reference shades. Functional compact labels use an 11px floor.

Dark uses warm charcoal canvas #292524, raised paper #302b29, tinted surfaces #403632, primary text #f1e1d5, muted text #cdb8aa, boundaries #63534b and clay actions #d49b8c with dark action text #30221e. Semantic roles are --cream, --surface, --brown, --brown-light, --surface-soft, --surface-tint, --text-primary, --text-muted, --accent, --on-accent, --boundary and --line. Category --fill/--ink remain separate pastel pairs; do not accidentally inherit category ink as dark page text. Text selection, focus, caret, scrollbar and color-scheme belong to the theme too.

## Calendar and proposal states

Pastel categories retain six pairs: coral #F4D7C9/#935E4B, amber #F8E4B7/#86632E, sage #DFEAD8/#58764D, sky #CFEBE7/#3F746B, lavender #DDD8F5/#675A97 and rose #F7DBDD/#8F585C. Actual sessions use a quieter neutral fill and explicit Actual label. Planned and actual entries remain separate in overlap lanes. Deadlines are derived all-day task markers, never duplicate session records. Sessions keep independent times, notes and quick notes.

A pending proposal uses semantic --preview-surface/border/ink/selected/warning tokens. Dashed outlines and changed-field text identify proposed records; original locations are muted and struck out. Deletions remain visibly proposed until Apply. Hover/focus reveals the exact record without stealing composer focus; leaving or Dismiss restores the prior surface, filters, scroll and flow zoom. Apply and Dismiss stay visible at compact size. Required questions and stale conflicts block the complete batch.

## Interaction quality

Preserve visible keyboard focus and native controls. Respect reduced motion across the entire interface, including the assistant orb, toast and completion animation. Test real content, long titles, overlap lanes, midnight boundaries, keyboard editing, compact dialogs, notes portals, Flowchart scrolling and both themes. Screenshot inspection complements actual interaction/state assertions. Do not introduce a generic redesign, new display fonts, stock illustrations or an unrelated component system.
