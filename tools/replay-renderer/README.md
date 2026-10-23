# Replay renderer

`vosux replay-renderer render /absolute/play.osr --set mania.scroll_speed=27 --set background_dim=0.9 --resolution 2560x1440 --out /absolute/play.mp4`

`--out`, `--fps` and `--resolution` are optional; the last two default to the tool's settings. Without `--out`, the video is named after the replay and goes into the output folder. A relative `--out` is resolved against the current directory.

The studio exposes the same settings under each replay's **Render settings** disclosure. Apply changes to that replay, or save them in the named player's preset. Skin selection remains independent per replay. None of these settings modifies osu! or changes the recorded key/cursor input or judgement windows.

## Maps and replays

A replay stores only its beatmap's MD5, so the exact difficulty must be installed locally. The service looks it up in two places, in this order:

1. **stable Songs**: the folder vosu reports for an attached stable client, or the tool's `osu_dir` / `songs_dir` settings. The folder is indexed by MD5 once and cached.
2. **lazer**: through the optional **Lazer library** tool (`lazer-library`), via `GET /tools/lazer-library/api/v1/beatmaps/by-md5/<md5>`. Files are read from lazer's hashed store, and only after checking that the `.osu` MD5 matches and that every path stays inside `<lazer>/files`. The library is an optional dependency: it is used only through its read routes, which any tool token may call, and it is not listed in `[[requires]]`, which would block the studio whenever it is missing.

If neither has the map, the service answers 404 with `{"code":"map_missing","md5","searched":[…]}`. The studio shows it above the preview: the MD5, every place searched, **Copy MD5**, and, when the Beatmap downloader is installed, **Find in downloader** (`/tools/downloader/#md5=<md5>`).

Replays come from stable's `Replays` folder and lazer's `exports` folder. The lazer folder is found from the attached lazer client, then the library's data folder, then the platform default (honouring `storage.ini`). For a given map, the list also includes lazer scores with replays from `GET …/v1/scores/by-beatmap/<md5>`. `GET /v1/replays` lists every replay, newest first. `GET /v1/replays?md5=` lists one map's replays, and the studio's **This map** tab follows the map open in osu! through `/websocket/v2/subscribe`.

The preview plays the first track's song in sync with the picture. It starts muted; the mute button in the top bar is remembered between visits (`localStorage`, a plain boolean).

## Output size, defaults and presets

The resolution picker offers common sizes in 16:9, 16:10, 21:9, 32:9, 4:3, 9:16 (vertical) and 1:1, plus a custom width × height. Sides must be even and 64–7680 px, and a frame may hold at most 7680×4320 pixels; the service enforces the same rule. Named custom sizes and the last size used are stored in the tool's data folder (`sizes.json`, routes `/v1/sizes`). The preview renders at most 1920 px on the long side, while MP4 and WebM exports use the full size.

Settings the dashboard can edit without opening the studio:

- `resolution` and `fps`: defaults for new compositions and the CLI.
- `output_dir`: where file names are written; when empty, the Videos folder (XDG `user-dirs.dirs` on Linux, `%USERPROFILE%\Videos` on Windows).
- `ffmpeg_path`: the FFmpeg executable; when empty, `VOSU_RENDER_FFMPEG`, then `ffmpeg` on PATH.
- `osu_dir`, `songs_dir` and `skin`: an offline stable installation, a Songs folder override, and its fallback skin.

## Skins

Each track picks its skin independently. The track's **Skin** menu starts from the player's preset and can be changed for that replay alone; **Save preset** keeps the choice for the player. The menu lists every source:

- **Current skin**: the osu! client's active skin. For stable, the service reads the skin folder vosu reports (or the `skin` name under a configured `osu_dir`). For lazer, it reads the skin's files through vosu's public `/files/skin/<path>` route, guided by the `GET /files/skin/` descriptor (`{client, name, files, builtin}`). lazer's built-in skins (argon, argon-pro, triangles, legacy) have no files. For those, the studio and the MP4 export use render-core's own drawing of that built-in (`builtinSkin`), and the UI says so. When no current skin is reported, tracks use the classic look.

  File skins of any source fall back to render-core's classic (`legacy`) drawing for elements they do not provide (`withFallback`), as the clients do.
