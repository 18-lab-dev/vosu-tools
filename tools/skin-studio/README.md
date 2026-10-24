# Skin studio

Browse osu! skins, preview their elements, mix element groups from several skins into a new skin, and edit skin.ini with wiki-backed completion and checks.

## Sources

- **Stable**: folders in the stable `Skins` folder (setting `stable_skins_dir`, else `<osu_dir>/Skins` of the attached stable client). Read and written.
- **Added folders**: any folder with `skin.ini` or lazer's `skininfo.json` (for example lazer's skin editor → File → Edit externally… folder), added from a dashboard session and kept in the tool's data folder. Only `skin.ini` is ever written there.
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

**Download plan** in the studio saves this JSON; `vosux skin-studio build plan.json [--osk out.osk] [--overwrite]` builds it later.

## Previews

`GET /v1/asset?skin=&name=` serves images and audio; `GET /v1/animation?skin=&element=` assembles an element's frames into a looping APNG at the skin's `AnimationFramerate` (or the whole sequence over one second when unset), cached by content hash in the tool cache folder (`animations/`).

The **Preview** tab plays a short looping demo map per ruleset (`packages/demo-maps`: osu!, taiko, catch, and mania 1K–10K) through the shared WebGPU renderer (`packages/render-core`) with the selected skin, including unsaved skin.ini edits, or the mix draft with its overrides. Mania offers exactly the key counts that have a `[Mania]` block with `Keys: N` in the previewed skin.ini, in order (lazer's default 4K and 7K when it defines none); dual-stage counts above 10K are listed but not previewed. Only the shown key count's stage is decoded. It is muted and draws nothing while hidden.

## CLI

```sh
vosux skin-studio list [--json]
vosux skin-studio export "<skin name or key>" [--name NAME] [--stable | --out FILE.osk] [--overwrite]
vosux skin-studio build plan.json [--osk FILE.osk] [--overwrite]
```

`export` copies one whole skin (for example a stable skin into a lazer `.osk`).

## Settings

`settings.json`: Stable Skins folder, show lazer skins, credits file, and which ruleset's elements to show first (`follow` tracks the current beatmap's ruleset live).
