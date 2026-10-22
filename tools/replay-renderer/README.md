# Replay renderer

`vosux replay-renderer render /absolute/play.osr --set mania.scroll_speed=27 --set background_dim=0.9 --out /absolute/play.mp4`

The studio exposes the same settings under each replay's **Render settings** disclosure. Apply changes to that replay, or save them in the named player's preset. Skin selection remains independent per replay. None of these settings modifies osu! or changes the recorded key/cursor input or judgement windows.

## Per-replay settings schema

`render-settings.json` is the authoritative machine-readable schema, consumed by both the Rust service/CLI validator and the studio control generator. Every entry declares key, label, applicable numeric rulesets (0 osu!, 1 taiko, 2 catch, 3 mania), inclusive bounds, UI step and default. Presets retain values by key. Toggles use numeric **0/1** so CLI arguments and existing preset files share one representation.

- `mania.scroll_speed`: mania display scroll setting; e.g. change 33 to 27 without changing input timings.
- `note_speed`: independent mania/taiko movement multiplier.
- `background_dim`: 0 shows the map background, 1 blacks it out. Skin stage elements retain their own opacity.
- `cursor.size`, `cursor.trail_ms`: osu!/catch cursor scale and deterministic look-back trail length. Trails are resampled from recorded replay coordinates, never accumulated from preview history.
- `hit_lighting`: mania skin stage and normal/hold hit lighting.
- `key_overlay`: input-state indicators for mania columns or the four taiko buttons.
- `playfield.scale`, `playfield.x`, `playfield.y`: per-replay playfield scale and viewport-relative centre offsets, clipped to the assigned layout cell. The background and HUD do not move with the playfield.
- `hud.player`, `hud.combo`, `hud.accuracy`, `hud.health`, `hud.judgements`: independent display toggles. Combo, accuracy and judgement counters are displayed only after the replay's stored judgement counts verify; health interpolates the replay's recorded life graph.

Player presets use exact player names, including Unicode, and apply automatically on import. A per-render setting overrides the preset; the preset overrides tool defaults. Different-difficulty grouping requires the same positive BeatmapSetID, and all tracks must use the same rate. Audio comes from the first track.

## Export runtimes

The Rust service drives Chrome Headless Shell and streams fixed-clock RGBA frames to external FFmpeg. On first native render, it downloads the release-pinned **156.0.8078.47** Linux/Windows x86_64 archive from Google's Chrome for Testing storage, checks an embedded SHA-256 before extraction/execution, rejects escaping paths/symlinks and oversized archives, and caches the runtime with its complete upstream `LICENSE.headless_shell`. `VOSU_RENDER_CHROMIUM` explicitly overrides this managed runtime for offline/custom installations; `VOSU_RENDER_FFMPEG` selects FFmpeg. No user-installed Chromium or Node is required. Initial rendering requires network access unless the runtime is cached or overridden; system libraries/sandbox support still follow the OS browser requirements. Native output is MP4 with VP9/AAC, not GPL libx264. FFmpeg remains external; use an LGPL-only distribution if redistributing it.

Browser export uses WebCodecs VP9/Opus and writes WebM, with OfflineAudioContext rate/gain mixing. Both paths use the same absolute map-time compositor and GPUTexture readback; preview frames are staged before publication so asynchronous readback cannot blank the currently displayed frame.