- **lazer**: skins in lazer's library, listed and read through the optional **Lazer library** tool (`GET /tools/lazer-library/api/v1/skins`, then `…/skins/<id>/file/<name>`), read-only. Presets and `--skin` refer to them as `lazer/<id>`. Ids and file names that could leave the library are rejected. Without the library tool the group is empty.
- **osu! Skins folder**: any folder under the stable installation's `Skins` directory.
- **Built-in**: render-core's drawings of lazer's Argon, Argon Pro, Triangles and Classic looks, as `builtin/argon`, `builtin/argon-pro`, `builtin/triangles` and `builtin/legacy`.
- **Imported .osk**: archives imported with the studio's **Import .osk** button (Output › Skins) or with `vosux replay-renderer skins import <file.osk> [--name NAME]`. They are unpacked into the tool's data directory (`skins/<name>`), never into osu! folders; re-importing a name replaces that copy only after the new one is complete. Presets and `--skin` refer to them as `imported/<name>`; `skins list` and `skins delete` manage them.

vosu forwards at most 1 MiB per request body, so imports are sent as ordered parts: `POST /v1/skins/uploads?name=&size=` (archives up to 512 MiB) returns `{upload, part_size}`, each `POST /v1/skins/uploads/<id>?offset=<n>` appends one part, and `POST /v1/skins/uploads/<id>/finish` validates and unpacks (no unsafe paths or symlinks, at most 20 000 entries and 1 GiB expanded). At most four imports run at once; parts idle for 30 minutes are discarded when the next import starts, and every unfinished upload is cleared when the service restarts.

## Per-replay settings schema

`render-settings.json` is the authoritative machine-readable schema, consumed by both the Rust service/CLI validator and the studio control generator. Every entry declares key, label, applicable numeric rulesets (0 osu!, 1 taiko, 2 catch, 3 mania), inclusive bounds, UI step and default. Presets retain values by key. Toggles use numeric **0/1** so CLI arguments and existing preset files share one representation.

- `mania.scroll_speed`: mania display scroll setting; e.g. change 33 to 27 without changing input timings.
- `note_speed`: independent mania/taiko movement multiplier.
- `background_dim`: 0 shows the map background, 1 blacks it out. Skin stage elements retain their own opacity.
- `cursor.size`, `cursor.trail_ms`: osu!/catch cursor scale and deterministic look-back trail length. Trails are resampled from recorded replay coordinates, never accumulated from preview history.
- `hit_lighting`: mania skin stage and normal/hold hit lighting.
- `key_overlay`: input-state indicators for mania columns or the four taiko buttons.
- `playfield.scale`, `playfield.x`, `playfield.y`: per-replay playfield scale and centre offsets in cell widths/heights. At scale 1 the playfield's visible extent (a mania stage, the taiko strip, the osu!/catch field), measured from what the renderer draws, fills its layout cell's height, or its width when the cell is narrower than the playfield. The background stays in the cell; playfields may be moved over neighbouring cells. These three are set with the layout editor rather than in **Render settings**.
- `hud.player`, `hud.combo`, `hud.accuracy`, `hud.health`, `hud.judgements`: independent display toggles. Combo, accuracy and judgement counters are displayed only after the replay's stored judgement counts verify; health interpolates the replay's recorded life graph.

Player presets use exact player names, including Unicode, and apply automatically on import. A per-render setting overrides the preset; the preset overrides tool defaults. Different-difficulty grouping requires the same positive BeatmapSetID, and all tracks must use the same rate. Audio comes from the first track.

### Layout editor

Click a playfield or overlay box on the preview to select it. Drag to move; drag a corner to resize (playfields always keep their aspect ratio, overlays with Shift). Edges and centres snap to the canvas and the layout cells; hold Alt to move or resize freely. Arrow keys nudge by one output pixel, Shift+arrow by ten. **Layout** in the Output panel shows the selection's X, Y, W, H, scale and opacity in output pixels and keeps them in sync; **Reset** returns it to the layout default. Positions are stored per replay (playfields) and per overlay layer and are used unchanged by both exports.

