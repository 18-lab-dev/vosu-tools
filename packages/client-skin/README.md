# @vosu-tools/client-skin

The osu! client's current skin, and its mania scroll speed, for tool previews
drawn with [`@vosu-tools/render-core`](../render-core/README.md). MIT OR
Apache-2.0.

```ts
import { ClientSkin, SKIN_POINTERS } from "@vosu-tools/client-skin";

const skins = new ClientSkin({
  onChange(state) {
    renderer?.setSkin(state.skin); // always set; classic look until a load finishes
    showSkin(state.label, state.source, state.message, state.tone, state.busy);
  },
});
await skins.useClient(); // the client's current skin
// From the game subscription (`/client`, `/folders/skin`):
skins.gameChanged(client, skinFolder);
// After the subscription reconnects:
skins.useClient({ force: false });
```

## How the client's skin is shown

`useClient()` reads vosu's report, `GET /files/skin/` on the overlay origin
(`{client, name, files, builtin, base}`), and then:

| Report                                                                                 | Shown                                                                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `files: true`, stable or a classic-based lazer skin                                    | The skin's files, loaded by filename from `/files/skin/<path>`; elements it lacks come from the classic look |
| `builtin` (lazer's Argon, Argon Pro, Triangles, classic, retro)                        | render-core's `builtinSkin` look; "retro" is drawn with the classic look and says so                         |
| `base` Argon / Triangles (a lazer skin derived from one)                               | That built-in look with the skin's `[Colours]` from its `skin.ini`                                           |
| No client, files unavailable, nothing served, no report (older vosu), vosu unreachable | The classic look and a one-line reason in `state.message`                                                    |

Built-in looks are drawn once and reused. `useClient({ force: false })` and
`gameChanged` reload only when the report differs from the last one, and
`gameChanged` only while the client's skin is the current choice. A later load
always wins over one still in progress.

When the report lists the skin's files (`entries: [{path, size, modified |
hash}]`, `truncated: false`; vosu 1.2.0 and later), only listed files are
requested, by their listed names (so a `skin.ini` path's case does not have to
match the file's); the skin loader's guesses for files a skin lacks (`@2x`
variants, animation frames) never reach vosu. Without the list (older vosu, or
a list cut short) every name is asked for, as before. A changed file changes
the report, so the skin reloads. Files are fetched through the browser's HTTP
cache: vosu's validators make a later visit revalidate them instead of
downloading them again.

## API

- `new ClientSkin({ onChange, fetch?, scope? })`: `onChange(state)` runs
  synchronously after every change; bitmaps the new skin no longer uses are
  released right after it returns, so hand `state.skin` to the renderer there.
  `fetch` defaults to the global one (the tool page is on the overlay origin).
  `scope` (render-core's `SkinScope`, default: everything) limits which
  rulesets' images and which mania key counts are requested and decoded;
  tools that follow maps pass `{ rulesets: [], maniaKeys: [] }`.
- `useScope(scope)`, `hasScope(scope)`: decode the shown skin's images for
  exactly this scope (render-core's `sceneScope(map, options)`: the scene's
  ruleset and mania stage) and release the others. Images shared by both
  scopes are kept, images the skin turned out not to have are not requested
  again, repeated calls for the scope being loaded wait for that load, and
  the skin stays as it is until the new set is ready, so set the new beatmap
  once `hasScope` is true (Map preview keeps drawing the previous scene
  meanwhile). `hasScope` is false while the first skin from files is still
  loading, and `useScope` resolves after such a load, so nothing is drawn in
  the fallback look first. Later skin loads use the same scope.
- `state: SkinState`: `{ skin, choice, label, source, message, tone, busy }`;
  `choice` is `"client"`, `"user"` (a file or folder) or a built-in name.
- `useClient({ force = true })`, `gameChanged(client, skinFolder)`: see above.
  A `force: false` reload that finds the same skin already loading joins
  that load instead of fetching every file again.
- `useBuiltin(name, source?)`: `"legacy" | "triangles" | "argon" | "argon-pro"`.
- `loadOsk(file)`: an `.osk` archive, read in the browser (ZIP, stored or
  deflated entries; a single wrapping folder is unwrapped; ZIP64 is refused).
- `loadFolder(files)`: the files of an `<input type="file" webkitdirectory>`.
- `say(message, tone?)`: a status line without changing the skin.
- `destroy()`: releases the loaded bitmaps (call after the renderer is gone).
- `SKIN_POINTERS`, `builtinLabels`, and the lower-level `readCurrentSkin`,
  `hostSkinFiles` and `openOsk`.

## Mania scroll speed

`readManiaSettings(value)` reads vosu's `/settings/mania` (subscribe to
`MANIA_SETTINGS_POINTER`): lazer's `scrollSpeedValue`, stable's per-beatmap
speed when the client uses per-beatmap speeds, else the `scrollSpeed` integer;
a missing or zero speed is unknown. `scrollUp` is lazer's upward scrolling,
`bpmScale` stable's BPM-scaled mode.

`maniaScroll({ override?, setting?, client, rate? })` picks the speed a preview
draws with: the page's field, else the tool's dashboard setting, else the
client's (`client` is null without a connected client), else lazer's default
(8, `LAZER_DEFAULT_SCROLL_SPEED`), and returns `{ setting, source, speed,
note }`. `note` is one line for the control's hint naming the source.

Both clients draw the same 1-40 setting at the same on-screen speed, whatever
the skin's hit position (lazer has matched stable since ppy/osu#26131), and
that is render-core's `scrollSpeed`. Both keep that speed in real time at any
rate: lazer scales its time range by the track's tempo × frequency. So
`speed` is `setting / rate`, where `rate` is how fast the preview's clock runs
(map milliseconds per real millisecond): Map preview passes the client's rate
while following it; Practice and Skin studio pass 1, because the client plays
a generated 1.1x map at rate 1 too and the demo maps loop in real time.

These live in `@vosu-tools/client-skin/scroll` too, which imports nothing, so
a page can follow the speed before it loads the renderer.

Tests: `bun test` (a stand-in vosu serving skins by filename).
