# Changelog

## Unreleased

- Skin studio's Keymodes picker reuses one image inventory index across its units, keeping large-skin geometry refreshes linear instead of rebuilding the complete index once per image, and retains unchanged thumbnail nodes across refreshes. Composition normalizes retained-image filenames and compiles each reference matcher once; repeated Mania scalar lookups share one private text parse. Programmatic publication no longer schedules a duplicate delayed skin decode and texture upload.
- Returning Keymodes geometry preferences to their defaults removes empty inherited count drafts and their dirty state, while explicitly added key counts remain present. Undo/Redo preserves the exact prior recipe.
- Restore last apply stays available for the base skin regardless of the selected destination. If changing the base forces Apply to an export destination, that destination change shares the base's Undo/Redo step.
- Skin studio's **Discard hand edits** confirms the affected skin.ini line count and is one draft Undo/Redo step. Read-only selected-skin text explains how to edit the draft and offers a switch there; missing-image Problems name the referenced file.
- Calibration proposals keep their own HitPosition baseline and become **Applied** without another action until calibrated again, including hold tails. Width changes report HitPosition side effects and keep the proportions toggle with Column values.
- Missing-source recovery has one visible, named banner above the main content on every tab; replacement choices keep technical IDs in hovers, remapping confirms its slot count and repairs unavailable image pickers.
- New generated and dropped-image references retain provenance; old references are conservatively labelled **Added images**. The draft names generated copies correctly, explains notes blocked by the base's keys, marks Name as export-only, and clears stale apply/status messages on subsequent changes.
- Skin studio captures one draft recipe/text generation across composition, plan and Apply. Stale loading work is rejected; Apply completion retains newer edits and their undo/redo history. Save and focus responses cannot cross source/request identities, including A → B → A.
- Group and single-asset picks now update their owned ini keys even after hand editing the draft, preserving unrelated values/comments. Tab-aligned Alt-box selection uses visual columns rather than model character offsets.
- Folder discovery, snapshot reads, Save and Apply share case-insensitive `skin.ini` resolution and retain its existing spelling; ambiguous variants and symlinks are refused.
- Source `.osk` export includes unsaved selected-skin ini text without saving it. Source export and the mix draft's **Draft destination** are labelled separately.
- skin.ini completion/validation and render-core share legacy PNG lookup policy: case/slash/HD normalisation, texture versus animation fields and font digit sets. JPEG-only files no longer masquerade as valid legacy PNG references.
- skin.ini's permanent Corrections sidebar becomes a compact, filterable **Problems** drawer. Warning-only skins start collapsed with counts visible; new errors open it automatically.
- skin.ini checks wait for 200 ms of typing idle, coalescing keystroke bursts and rejecting stale diagnostic results instead of blocking each character on full-file validation.
- Grouped Explorer asset details deduplicate in-flight member-thumbnail callbacks, avoiding exponentially repeated redraws when inspecting a full font or animation.
- Empty hand-edited ini text remains empty through draft persistence, export and preview/keymode consumers. Hand-edited-only drafts use a truthful compact label; the Problems search field no longer collapses beside its severity selector.
- Dropped-file picker and management counts share the same winning source snapshot; overlapping refreshes cannot leave a newly uploaded file missing from the management list.
- Skin studio refreshes stale preview bytes and discovers replaced lazer skin IDs without reloading, showing source recovery on every tab. Explorer distinguishes Base/Group/Override provenance, counts complete assets and nested folders, and keeps Enter/double-click inspection non-destructive. Clarify Built-in versus resetting to the base, source identity and browsing identity; preview the draft by default.
- Skin studio preserves the actual focused Keymodes number/text input across background redraws, including its native selection and unfinished text. Replacing a width such as 60 with 75 can no longer concatenate into 6075 or commit a partial value while another edit finishes.

