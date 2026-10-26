# Changelog

## Unreleased

### Practice

- Draw the mania preview with your osu! scroll speed and direction (stable or lazer, read from vosu) and follow changes live. A Scroll field in the preview overrides it; its hint says where the speed comes from, and lazer's default (8) applies without a client or a reported speed.

### Map preview

- Keep notes moving at the client's real-time speed when the client plays at another rate (DT, HT or a custom rate), and fall back to lazer's default scroll speed (8, was 20) when no speed is set or reported. The scroll speed's hint names its source.

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
