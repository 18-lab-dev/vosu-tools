# Changelog

## v0.3.0 - 2026-10-26

### Consistent mania key counts

- Practice, Map preview, Skin studio, Replay renderer and Mania ratings now use the key count osu! actually plays. Native mania maps share one rule in Rust and TypeScript: clamp CircleSize to 1–18 and round ties to even (6.5 is 6K, 7.5 is 8K); play 11/13/15/17 as two stages of 10/12/14/16; use 5K when CircleSize is absent. Converted osu! maps keep lazer's conversion key count.

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

### Mania ratings 0.2.0

- Rate charts across 1K–18K, with each calculator's supported key counts and unavailable results explained instead of silently dropping them.
- Add Interlude pattern breakdowns, Prism (mania-tracker) ratings for 6K–8K, a 7K view and Regular dan estimates, and long-note statistics.
- Use MinaCalc's dedicated 5K model, name its 6K/7K skillsets as upstream does, and explain rating-cap gaps.
- Parse native mania slider and spinner objects as lazer plays them, and use lazer's key-count rounding.
- Build Mania ratings and Replay renderer on Windows with Prism's required CPU timer supplied by Windows thread times. The vendored calculator and its rating arithmetic remain unchanged.

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
- Downloader, lazer-library, mania-ratings and server-pp remain at 0.1.0: their code, Rust shared dependencies and dependency lockfile have no changes since v0.1.0.
