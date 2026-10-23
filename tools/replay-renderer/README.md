# Replay renderer

`vosux replay-renderer render /absolute/play.osr --set mania.scroll_speed=27 --set background_dim=0.9 --resolution 2560x1440 --out /absolute/play.mp4`

`--out`, `--fps` and `--resolution` are optional; the last two default to the tool's settings. Without `--out`, the video is named after the replay and goes into the output folder. A relative `--out` is resolved against the current directory.

The studio is simple by default: add replays, pick an output size, press **Render MP4**; layout (Auto), skin (the client's current skin), HUD and timing follow sensible defaults. Each track card shows its player, map and **Skin** (a new skin applies at once); its **More** disclosure holds the track's layer switches and render settings (**Apply** to use them, **Save preset** to keep them for the player). The Output panel's **Advanced** disclosure holds frame rate, outro and fade, and skin imports. Placement is edited on the preview (see Layout editor); the selection's fields appear only while something is selected. None of these settings modifies osu! or changes the recorded key/cursor input or judgement windows. The Timeline panel's expand button opens the same track list in a large dialog (Escape or a click on the dimmed backdrop closes it).

## Maps and replays

A replay stores only its beatmap's MD5, so the exact difficulty must be installed locally. The service looks it up in two places, in this order:

1. **stable Songs**: the folder vosu reports for an attached stable client, or the tool's `osu_dir` / `songs_dir` settings. The folder is indexed by MD5 once and cached.
2. **lazer**: through the optional **Lazer library** tool (`lazer-library`), via `GET /tools/lazer-library/api/v1/beatmaps/by-md5/<md5>`. Files are read from lazer's hashed store, and only after checking that the `.osu` MD5 matches and that every path stays inside `<lazer>/files`. The library is an optional dependency: it is used only through its read routes, which any tool token may call, and it is not listed in `[[requires]]`, which would block the studio whenever it is missing.

If neither has the map, the service answers 404 with `{"code":"map_missing","md5","searched":[…]}`. The studio shows it above the preview: the MD5, every place searched, **Copy MD5**, and, when the Beatmap downloader is installed, **Find in downloader** (`/tools/downloader/#md5=<md5>`).

Replays come from stable's `Replays` folder and lazer's `exports` folder. The lazer folder is found from the attached lazer client, then the library's data folder, then the platform default (honouring `storage.ini`). For a given map, the list also includes lazer scores with replays from `GET …/v1/scores/by-beatmap/<md5>`. `GET /v1/replays` lists every replay, newest first. `GET /v1/replays?md5=` lists one map's replays, and the studio's **This map** tab follows the map open in osu! through `/websocket/v2/subscribe`.

The preview plays the first track's song in sync with the picture. It starts muted; the mute button in the top bar is remembered between visits (`localStorage`, a plain boolean).

## Output size, defaults and presets

The resolution picker offers common sizes in 16:9, 16:10, 21:9, 32:9, 4:3, 9:16 (vertical), 4:5 and 1:1, plus a custom width × height. Sides must be even and 64–7680 px, and a frame may hold at most 7680×4320 pixels; the service enforces the same rule. Named custom sizes, the last size used and the chosen layout are stored in the tool's data folder (`sizes.json`, routes `/v1/sizes`). The preview shows the frame at its own aspect ratio, as large as the centre panel allows; it renders at most 1920 px on the long side, while MP4 and WebM exports use the full size.

Layouts follow the frame's shape. One track always fills the frame. **Side by side** is a row, or a column on a portrait frame; **Stacked** is always a column; **Grid** picks the column count whose cells have the largest short side. **Auto** (the default) picks the column count that draws the smallest playfield largest, from each track's measured playfield: taiko strips stack, mania stages and osu! fields sit side by side when that makes them bigger, and two osu! fields stack on a square frame. Cells are separated by 8 px.

A render runs from lazer's gameplay start (two seconds before the first object, or earlier when the map's `AudioLeadIn` asks for it, never after the song's start) to the last object plus the outro. Like lazer's player, the picture comes in from black (250 ms hidden, then a 250 ms fade) and fades out at the end of the outro; the song fades with it. **Outro** and **Fade** in the Output panel override the defaults for this composition.

Settings the dashboard can edit without opening the studio:

- `resolution` and `fps`: defaults for new compositions and the CLI.
- `outro_ms` and `fade_ms`: time after the last object and the fade at its end; lazer shows results 1250 ms after the last object, fading out over the last 250 ms.
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

Files in skin folders (stable, current stable skin, imported) are matched ignoring case, as the clients do: skins mix `Skin.ini`, `Mania-Key1.png`, … while the renderer asks in lower case, and on case-sensitive file systems an exact match would drop a skin's configuration and images, so the same skin would draw differently from a stable folder than from lazer.

vosu forwards at most 1 MiB per request body, so imports are sent as ordered parts: `POST /v1/skins/uploads?name=&size=` (archives up to 512 MiB) returns `{upload, part_size}`, each `POST /v1/skins/uploads/<id>?offset=<n>` appends one part, and `POST /v1/skins/uploads/<id>/finish` validates and unpacks (no unsafe paths or symlinks, at most 20 000 entries and 1 GiB expanded). At most four imports run at once; parts idle for 30 minutes are discarded when the next import starts, and every unfinished upload is cleared when the service restarts.

## Per-replay settings schema

`render-settings.json` is the authoritative machine-readable schema, consumed by both the Rust service/CLI validator and the studio control generator. Every entry declares key, label, applicable numeric rulesets (0 osu!, 1 taiko, 2 catch, 3 mania), inclusive bounds, UI step and default. Presets retain values by key. Toggles use numeric **0/1** so CLI arguments and existing preset files share one representation.

- `mania.scroll_speed`: mania display scroll setting; e.g. change 33 to 27 without changing input timings.
- `note_speed`: independent mania/taiko movement multiplier.
- `background_dim`: 0 shows the map background, 1 blacks it out. Skin stage elements retain their own opacity.
- `cursor.size`, `cursor.trail_ms`: osu!/catch cursor scale and deterministic look-back trail length. Trails are resampled from recorded replay coordinates, never accumulated from preview history.
- `hit_lighting`: mania skin stage and normal/hold hit lighting.
- `playfield.scale`, `playfield.x`, `playfield.y`: per-replay playfield scale and centre offsets in cell widths/heights. At scale 1 the playfield's visible extent (a mania stage, the taiko strip, the osu!/catch field), measured from what the renderer draws, fills its layout cell's height, or its width when the cell is narrower than the playfield. The background stays in the cell; playfields may be moved over neighbouring cells. These three are set with the layout editor rather than in **Render settings**.
- `hud.score`, `hud.accuracy`, `hud.combo`, `hud.health`: the built-in HUD layers, switched on per track. Accuracy and score appear only after the replay's stored judgement counts verify, combo only when the combo verifies too. For osu! and osu!catch the studio judges the replay itself with the rules of the client that set it (lazer's, or lazer's Classic rules for osu!stable replays): hit windows, note lock, slider heads, ticks, repeats and tails with the 36 ms tail leniency, spinner spins and bonus; catches against the catcher's width. Accuracy then follows that client (lazer counts slider ticks and tails), and the score is the client's own (standardised for lazer, ScoreV1 for stable) whenever the simulated total equals the recorded one; otherwise, and for taiko and mania, the score runs through the judgements to the replay's recorded final score. lazer replays are also checked against the full statistics lazer stores with them. Health follows the recorded life graph. By default they follow lazer's legacy/argon HUD: health bar top left, score top right with accuracy right under it, combo bottom left, each 20 units in from the cell's edges and never overlapping. Units are the cell's short side over 1080, so the HUD keeps its proportions in any cell. `hud.<layer>.dx`/`.dy` are the layer's distance from its corner in those units and `.scale` its size; the layout editor sets them. (Presets holding the earlier fraction-based `hud.<layer>.x`/`.y` drop them and use the defaults.)

Nothing else is drawn on top of the playfields: there is no name header, judgement counter, key overlay or progress bar. Anything more comes from an overlay page. Presets saved by earlier versions keep working: settings this version no longer has (`hud.player`, `hud.judgements`, `key_overlay`) or values outside a setting's range are dropped when the presets load.

Each track card's **Layers** group switches the built-in layers (Score, Accuracy, Combo, Health bar, Hit lighting) and every overlay for that track.

Player presets use exact player names, including Unicode, and apply automatically on import. A per-render setting overrides the preset; the preset overrides tool defaults. Different-difficulty grouping requires the same positive BeatmapSetID, and all tracks must use the same rate. Audio comes from the first track.

### Layout editor

Point at the preview to see the boxes of playfields, HUD layers and overlays; nothing of the editor shows otherwise, so the preview is the export's picture. Click a box to select it. Drag to move; drag a corner to resize (playfields and HUD layers always keep their aspect ratio, overlays with Shift). Edges and centres snap to the canvas and the layout cells; hold Alt to move or resize freely. Arrow keys nudge by one output pixel, Shift+arrow by ten. **Layout** in the Output panel shows the selection's X, Y, W, H, scale and opacity and keeps them in sync (overlays: X/Y from the cell's corner); **Reset** returns it to its default. Positions are stored per replay (playfields, HUD layers) and per overlay layer and are used unchanged by both exports.

### Composition inspector (development aid)

Off by default. Adding `?inspect` to the studio's URL draws, over the preview and into MP4 exports started from that page: cell bounds, the 5 % action-safe and 10 % title-safe areas, every layer's box with its paint-order number and name (backgrounds, playfields, HUD layers, overlays), and a legend with the frame's clock (time, start, end, fade) and per-layer draw times. Render requests carry it as `inspect: true`.

## Export runtimes

The Rust service drives Chrome Headless Shell and streams fixed-clock RGBA frames to external FFmpeg. On first native render, it downloads the release-pinned **156.0.8078.47** Linux/Windows x86_64 archive from Google's Chrome for Testing storage, checks an embedded SHA-256 before extraction/execution, rejects escaping paths/symlinks and oversized archives, and caches the runtime with its complete upstream `LICENSE.headless_shell`. `VOSU_RENDER_CHROMIUM` explicitly overrides this managed runtime for offline/custom installations; `VOSU_RENDER_FFMPEG` selects FFmpeg. No user-installed Chromium or Node is required. Initial rendering requires network access unless the runtime is cached or overridden; system libraries/sandbox support still follow the OS browser requirements. Native output is MP4 with VP9/AAC, not GPL libx264. FFmpeg remains external; use an LGPL-only distribution if redistributing it.

Browser export uses WebCodecs VP9/Opus and writes WebM, with OfflineAudioContext rate/gain mixing. Both paths use the same absolute map-time compositor and GPUTexture readback; preview frames are staged before publication so asynchronous readback cannot blank the currently displayed frame.

## Overlay pages (native MP4)

**Add** in the Output panel's **Overlays** opens a list of the overlays installed in vosu (`GET /tools/_host/v1/overlays`) with a search field: type to filter by nickname, name, author or folder (case and accents ignored; every word must match), use the arrow keys and Enter to pick. Each entry shows the dashboard nickname (else the name), the folder, the author and the page size. At most 80 matches are shown at once, with a count of the rest. Below the list, **Open .html file…** takes the absolute path of a single HTML overlay page, served from its own folder, and **Custom folder…** an absolute folder with `index.html` (the only options on vosu builds without the overlay list).

A newly added overlay is placed at the first spot (top to bottom, left to right) where its page covers no playfield, HUD layer or other overlay in any player's cell; without one it goes under the health bar. **Reset** places it the same way. An overlay added to the composition shows for every player, each copy in that player's cell at the layer's X/Y from the cell's corner, driven by that player's replay; a track card's checkbox switches it off for that player. A layer's page size starts from the overlay's `metadata.txt` resolution; once resized, the size is remembered per overlay in the tool's data folder (`sizes.json`). Each layer has an independent page size, position, scale and opacity. These controls feed the native render queue; the studio draws only the layer's box and does not iframe or execute the overlay. Browser-only WebM export explicitly rejects overlay layers instead of silently omitting them.

The CLI accepts repeated `--overlay /absolute/overlay-folder-or-page.html` arguments. A folder must contain `index.html`; CLI layers default to the full output viewport at (0, 0). The service render request accepts `overlays: [{folder,width,height,x,y,scale,opacity,settings,tracks}]`, where `folder` may also be an `.html` file and `tracks` (absent: all) lists the tracks showing the layer. At most 32 overlay pages run per render (overlays × players). Defaults are read from the overlay's own `settings.json`.

Each player's overlays get their own throwaway loopback origin. Installed pages connect there using their existing `/websocket/v2`, selected-field subscriptions, `/json/v2` and settings-command clients. The renderer publishes that player's map time, keys, recorded life graph and verified scoring state, waits for page acknowledgements, advances Chrome virtual time, captures transparent page images and composites them into the same output frame. Fetches/resources outside that private origin and nonlocal WebSocket connections are blocked; pages never receive vosu host credentials or connect to the live game.

The private origin also serves the replay's map/audio/background assets and local ratings endpoints for `ratings-timeline`. Current pp is calculated with rosu-pp from verified replay judgements, with independently verified combo required where pp depends on combo. Unverified scores/pp remain null. This is a supported synthetic subset of vosu v2, not a memory/API emulator: unsupported fields are absent or null; hit-error arrays describe simulated judgement offsets, not a replacement for stable's precise hold-head/body/tail telemetry. Runtime timers and rendering follow replay time; there is no wall-clock video capture.

## Local verification inputs

`test-fixtures/` is an ignored, non-packaged directory for local copies of user-owned replays/maps/skins. Keep real inputs there rather than relying only on `/tmp`; never commit or distribute them. Run replay tests with `REPLAY_FIXTURES=<absolute>/test-fixtures/real` and `REPLAY_CORPUS=<absolute>/test-fixtures/corpus` when those local fixture sets are available. Synthetic telemetry tests are under `web/test/`.

For a development checkout, run `cargo build --locked -p vosu-replay-renderer`, then copy `target/debug/vosu-replay-renderer` (`.exe` on Windows) into `tools/replay-renderer/bin/` before starting `vosu --tool tools/replay-renderer`. Development executables are ignored; the release packager supplies the compiled binary automatically.
