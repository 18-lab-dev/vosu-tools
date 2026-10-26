# Skin studio

Browse osu! skins, preview their elements, mix element groups from several skins into a new skin, and edit skin.ini with wiki-backed completion and checks.

Interface: **UI only**. Its native backend starts on demand for the studio and stops when idle; it is not a standalone background service.

![Skin studio](../../docs/screenshots/skin-studio.webp)

## Sources

- **Stable**: folders in the stable `Skins` folder (setting `stable_skins_dir`, else `<osu_dir>/Skins` of the attached stable client). Read and written.
- **Added folders**: any folder with `skin.ini` or lazer's `skininfo.json` (for example lazer's skin editor → File → Edit externally… folder), added from a dashboard session and kept in the tool's data folder. Only `skin.ini` is ever written there.
- **`.osk` files**: added by path like folders (`POST /v1/folders/add` accepts an absolute folder or `.osk` file) and read in place from the archive; never written. Entry names are normalised to `/` and names that would leave the skin are skipped.
- **Lazer**: imported lazer skins through the optional [`lazer-library`](../lazer-library) tool (`GET /v1/skins`, `/v1/skins/<id>/files`, `/v1/skins/<id>/file/<name>`). Skin studio does not list it in `[[requires]]`, so it keeps working without it; those routes are open read routes and are requested without this tool's token. Lazer skins are read-only; built-in lazer skins have no files and are listed but not browsable.

## Mixing

A mix is a base skin (optional) plus per-group picks: a source skin, `default` (leave the elements out so osu! uses its default skin) or `blank` (invisible 1×1 PNGs / silent samples). Groups are per ruleset (`web/src/groups.ts`): hit circles, combo colours, sliders, spinner, judgements; taiko drum, notes, judgements, pippidon; catch fruits, catcher; default mania elements plus one group per `[Mania]` key count (the whole block and the images it references); cursor; numbers and fonts (including files under their skin.ini prefixes); HUD, song select, mod icons, main menu, pause/fail, results; hitsounds, spinner/combo sounds, interface sounds. A group owns its element files (`name`, `name@2x`, animation frames `name-N`/`nameN`) and its skin.ini keys; image and prefix keys bring the files they reference.

`blank` writes an invisible file under the name of every file the base had in the group (`@2x` and animation frames included, so wildcard groups such as default mania elements are covered too); without one the client would fall back to its built-in look, e.g. lazer's grey classic `mania-stage-hint`. A base file that a skin.ini key the mix keeps still names (say another key count's `StageHint: mania-stage-hint`) is kept whatever its group's pick. When `default` or a source skin leaves base elements to the client's built-in look, the Mix panel says so in one line under the group.

### Single assets

