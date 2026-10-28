# Changelog

## 0.4.3 - 2026-10-28

Skin studio updates to **0.5.0** in this release. **Calibration now corrects your timing: late presses move receptors up and late releases shorten LNs; early timing moves them the other way. This is the opposite direction to Skin studio 0.4.x.** Existing geometry is not automatically recalibrated.

The Current skin / New skin switch is removed in favour of one draft and an explicit destination. Your new-skin draft becomes the draft; an edited in-place draft with changes remains available as a Saved draft to open or discard.

Map preview 0.2.3, Practice 0.1.4 and Replay renderer 0.3.1 include the shared legacy-PNG, HD and animation lookup fixes. Replay renderer also retains accepted NoRelease hold-tail outcomes in physical-release samples. Other tool versions are unchanged.

### Skin studio 0.5.0

- The redesigned Keymodes view has a wider image picker, a taller stage, collapsed detail groups and clearer names. Mirror, the 1/2/S pattern and Copy from are together under **Column tools**. Copy from lets you choose all rows, keys, notes and holds, or values. Preview follows the relevant key count.
- Undo/Redo now covers the whole draft, including base changes, image/group picks, carried settings, recovery and Discard draft. Discard hand edits and changing a destination are reversible too. Text fields and skin.ini keep their own editing shortcuts; a Shortcuts sheet lists the bindings.
- HitPosition is a number field. **Move receptors with HitPosition**, on by default, can be turned off per key count to move only the note landing line. Geometry reset can recover the original stage; copies retain the complete stage appearance.
- Calibration handles animated and HD hold images, reports early and late excluded releases, and marks used proposals Applied. Accepted NoRelease tails remain available when the physical key-up follows the automatic judgement. Oversized conversions explain any SD fallback before applying.
- skin.ini gains find/replace, path completion and visual-column selection. A compact **Problems** drawer replaces the permanent Corrections sidebar; checks wait until typing pauses. You can review skin.ini from Apply.
- Hand edits, including deliberately empty text, survive persistence and export. Image/group picks update their own ini values without discarding unrelated hand edits or comments. Source `.osk` export includes unsaved ini edits without saving them.
- Save and Apply keep the existing skin.ini filename spelling. Late loads, saves and applies cannot overwrite newer work or restore the wrong skin/count. Undo restores the exact recipe and ini text; changing widths keeps the focused input and its unfinished text intact.
- Missing-source recovery appears on every tab, explains the affected slots and handles replaced lazer IDs without reloading. Previews refresh changed image bytes after loading, Apply and Restore. Restore last apply remains available for the base even when another destination is selected.
- Generated images retain their origin; older references are conservatively called Added images. Uploaded files needed by the draft, saved drafts or undo history are retained. Picker and management lists agree after overlapping refreshes.
- Large-skin picker refreshes avoid repeated full-image indexing and keep unchanged thumbnails in place. Only the changed source's thumbnails are refreshed; composition avoids duplicate skin/image uploads.
- Returning inherited geometry preferences to their defaults clears their dirty state without removing explicitly added or older authored key counts. Preference-only rows are labelled as preferences.

### Shared rendering and replay fixes

- Legacy skin PNG lookup now agrees between the editor and renderer, including filename case, slashes, HD images, animation fields and font digits. JPEG-only files are no longer reported as valid legacy PNG references.
- Replay renderer retains the accepted outcome for a NoRelease hold tail when recording its later physical release. Ordinary lazer and stable ScoreV1 release rules are unchanged.

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