## Export runtimes

The Rust service drives Chrome Headless Shell and streams fixed-clock RGBA frames to external FFmpeg. On first native render, it downloads the release-pinned **156.0.8078.47** Linux/Windows x86_64 archive from Google's Chrome for Testing storage, checks an embedded SHA-256 before extraction/execution, rejects escaping paths/symlinks and oversized archives, and caches the runtime with its complete upstream `LICENSE.headless_shell`. `VOSU_RENDER_CHROMIUM` explicitly overrides this managed runtime for offline/custom installations; `VOSU_RENDER_FFMPEG` selects FFmpeg. No user-installed Chromium or Node is required. Initial rendering requires network access unless the runtime is cached or overridden; system libraries/sandbox support still follow the OS browser requirements. Native output is MP4 with VP9/AAC, not GPL libx264. FFmpeg remains external; use an LGPL-only distribution if redistributing it.

Browser export uses WebCodecs VP9/Opus and writes WebM, with OfflineAudioContext rate/gain mixing. Both paths use the same absolute map-time compositor and GPUTexture readback; preview frames are staged before publication so asynchronous readback cannot blank the currently displayed frame.

## Overlay pages (native MP4)

**Overlays** in the Output panel lists the overlays installed in vosu, by dashboard nickname or name, from `GET /tools/_host/v1/overlays`. A layer's page size starts from the overlay's `metadata.txt` resolution; once resized, the size is remembered per overlay in the tool's data folder (`sizes.json`). **Custom folder** takes an absolute folder path for overlays that are not installed, and is the only option on vosu builds without that route. Each layer has an independent page size, output X/Y, scale and opacity. These controls feed the native render queue; the studio draws only the layer's box and does not iframe or execute the overlay. Browser-only WebM export explicitly rejects overlay layers instead of silently omitting them.

The CLI accepts repeated `--overlay /absolute/overlay-folder` arguments. Each folder must contain `index.html`; CLI layers default to the full output viewport at (0, 0). The service render request accepts `overlays: [{folder,width,height,x,y,scale,opacity,settings}]` for custom layouts and per-layer setting overrides. Defaults are read from the overlay's own `settings.json`.

Each native render owns a throwaway loopback origin. Installed pages connect there using their existing `/websocket/v2`, selected-field subscriptions, `/json/v2` and settings-command clients. The renderer publishes the first replay's map time, keys, recorded life graph and verified scoring state, waits for page acknowledgements, advances Chrome virtual time, captures transparent page images and composites them into the same output frame. Fetches/resources outside that private origin and nonlocal WebSocket connections are blocked; pages never receive vosu host credentials or connect to the live game.

The private origin also serves the replay's map/audio/background assets and local ratings endpoints for `ratings-timeline`. Current pp is calculated with rosu-pp from verified replay judgements, with independently verified combo required where pp depends on combo. Unverified scores/pp remain null. This is a supported synthetic subset of vosu v2, not a memory/API emulator: unsupported fields are absent or null; hit-error arrays describe simulated judgement offsets, not a replacement for stable's precise hold-head/body/tail telemetry. Runtime timers and rendering follow replay time; there is no wall-clock video capture.

## Local verification inputs

`test-fixtures/` is an ignored, non-packaged directory for local copies of user-owned replays/maps/skins. Keep real inputs there rather than relying only on `/tmp`; never commit or distribute them. Run replay tests with `REPLAY_FIXTURES=<absolute>/test-fixtures/real` and `REPLAY_CORPUS=<absolute>/test-fixtures/corpus` when those local fixture sets are available. Synthetic telemetry tests are under `web/test/`.

For a development checkout, run `cargo build --locked -p vosu-replay-renderer`, then copy `target/debug/vosu-replay-renderer` (`.exe` on Windows) into `tools/replay-renderer/bin/` before starting `vosu --tool tools/replay-renderer`. Development executables are ignored; the release packager supplies the compiled binary automatically.