- Skin studio reports excluded LN releases separately as early and late, and explains that re-grabbing a hold can produce multiple release samples. Preserve accepted NoRelease tails when the physical key-up comes after the automatic judgement; ordinary lazer's 1.5× and stable ScoreV1's combined head/release rules remain unchanged.
- Skin studio calibration now corrects timing instead of matching it: late presses raise receptors, early presses lower them; late releases shorten LNs, early releases lengthen them. Magnitudes and per-key-count scope are unchanged. Re-calibrating a skin calibrated with 0.4.x moves it the other way. Proposals state the correcting direction and explain it on hover.
- Skin studio repairs stale Keymodes geometry captures on the next width edit, including repeating the current width. Replacing an image establishes one new stage baseline so old receptor selections and HitPosition epochs cannot reappear in only some columns.
- Skin studio replaces HitPosition's −5/+5 buttons with a plain number field (Enter/blur commits; native arrows step by one) and adds an undoable, per-key-count **Move receptors with HitPosition** toggle, on by default. Off moves only the note landing line, including calibration, without rewriting receptor images or LightPosition; proportional width changes still resize images but skip HitPosition-driven receptor shifts.
- Skin studio offers a conditional, undoable **Reset geometry from original stage** when old captures have already restored obsolete blank receptors. Stage copies, group replacements and bulk image selections invalidate the shared capture baseline. Partial width edits pin the implicit note-height reference only when needed so untouched columns' note images stay untouched; user-set `WidthForNoteHeightScale` values are never rewritten.
- Skin studio keeps asynchronous geometry, copies, source recovery and LN calibration scoped to their original key count, and rejects stale results after newer edits or undo/redo instead of restoring old selections.
- Skin studio has one mix draft instead of the Current skin / New skin switch. Its base follows osu!'s current skin until the draft has changes or another base is chosen; **Apply to current skin** (or to the chosen base) is an **Export as** entry for stable and added skins, and for lazer skins only while lazer's Edit externally has them mounted (otherwise lazer gets a new skin, as before). **Clear** becomes **Discard draft** beside Undo/Redo, with a confirmation naming what is lost, and is undoable. Existing drafts migrate: the new-skin draft stays the draft; an edit-in-place draft with changes is kept as a **Saved draft** to open or discard.
- Skin studio's Undo/Redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y on any tab) now cover every draft change: group picks, single assets, carried settings, the base and Discard draft as well as Keymodes edits. New shortcuts: Ctrl+F for the tab's filter (the editor's find on skin.ini), Ctrl+Enter to export, `[`/`]` for key counts, Delete/Backspace and Escape anywhere on Keymodes, and `?` or Ctrl+/ (or **Shortcuts**) for a sheet listing every binding. Text fields and the skin.ini editor keep their own keys.
- Skin studio's Keymodes groups (Hit position, LN length, Stage images, All [Mania] settings) start collapsed; Mirror, the 1/2/S pattern and Copy from move under **Column tools**; value rows read Line width and Light colour; the image picker is about 30% wider and the stage about 12% taller.

## 0.4.2 - 2026-10-28

- Skin studio 0.4.2 detects draft source skins that disappeared from the library and offers explicit remap, keep or remove recovery, with undo. References retain source names and fingerprints; existing drafts without stored names continue to work.
- Keep missing-source recovery in one compact row with help hovers, and label legacy missing references as Unknown source rather than inventing a name.
- Lazer library 0.2.1 adds full-content skin fingerprints, including image files, so source recovery can distinguish identical skins from skins sharing only an ini/json hash. Other tool versions are unchanged.

## 0.4.1 - 2026-10-28

- Skin studio keeps different derived Keymodes images distinct even when their display names match, preventing one column's resize from replacing another's image. Image density follows each destination's `@2x` suffix, not the retained source filename; repeating an unchanged column width does nothing.
- Skin studio identifies unavailable image sources without exposing their parent paths in the UI, labels failed width/hit-position actions, and logs the requested source key, route and availability with bounded, deduplicated diagnostics.

## 0.4.0 - 2026-10-27

- Rename Mania ratings to Map analysis (`map-analysis`), with catalog-only `replaces` metadata preserving migration support and legacy manifest compatibility.
- On vosu 1.2.2+, Mania ratings updates to Map analysis automatically, keeping data and settings. On older vosu, install Map analysis manually; old Mania ratings keeps working.
- Analyse standard, taiko, catch and mania at the selected mods and rate, using the existing rosu-pp 4.0.1 engine (lazer 2025-10-13 algorithms; newer lazer can differ).
- Add in-process accuracy-target pp from the same rosu-pp attributes and explicitly labelled, documented per-mode section metrics (ours), using the shared ruleset converter for played maps.
- Remove the rate-curve UI, CLI option, settings and `/v1/beatmap/<md5>/rates` route. Current-rate ratings and mania timelines remain.
- Skin studio separates hit-position (press/receptor) and LN-length (release/hold-tail) calibration into independent, visible groups. Each names the play, client and key count, shows relative and absolute local play time, flags old plays, and explains blocked proposals.
- Replay renderer: correct mania Classic + ScoreV2 judging to use modern hit windows, matching lazer's `ManiaHitWindows`; Classic's legacy windows apply only without ScoreV2.
- Skin studio LN-length means now use only non-miss/non-combo-break physical releases under the replay client's timing rules. Show used/total/excluded counts, block calibration when fewer than 50 remain, and explicitly report very late held releases which stable ScoreV1 still accepts.
- Ship Map analysis 0.3.0 (replacing Mania ratings 0.2.0), Skin studio 0.4.0, Replay renderer 0.3.0 (new bundled multi-ruleset analysis plus replay-window fixes), Practice 0.1.3 and Downloader 0.1.1 (Map analysis dependency/discovery ID migration).
- Lazer library 0.2.0, Map preview 0.2.2 and Server pp calculator 0.1.0 are unchanged: no changed runtime code is bundled.
- Fix release packaging to retain the full Cargo dependency metadata while reading catalog-only replacement IDs; every archive retains the strict legacy manifest and ZIP compatibility checks.

## v0.3.0 - 2026-10-26

### Consistent mania key counts

- Practice, Map preview, Skin studio, Replay renderer and Map analysis now use the key count osu! actually plays. Native mania maps share one rule in Rust and TypeScript: clamp CircleSize to 1–18 and round ties to even (6.5 is 6K, 7.5 is 8K); play 11/13/15/17 as two stages of 10/12/14/16; use 5K when CircleSize is absent. Converted osu! maps keep lazer's conversion key count.

### Skin studio 0.3.0

- Edit the current stable skin in place, with backups and restore. If an apply cannot roll back, keep the backup instead of discarding it.
- Calibrate the mania hit position from your last play, or adjust it with the hit-position stepper.
- Keep image proportions when resizing, organize mania assets by key count, and edit the [Mania] settings in a form.
- Select several Keymodes slots at once. Read repeated Keys blocks as lazer does, keep label-only settings, and show sizes without waiting for a hover.
- Export mixes as Quaver skins or Etterna noteskins.
- Scroll mania previews at your client's scroll speed and direction, following changes live. Override the speed in Preview; without a reported speed, use lazer's default of 8.
- Keep hold bodies unchanged when adjusting HitPosition. Width changes scale receptors without replaying the derived hit position as another move, preserve short and blank keys, and keep 10K resizing consistent.
- Select per-column values like image slots and apply a value to all columns. Keep typing intact when Keymodes redraws.
- Show the note nearest the receptors in the still stage, with hold pieces placed so they do not overlap.

### Map analysis 0.2.0

- Rate charts across 1K–18K, with each calculator's supported key counts and unavailable results explained instead of silently dropping them.
- Add Interlude pattern breakdowns, Prism (mania-tracker) ratings for 6K–8K, a 7K view and Regular dan estimates, and long-note statistics.
- Use MinaCalc's dedicated 5K model, name its 6K/7K skillsets as upstream does, and explain rating-cap gaps.
- Parse native mania slider and spinner objects as lazer plays them, and use lazer's key-count rounding.
- Build Map analysis and Replay renderer on Windows with Prism's required CPU timer supplied by Windows thread times. The vendored calculator and its rating arithmetic remain unchanged.

### Lazer library 0.2.0

- Offer recent local scores with replay files through a new route, with ruleset and count filters, for features such as Skin studio calibration.

### Practice 0.1.2 and Map preview 0.2.2

- Follow the client's mania scroll speed and direction, with a manual override and a hint explaining the source.
- Keep mania notes moving at the client's real-time speed when DT, HT or a custom rate is active. Use lazer's default speed of 8 when no speed is reported.

### Replay renderer 0.2.0

- Bring the new per-key-count mania ratings, pattern breakdowns and lazer-faithful parsing to the ratings data supplied to replay overlays.
- Read repeated Keys blocks in mania skins as lazer does.

### Third-party components and packaging

- Include Interlude patterns (YAVSRG Prelude, MIT), Prism / mania-tracker (MIT), and the translated osu!lazer mania converter (MIT). Their license texts and provenance notices ship with the packages that include them.
- Keep the vosu 1.2.0 ZIP compatibility checks for every package.
- Downloader and server-pp remain at 0.1.0; their behavior is unchanged.

## v0.2.0 - 2026-10-26

### Skin studio 0.2.0

- Add a Keymodes screen for editing a mix's osu!mania key counts, per-column images and skin.ini settings. Assign slots directly from the Explorer and preview each keymode.
- Keep dropped files until you explicitly remove unused uploads; no longer delete them automatically when changing a mix. Handle upload filename case collisions.
- Include a stage's default-named images when copying it into a mix.
- Use the correct per-keymode and per-column mania images in gameplay previews.
- Improve osu! slider bodies, snaking and fading in gameplay previews, including the slider ball join and rendering on SwiftShader.

### Map preview 0.2.1

- Draw osu! slider bodies with lazer-style nearest-segment shading, snaking and fading, a gapless slider ball join, and less overdraw.
- Fix slider rendering on SwiftShader and mania image selection for individual keymodes and columns.

### Practice 0.1.1

- Bring the slider body, snaking, fade, SwiftShader and mania keymode fixes to the map preview used while preparing practice maps.

### Replay renderer 0.1.1

- Bring the slider body, snaking, fade, SwiftShader and mania keymode fixes to replay rendering and previews.

### Packaging and documentation

- Check every tool and overlay ZIP against vosu 1.2.0's end-record preflight, including ZIP64. Retry deterministic compression encodings when compressed bytes resemble an invalid end record, so users do not need to update vosu first.
- Add tool README previews and usage documentation.
- Downloader, lazer-library, map-analysis and server-pp remain at 0.1.0: their code, Rust shared dependencies and dependency lockfile have no changes since v0.1.0.