On top of groups, a mix can take single assets from any skin (`overrides` in the recipe, `web/src/assets.ts`). A unit is an image with its `@2x` variant and animation frames, a sound, or a font (a skin.ini prefix's glyph set, e.g. `score-*`). An override wins over its group's pick and the base. Lookups follow the clients' legacy rules, so taking a file also carries the skin.ini keys that make the client draw it:

- a `[Mania]` image key (`NoteImage0`, `KeyImage1D`, `StageLeft`, …) that names the file in the source's block for that key count is copied into the mix's block, so the mix draws the file instead of whatever its own block names;
- a font unit sets its prefix key (`HitCirclePrefix`, `ScorePrefix`, `ComboPrefix`) to the copied prefix, keeping prefixes other units still use;
- files that no key names and that are not looked up by default name are kept but marked "unused";
- where an asset depends on configuration that would change other things (for example a font's `HitCircleOverlap`, a mania column's `ColumnWidth`), the Mix panel offers to carry it instead of doing it silently (`carry` in the override).

The UI composes the mix into a build plan:

```json
{
  "name": "My mix",
  "overwrite": false,
  "ini": "[General]\r\nName: My mix\r\n…",
  "sources": [{ "skin": "/…/Skins/Base", "files": ["hitcircle.png", ["from.png", "to.png"]] }],
  "blanks": [{ "to": "cursor.png", "kind": "png" }]
}
```

`skin` is a library key from `GET /v1/library` (an absolute folder, or `lazer:<id>`). `POST /v1/build` (write route) creates a stable skin: output is staged in a hidden folder inside `Skins` and renamed into place; an existing skin of the same name is replaced only with `overwrite: true` (the UI asks first) and is swapped atomically. `POST /v1/exports` (write route) accepts the same plan for an `.osk` (a zip lazer imports) and answers `{"url":"v1/exports/<id>","filename":"<name>.osk"}`; `GET` on that URL streams the archive once as a download, within a few minutes. Nothing is written outside `Skins`; the browser saves the `.osk` where the user chooses. With `credits`, `skin-studio-credits.txt` lists the source skins.

**Download plan** in the studio saves the mix recipe as JSON for inspection.

A key-count group (`NK stage`) also carries the images its source block leaves to default names (`mania-key1`, `mania-note2H`, `lightingN`, `mania-hit300`, …): the source draws its own files under those names, so the mix copies exactly the files the lookup reads (frames before a plain image for animated pieces, `@2x` kept) into `skin-studio/<N>k/` and names them in the block. The mix's own default-named files stay for its other key counts. Receptors and notes that still come from osu!'s built-in look are named under the group.

## Keymodes

The **Keymodes** tab edits the mix draft's `[Mania]` blocks column by column. Elements and Preview stay the place to browse what a skin's key counts look like; this screen is where a mix chooses images per column.

- **Key counts** (left): every key count the draft's skin.ini has a block for, plus **Add key count** (1K–10K). Each shows a diagram of its stage (render-core's layout and column colours) and a status: *complete*, *falls back* (a column image comes from osu!'s built-in look) or *missing images* (a key or note draws nothing). 12K–18K dual stages are listed but not edited, because render-core does not draw them.
- **Stage** (centre): the key count drawn by render-core as a still frame (keys up, a hold and a note in every column) at the draft's own layout, or **Play** for the looping demo. Clicking a column selects it; images dropped on a column set the selected role there.
- **Slots**: a grid with one grid column per stage column (so a slot sits under its column) and one row per image role: Key, Key pressed, Note, Hold head, Hold body, Hold tail; then Width, Line, Colour and Light (`ColumnWidth`, `ColumnLineWidth`, `Colour#`, `ColourLight#`). Each slot shows the image the client draws, where it comes from (`ini`: the block names it; `default`: found under its default name; `built-in`; `missing`; `→ note` when a hold head or tail draws another piece), `@2x` and frame count; the tooltip has the key and raw value. **Stage images** (StageLeft/Right/Bottom/Hint/Light, LightingN/L, Hit0–Hit300g) follow below.
- **Picker** (right): images of the mix draft, dropped files or any library skin (stable, added folders, `.osk`, lazer), each with its `@2x` and frames. With a slot selected, images the source's own skin.ini uses for that role come first, then names that match the role.
- **Assigning**: select a slot, then click an image; or drag an image onto a slot or a stage column; or drop PNG/JPEG files from the desktop onto a slot (one image with its `@2x` and frames) or onto the picker (any number). Dropped files are checked (a file name, not a path; PNG or JPEG by content; at most 1 MiB, the most vosu passes to a tool; frames `-0`, `-1`, … without gaps), stored by the service (`POST /v1/uploads`) and offered as **Dropped files**. Problems are reported under the grid.
- **Bulk actions**, each one undo step: **Apply to all columns** (the selected slot's image in every column), **Mirror** (column `N-i` takes column `i`: 7↔1, 6↔2, 5↔3 in 7K), **osu! 1/2/S pattern** (every column takes the images of the first column of its kind, the kinds behind osu!'s default names), **Copy key count from…** (another key count of this mix or of any skin; when the counts differ each column takes the source column of the same kind nearest in relative position).
- **Keyboard**: arrows move between slots and fields, Enter selects a slot and moves to the picker (arrows, Enter assigns, Escape returns), Delete clears a slot, Ctrl+Z / Ctrl+Shift+Z undo and redo.
- **From the Explorer**: with a slot selected on this screen, the Explorer's **Use as 7K column 4 key** (the slot's name) sets it to the selected image and switches back here. Explorer images can also be dragged: holding the drag over the Keymodes tab opens it, then drop on a slot or stage column. Tab switching was chosen over a split view: both panes need the width, and the Explorer's tree and list stay as they are.

Data model: the recipe's `keymodes` holds per key count the slots (`{skin, name, files}` to copy, `{value}` for an image the mix already has, or `null` to leave the key out) and values. Composing applies them after picks and overrides: the block is created when missing, image copies go to `skin-studio/<N>k/<name>` (one copy per image however many columns use it; `<name> (2)` when two images share a name, since `-2` would read as a frame) and each key is set to that path without extension. When the draft skin.ini was edited by hand, a Keymodes change writes just the keys it touched into it; hand edits of a block show on the screen, since it reads the draft's skin.ini. Building and `.osk` export are unchanged: the files and keys travel in the plan.

Dropped files live in the tool's data folder (`uploads/<drop>/<name>`; one folder per drop, named from the files' content) and are never deleted automatically: mix drafts live in the browser's storage, which the service cannot see, so no age or startup rule can tell whether a draft still needs a file. The Mix panel's **Dropped files: N (size)** lists them and marks the ones the current draft uses. **Remove unused** deletes only the others, after a confirmation naming their count and size and warning that other open Skin studio tabs or saved drafts in other browsers may still use them; the page sends exactly those names (`POST /v1/uploads/remove`) and the service deletes nothing else. Names differing only in case are refused, since osu! and Windows treat them as one file.

