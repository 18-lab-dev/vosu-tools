# @vosu-tools/client-skin

The osu! client's current skin for tool previews drawn with
[`@vosu-tools/render-core`](../render-core/README.md). MIT OR Apache-2.0.

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

## API

- `new ClientSkin({ onChange, fetch?, maniaKeys? })`: `onChange(state)` runs
  synchronously after every change; bitmaps the new skin no longer uses are
  released right after it returns, so hand `state.skin` to the renderer there.
  `fetch` defaults to the global one (the tool page is on the overlay origin).
  `maniaKeys` (default: every key count) limits which mania key counts skin
  images are decoded for; tools that follow maps pass `[]`.
- `useManiaKeys(keys)`, `hasManiaKeys(keys)`: decode the shown skin's mania
  images for exactly these key counts (render-core's `maniaKeysFor(map,
options)`; `[]` outside mania) and release the others. Images shared by
  both sets are kept, repeated calls for the set being loaded wait for that
  load, and the skin stays as it is until the new set is ready, so set the
  new beatmap once `hasManiaKeys` is true (Map preview keeps drawing the
  previous scene meanwhile). Later skin loads use the same key counts.
- `state: SkinState`: `{ skin, choice, label, source, message, tone, busy }`;
  `choice` is `"client"`, `"user"` (a file or folder) or a built-in name.
- `useClient({ force = true })`, `gameChanged(client, skinFolder)`: see above.
- `useBuiltin(name, source?)`: `"legacy" | "triangles" | "argon" | "argon-pro"`.
- `loadOsk(file)`: an `.osk` archive, read in the browser (ZIP, stored or
  deflated entries; a single wrapping folder is unwrapped; ZIP64 is refused).
- `loadFolder(files)`: the files of an `<input type="file" webkitdirectory>`.
- `say(message, tone?)`: a status line without changing the skin.
- `destroy()`: releases the loaded bitmaps (call after the renderer is gone).
- `SKIN_POINTERS`, `builtinLabels`, and the lower-level `readCurrentSkin`,
  `hostSkinFiles` and `openOsk`.

Tests: `bun test` (a stand-in vosu serving skins by filename).
