# Skin studio

Browse osu! skins, preview their elements, mix element groups from several skins into a new skin, and edit skin.ini with wiki-backed completion and checks.

## Sources

- **Stable**: folders in the stable `Skins` folder (setting `stable_skins_dir`, else `<osu_dir>/Skins` of the attached stable client). Read and written.
- **Added folders**: any folder with `skin.ini` or lazer's `skininfo.json` (for example lazer's skin editor → File → Edit externally… folder), added from a dashboard session and kept in the tool's data folder. Only `skin.ini` is ever written there.
- **Lazer**: imported lazer skins through the optional [`lazer-library`](../lazer-library) tool (`GET /v1/skins`, `/v1/skins/<id>/files`, `/v1/skins/<id>/file/<name>`). Skin studio does not list it in `[[requires]]`, so it keeps working without it; those routes are open read routes and are requested without this tool's token. Lazer skins are read-only; built-in lazer skins have no files and are listed but not browsable.

## Mixing

A mix is a base skin (optional) plus per-group picks: a source skin, `default` (leave the elements out so osu! uses its default skin) or `blank` (invisible 1×1 PNGs / silent samples). Groups are per ruleset (`web/src/groups.ts`): hit circles, combo colours, sliders, spinner, judgements; taiko drum, notes, judgements, pippidon; catch fruits, catcher; default mania elements plus one group per `[Mania]` key count (the whole block and the images it references); cursor; numbers and fonts (including files under their skin.ini prefixes); HUD, song select, mod icons, main menu, pause/fail, results; hitsounds, spinner/combo sounds, interface sounds. A group owns its element files (`name`, `name@2x`, animation frames `name-N`/`nameN`) and its skin.ini keys; image and prefix keys bring the files they reference.

The UI composes the mix into a build plan and posts it to `POST /v1/build` (write route):

```json
{
  "name": "My mix",
  "target": "stable",
  "overwrite": false,
  "ini": "[General]\r\nName: My mix\r\n…",
  "sources": [{ "skin": "/…/Skins/Base", "files": ["hitcircle.png", ["from.png", "to.png"]] }],
  "blanks": [{ "to": "cursor.png", "kind": "png" }]
}
```

`skin` is a library key from `GET /v1/library` (an absolute folder, or `lazer:<id>`). Stable output is staged in a hidden folder inside `Skins` and renamed into place; an existing skin of the same name is replaced only with `overwrite: true` (the UI asks first) and is swapped atomically. `.osk` output (a zip lazer imports) is written to `export_dir` (default: Downloads) through a temporary file and, with `open_osk`, handed to the operating system so lazer imports it. With `credits`, `skin-studio-credits.txt` lists the source skins.

**Download plan** in the studio saves this JSON; `vosux skin-studio build plan.json [--target osk] [--overwrite]` builds it later.

## Previews

`GET /v1/asset?skin=&name=` serves images and audio; `GET /v1/animation?skin=&element=` assembles an element's frames into a looping APNG at the skin's `AnimationFramerate` (or the whole sequence over one second when unset), cached by content hash in the tool cache folder (`animations/`).

## CLI

```sh
vosux skin-studio list [--json]
vosux skin-studio export "<skin name or key>" [--name NAME] [--stable] [--overwrite]
vosux skin-studio build plan.json [--target stable|osk] [--overwrite]
```

`export` copies one whole skin (for example a stable skin into a lazer `.osk`).

## Settings

`settings.json`: Stable Skins folder, show lazer skins, `.osk` export folder, open `.osk` after export, credits file, and which ruleset's elements to show first (`follow` tracks the current beatmap's ruleset live).
