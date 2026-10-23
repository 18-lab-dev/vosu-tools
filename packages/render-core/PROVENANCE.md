# Provenance of the built-in skins

`src/builtin.ts` draws the osu! clients' built-in skins (Argon, Argon Pro,
Triangles and the classic stable/lazer default) from scratch with Canvas 2D,
and `src/shader.ts` renders slider bodies with the clients' colour profiles.
Both are original code. They reproduce published measurements and formulas,
read from the MIT-licensed osu! (lazer) source:

- Repository: https://github.com/ppy/osu
- Tag: `2026.1005.0-lazer`, commit `9a10d935b05a3b896f4bd811d620f2023331db93`
- License: MIT, Copyright (c) 2025 ppy Pty Ltd (text in
  `tools/map-preview/licenses/ppy-osu-MIT.txt`)

| Element | Source consulted (paths under the repository) | Used |
| --- | --- | --- |
| Argon hit circle | `osu.Game.Rulesets.Osu/Skinning/Argon/ArgonMainCirclePiece.cs` | Border thickness `128·2/58`, gradient thickness ×2.5, layer sizes, `Darken(4)`, `Darken(0.1)`, `Darken(0.5/0.6)` colour factors |
| Argon slider body | `…/Argon/ArgonSliderBody.cs`, `…/Argon/OsuArgonSkinTransformer.cs` | Path radius (outer gradient size / 2), border = gradient thickness, body `Darken(4)`, body alpha 0.98 / 0.92 (Pro) |
| Triangles slider body | `osu.Game.Rulesets.Osu/Skinning/SliderBody.cs`, `…/Default/DrawableSliderPath.cs` | Border portion 0.128, body alpha 0.8 → 0.3 from edge to centre |
| Classic slider body | `osu.Game.Rulesets.Osu/Skinning/Legacy/LegacySliderBody.cs` | Shadow portion `1 − 59/64` at 0.25 black, border portion 0.1875, `Darken(0.1)` → lightened accent, body opacity 0.7 |
| Triangles hit circle | `…/Default/MainCirclePiece.cs`, `CirclePiece.cs`, `RingPiece.cs` | 9 px white ring, additive triangles at 50 % |
| Combo colours | `osu.Game/Skinning/ArgonSkin.cs`, `SkinConfiguration.cs`, `DefaultLegacySkin.cs` | Argon's six colours; the default four |
| Argon mania | `osu.Game.Rulesets.Mania/Skinning/Argon/*` | Column colours per key count, note 42 high with 0.82 accent and 3.4 corners, 60 / 120 column widths, hold body `Darken(0.6)`, column background `Darken(3)` at 0.8 |
| Triangles mania | `…/Mania/Skinning/Default/*`, `ManiaTrianglesSkinTransformer.cs`, `UI/Column.cs`, `UI/Stage.cs` | Odd / even / special column colours, note 12 high, widths 80 / 70, `HIT_TARGET_POSITION` 110 |
| Classic mania keys, hit target | `…/Mania/Skinning/Legacy/LegacyKeyArea.cs`, `LegacyHitTarget.cs` | Key images keep their own height (124.8 units from HitPosition 402 to the stage edge); the hint is drawn 0.9 × 1.6025 times its height |
| Taiko | `osu.Game.Rulesets.Taiko/Skinning/Argon/*`, `…/Default/CirclePiece.cs`, `Objects/Hit.cs` | Argon ring thicknesses 20/70 and 5/70 and colours; default centre `#bb1177` / rim `#2299bb`; 8 px ring |

Lazer stage units convert to legacy skin.ini units by dividing by 1.6
(lazer's legacy `POSITION_SCALE_FACTOR`).

No source code, shaders, fonts or textures were copied into the built-in
skins. Nothing from
`ppy/osu-resources` (CC BY-NC 4.0) is used: classic elements that are
textures in the clients (hit circles, digits, mania notes and keys, fruit,
catcher) are original drawings that approximate their look. The catch
catcher is drawn as a plate; the clients' characters are not reproduced.

# Provenance of the legacy mania layout

`src/mania.ts`, the mania branch of `src/scene.ts` and the mania parts of
`src/shader.ts` (hold bodies, texture flips, bar lines) are a port
(translated code) of osu! (lazer)'s legacy mania skinning at the same tag,
under its MIT license: `osu.Game/Skinning/LegacyManiaSkinDecoder.cs`,
`LegacyManiaSkinConfiguration.cs`, the mania lookups of `LegacySkin.cs`,
`LegacySkinExtensions.cs` (animation frame lookup and lengths),
`osu.Game.Rulesets.Mania/UI/{Stage,ColumnFlow,Column}.cs`,
`UI/Components/HitPositionPaddedContainer.cs`,
`Objects/Drawables/{DrawableHoldNote,DrawableBarLine,DrawableManiaHitObject}.cs`,
`osu.Game/Rulesets/Objects/BarLineGenerator.cs` and every
`osu.Game.Rulesets.Mania/Skinning/Legacy/*` piece (stage background and
foreground, column background, key area, hit target, note, hold head, tail
and body pieces, hit explosion, `ManiaLegacySkinTransformer`). Element sizes
come from osu!framework's `Sprite` / `TextureAnimation` sizing (2026.921.1).

`test/reference/VosuManiaLayout.cs` is a test-only harness that runs lazer's
own `DrawableManiaRuleset` headless against a skin folder; it is never
packaged.