`web/e2e/keymodes.e2e.ts` checks the screen end to end on two real skins in an isolated vosu (`vosu --tool`, private network and PID namespaces, SwiftShader, temporary HOME and XDG folders): assigning by click, drags onto a slot and a stage column, Explorer assignment and drag, a desktop drop with an invalid file, removing unused dropped files (declined, then confirmed), Mirror, the 1/2/S pattern, Copy key count, undo and redo, a hand edit of skin.ini, thumbnails, colour swatches, page scroll at four window sizes, an `.osk` export whose skin.ini and files are read back and whose render-core stage is compared with the screen's, and a whole 7K stage group exported from a block naming no images.

Lookups follow lazer's legacy mania rules (ppy/osu 2026.1005.0-lazer, `osu.Game.Rulesets.Mania/Skinning/Legacy`): `LegacyKeyArea` looks up `KeyImage#`/`KeyImage#D` else `mania-key{F}`/`mania-key{F}D` as textures; `LegacyNotePiece`, `LegacyHoldNoteHeadPiece` (head, else note), `LegacyHoldNoteTailPiece` (tail, else head, else note) and `LegacyBodyPiece` look up `NoteImage#{,H,T,L}` else `mania-note{F}{,H,T,L}` as animations; `F` is `LegacyManiaColumnElement.FallbackColumnIndex` (`S` for an odd stage's middle column, else `1`/`2` alternating from the edges). `getManiaImage` in `osu.Game/Skinning/LegacySkin.cs` reads the first `[Mania]` block for the key count (`LegacyManiaSkinDecoder` drops later duplicates); `LegacySkinExtensions.GetTextures` takes the first skin providing `name-0` or `name`. render-core implements these as `maniaImageKeys` and `resolveManiaImages` (`packages/render-core/src/mania.ts`).

## Explorer

The **Explorer** tab is an in-page browser (no native file dialog) for any library skin, with its own skin switcher so one skin can be browsed while another is focused: a folder tree, a virtualised file list (name, asset, kind, size, pixel size measured from the image) with a filter, and a details pane (image or animation preview, sound play button, text view of `.ini`/`.txt`/`.json` up to 2 MiB through `GET /v1/asset`). **Assets** lists one row per mix unit (an image with its `@2x` variant and frames, a sound, a font's glyphs; `unitOf` in `web/src/assets.ts`), **Files** one row per file. Selected rows (click, Ctrl/Shift+click; keyboard: arrows, Shift+arrows, Space, Ctrl+A, Enter, Escape; Down from the filter) go into the mix as single-asset overrides with **Use in mix**; when everything selected already is, the button removes it. Sounds play only from their play button. Elements tiles and Mix override rows have **Files** to reveal an asset here, and **Show in Elements** jumps back to its tile. Nothing in the Explorer renames, moves or deletes files.

## Previews

`GET /v1/asset?skin=&name=` serves images and audio; `GET /v1/animation?skin=&element=` assembles an element's frames into a looping APNG at the skin's `AnimationFramerate` (or the whole sequence over one second when unset), cached by content hash in the tool cache folder (`animations/`).

The **Preview** tab plays a short looping demo map per ruleset (`packages/demo-maps`: osu!, taiko, catch, and mania 1K–10K) through the shared renderer (`packages/render-core`: WebGPU, or WebGL2 without it; the preview status names the one drawing) with the selected skin, including unsaved skin.ini edits, or the mix draft with its overrides. Mania offers exactly the key counts that have a `[Mania]` block with `Keys: N` in the previewed skin.ini, in order (lazer's default 4K and 7K when it defines none); dual-stage counts above 10K are listed but not previewed. Only the shown key count's stage is decoded. It is muted and draws nothing while hidden.

## skin.ini editor

The **skin.ini** tab is a Monaco editor. Its completion, hover documentation and checks come from the osu! wiki's skin.ini reference at a recorded wiki revision (`packages/skin-spec`, which keeps only the interoperability facts). Saving replaces `skin.ini` atomically, keeps the previous file as a `skin.ini.backup-*.bak` copy in the skin folder, and refuses to overwrite a file that changed outside the editor.

## Loading

The first view (library, Elements, Explorer, Mix) loads about 100 KB of script and style; skin.ini text is held outside the editor. The Monaco editor (only its core and the suggest, hover, colour picker, code action and snippet contributions; no other languages) is a separate chunk loaded when the skin.ini tab first opens, and prefetched into the HTTP cache, without running, once the first view is idle (`editor-prefetch.json`, written by `web/vite.config.ts`). Word-based suggestions and link detection are off, so the editor worker only starts if Monaco needs it. The Preview tab's renderer loads with that tab. Explorer thumbnails are decoded and scaled once in a worker (`src/thumbs.worker.ts`) and kept as small bitmaps, only for rows on screen.

## Settings

`settings.json`: Stable Skins folder, show lazer skins, credits file, and which ruleset's elements to show first (`follow` tracks the current beatmap's ruleset live).
