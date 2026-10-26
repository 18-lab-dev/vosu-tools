# Export targets: Quaver and Etterna

The Mix panel's **Export as** offers osu! stable folder, osu!lazer `.osk`, **Quaver** and **Etterna**. Quaver and Etterna get the mix's osu!mania stages only: every key count the mix's skin.ini has a `[Mania]` block for (lazer's 4K and 7K when it has none), resolved the way lazer draws them (`web/src/export-targets.ts`, on render-core's `maniaConfig` / `resolveManiaImages`, the same lookups as the Keymodes screen) and converted by the service (`src/export/`). Nothing of either game is bundled: every image is the mix's own, or one of the plain shapes of render-core's classic look (`src/export/raster.rs`) where osu! would draw its built-in look.

Sources (read, not copied):

- Quaver `Quaver/Quaver` `d22a4a312479e73cd652a5f4683d3607e6795620` (Quaver.API `a921d561b2ece7f6bf3682446696c06c17b81649`, Wobble `e6bede973bb7f0729368713b9ae623c59edc25d1`): `Quaver.Shared/Skinning/SkinStore.cs`, `SkinKeys.cs`, `SkinKeysFolder.cs`, `SkinManager.cs` (`.qs` import/export), `Quaver.Shared/Config/ConfigHelper.cs`, `Screens/Gameplay/Rulesets/Keys/Playfield/GameplayPlayfieldKeys.cs`, `GameplayPlayfieldKeysStage.cs`, `HitLighting.cs`, `HitObjects/GameplayHitObjectKeys.cs`, `Screens/Gameplay/UI/JudgementHitBurst.cs`, `Quaver.API/Enums/GameMode.cs`, `Helpers/ModeHelper.cs`, `Wobble/Assets/AssetLoader.cs`, default `skin.ini`s under `Quaver.Resources/Textures/Skins/{Bar,Arrow,Circle}`.
- Etterna `etternagame/etterna` `2d706147cc4bcf95a8ceb24dc4f4129be207f803`: `src/Etterna/Singletons/NoteSkinManager.cpp`, `GameManager.cpp`, `src/Etterna/Actor/Gameplay/NoteDisplay.cpp`, `ReceptorArrow.cpp`, `GhostArrowRow.cpp`, `src/Etterna/Models/NoteLoaders/NotesLoaderOSU.cpp`, `src/Etterna/Models/StepsAndStyles/Style.cpp`, `NoteSkins/instructions.txt`, `NoteSkins/common/common/{NoteSkin.lua,metrics.ini,Fallback Explosion.lua}`, `Themes/_fallback/Scripts/1{1,2} Assets*.lua`, `Themes/*/Graphics/Player judgment/default.lua`.
- osu! side: ppy/osu `2026.1005.0-lazer` (`osu.Game.Rulesets.Mania/Skinning/Legacy`, `osu.Game/Skinning/LegacySkinExtensions.cs`), as ported in `packages/render-core/src/mania.ts`.

Units: lazer's mania stage is 768 units tall (legacy units × 1.6). Quaver skin values are 1366×768 screen units (`QuaverGame.SkinScalingFactor` = 1920/1366 scales them to its 1920×1080 virtual screen), so lazer sizes carry over unchanged. Etterna's screen is 480 units tall, the legacy unit: lazer sizes are divided by 1.6.

## Quaver

**Output:** `<name>.qs`, a zip of the skin folder (what `SkinManager.Export` writes); drop it on Quaver or extract it into `Skins/<name>/`. Quaver's import extracts into a folder named after the file and overwrites files of the same name there. **Key counts:** `GameMode` Keys1–Keys10; 11K+ is skipped and listed. Quaver's skin.ini is read with IniFileParser and `ConfigHelper` (`int.TryParse` for integer keys, so integers are written as integers; booleans `True`/`False`); keys a mode section leaves out come from the user's default skin (Bar/Arrow/Circle `skin.ini`), so the export writes every layout key it maps.

| osu! (lazer) | Quaver | How |
| --- | --- | --- |
| `[Mania]` block for N keys | `[NK]` section, folder `nk/` | `SkinKeys.ModeShorthand`; folders `Receptors`, `HitObjects`, `Lighting`, `Stage`, `Editor` (case-sensitive) |
| `ColumnWidth` (per column) | `ColumnSize` (one value) | mean, ×1.6; per-column widths are lost (noted) |
| `ColumnSpacing` | `NotePadding` | mean; `StageReceptorPadding: 0`, `ColumnAlignment: 0` |
| `KeyImage#` / `KeyImage#D` | `Receptors/receptor-up-N.png` / `receptor-down-N.png` | lazer draws keys column wide at their **own** height; Quaver at the image's aspect, so each key is resampled to the column width at its height, then padded (transparent rows on top) to the tallest key so every lane shares one hit line |
| `HitPosition` | `ReceptorPosOffsetY: 0`, `HitPosOffsetY = receptorHeight − hitPosition` | receptor bottom on the screen bottom; notes' bottom edges hit `HitPosOffsetY` below the receptor top (`GameplayPlayfieldKeys.SetReferencePositions`), i.e. `hitPosition` above the bottom as in lazer |
| `NoteImage#`, `#H` (head, else note) | `HitObjects/note-hitobject-N.png`, `note-holdhitobject-N.png` | first frame (Quaver notes do not animate); heights from the aspect at `WidthForNoteHeightScale` in both games |
| `NoteImage#T` (tail → head → note) | `note-holdend-N.png`, `DrawLongNoteEnd: True` | stored flipped: lazer flips tails in downscroll, Quaver flips ends in upscroll (`FlipNoteEndImagesOnUpscroll: True`) |
| `NoteImage#L` | `note-holdbody-N.png` or `note-holdbody-N@1xF.png` | frames as a sprite sheet; both animate bodies while held (30 ms / 30 fps). `NoteBodyStyle` repeat: Quaver stretches (approximated) |
| `WidthForNoteHeightScale` | `WidthForNoteHeightScale` | ×1.6 |
| notes flip in upscroll | `FlipNoteImagesOnUpscroll: True` | also flips receptors and column light, as lazer mirrors them |
| `KeysUnderNotes` | `ReceptorsOverHitObjects` | negated |
| `StageLight` + `ColourLight#` | `Lighting/column-lighting.png` + `ColumnColor#` | column wide at its own height; `ColumnLightingOffsetY = lightPosition − receptorHeight`; Quaver's column colours default to transparent, so all are written |
| `LightingN` (frames) + `LightingNWidth` | `Lighting/hitlighting[@1xF].png`, `HitLightingScale`, `HitLightingFps`, `HitLightingY` | one image for all lanes; scale = mean width scale × 1920/1366 ÷ pixel density (Quaver sizes lighting in image pixels); fps from lazer's frame length `max(1000/60, 170/F)` ms; `HitLightingY = receptorHeight/2 − hitPosition` (Quaver centres on the receptor, lazer on the hit line; exact in downscroll) |
| `LightingL` + `LightingLWidth` | `Lighting/holdlighting[@1xF].png`, `HoldLightingScale`, `HoldLightingFps` | as above, looping while held |
| `StageLeft` / `StageRight` | `Stage/stage-left-border.png` / `-right-border.png` | own width over the full height (resampled so Quaver's aspect sizing matches) |
| `StageHint` + `JudgementLine` / `ColourJudgementLine` | `Stage/stage-hitposition-overlay.png` | hint at lazer's 0.9 × 1.6025 height over the stage width, judgement line baked into its bottom row; Quaver puts the overlay's bottom on the hit line, lazer centres the hint on it (shifted by half its height) |
| `Colour#` (column backgrounds, alpha doubled as lazer draws it) | `Stage/stage-bgmask.png`, `BgMaskAlpha: 1` | generated strip, one segment per lane |
| `ColourBarline` | `Stage/stage-timingbar.png` (white pixel), `TimingLineColor` | |
| — | `Stage/stage-distant-overlay.png` | transparent: osu! has none, Quaver's default would draw one |
| `Hit300g`, `Hit300`, `Hit200`, `Hit100`, `Hit50`, `Hit0` | `Judgements/judge-marv`, `perf`, `great`, `good`, `okay`, `miss` (`.png` or `@1xF.png`) | Quaver has one judgement set for all modes: 4K's, else the smallest key count's (noted). Frames share one canvas because Quaver sizes every judgement box from the miss frame; `JudgementHitBurstScale` = canvas height, `JudgementHitBurstFps: 20` (lazer's judgement rate); Quaver plays them once where lazer loops. Built-in or missing judgements are left to Quaver's default |
| `ScorePosition` | `JudgementBurstPosY = scorePosition − 384` | offset from the screen middle |
| editor | `Editor/note-hitobject-N`, `note-holdbody-N`, `note-holdend-N` | same images |
| `UpsideDown`, scroll direction | — | a player setting in both games; dropped |
| `StageBottom`, `ColumnLineWidth`, `ColourColumnLine`, `BarlineHeight`, `LightFramePerSecond`, `SpecialStyle`, `SplitStages`, `ColumnStart`/`ColumnRight` | — | no Quaver equivalent (lane lines, stage bottom) or unused by lazer too |
| mines, lane covers, scratch lane (`7K+1`), snap colours | — | Quaver-only; its defaults apply |
| osu! built-in keys/notes/bodies | generated shapes | render-core's classic shapes, counted in the report |

Quaver has no osu! skin converter: the only osu! conversion in its code is `Quaver.API/Quaver.Tools/Commands/ConvertOsuCommand.cs` (maps). Image sides above 8192 px are scaled down (osu! skins ship hold bodies 40000 px tall).

## Etterna

**Output:** `<name> (Etterna).zip` with `NoteSkins/<game>/<name> <N>K/` per key count and `Assets/Judgments/<name> 1x6 (doubleres).png`; extract into Etterna's folder (`NoteSkins/instructions.txt`, first row). **Key counts and games** (`NotesLoaderOSU.cpp` maps osu!mania CircleSize; `GameManager.cpp` styles):

| osu! | Etterna steps type, game / style | NoteSkins folder | Buttons by column | Column spacing |
| --- | --- | --- | --- | --- |
| 1K, 2K | none (`StepsType_Invalid`) | skipped | | |
| 3K | dance-threepanel, dance / threepanel | `dance` | Left, Down, Right | 64 |
| 4K | dance-single, dance / single | `dance` | Left, Down, Up, Right | 64 |
| 5K | pump-single, pump / single | `pump` | DownLeft, UpLeft, Center, UpRight, DownRight | 48 |
| 6K | dance-solo, solo / single | `dance` (NoteSkinManager: "solo use dance noteskins") | Left, UpLeft, Down, Up, UpRight, Right | 64 |
| 7K | kb7-single, kb7 / single | `kb7` | Key1–Key7 | 64 |
| 8K | dance-double, dance / double | `dance` | Left, Down, Up, Right × 2 (controller 1, 2) | 64 |
| 9K | pnm-nine, popn / popn-nine | `popn` | Left White … Red … Right White | 32 |
| 10K | pump-double, pump / double | `pump` | 5 pump buttons × 2 | 48 (+8 between sides) |
| 11K+ | — | skipped | | |

Etterna's other games (ez2, ds3ddx, beat, maniax) are not targets of its osu! loader. A noteskin serves one game, and dance holds 3K, 4K, 6K and 8K, so each key count is its own noteskin (`<name> 4K`, …), chosen in Etterna's options per style.

**Noteskin conventions used** (minimum working static noteskin): `metrics.ini` with `[Global] FallbackNoteSkin=common` (skipping the game's `default`, whose `NoteSkin.lua` redirects every dance button to Down and rotates it), and a `NoteSkin.lua` that receives the fallback chain's table (`...`, `common`'s loader) and replaces `Load`. `NoteDisplay` asks for `Tap Note`, `Tap Mine`, `Tap Lift`, `Tap Fake` and `Hold`/`Roll` × `Head`/`Topcap`/`Body`/`Bottomcap`/`Tail` × `Active`/`Inactive` (hold parts must be Sprites); `ReceptorArrow` for `Receptor` (commands `Press`, `Lift`, `ReverseOn`/`Off`, `W1`…); `GhostArrowRow` for `Explosion` (`W1`–`W5`, `HoldingOn`/`Off`, `RollOn`/`Off`, `HitMine`). `GetPath(button, element)` finds `<button> <element>*` in the noteskin, then each fallback, then `Fallback <element>*`; more than one match is an error. Sprite sheets are named `<name> <columns>x<rows>`; `(doubleres)` marks images at two pixels per unit. Every image here is written at 2 px per unit with `(doubleres)`, named `_tap 01`, `_key 01`, … (deduplicated by content, unique as wildcard prefixes); the generated `NoteSkin.lua` maps each (button, controller) to its column, so double styles keep both sides' own images. Receptor and judgement *positions* are the theme's (`ReceptorArrowsYStandard`/`Reverse` in the theme's metrics, Til Death ±164; judgement placement in the theme) — a noteskin can only offset its own actors, which is how osu!'s hit position is kept.

| osu! (lazer) | Etterna | How |
| --- | --- | --- |
| `ColumnWidth` | column spacing (fixed by the style) | every column piece is scaled by `k = spacing / ColumnWidth` (legacy units); `ColumnSpacing` is dropped |
| `NoteImage#` | `Tap Note` | column wide, height from the aspect at `WidthForNoteHeightScale` × k; frames → sheet, `TapNoteAnimationLength = F/60 s` (lazer's 60 fps), `AnimationIsBeatBased=0` |
| `NoteImage#H` | `Hold Head`, `Roll Head` (Active, Inactive) | as notes |
| `NoteImage#T` | `Hold Bottomcap`, `Roll Bottomcap` | osu! tails are authored for upscroll (lazer flips them in downscroll); Etterna's standard scroll is up and `FlipHoldBodyWhenReverse=1` flips caps and body in reverse; `StopDrawingHoldBodyOffsetFromTail=0`, `Hold Tail` hidden |
| `NoteImage#L`, `NoteBodyStyle` | `Hold Body`, `Roll Body`, `UseStretchHolds` | column wide at its aspect; stretch for style 0, tiled otherwise; `TopHoldAnchorWhenReverse=1` |
| — | `Hold Topcap` | hidden (osu! has none) |
| `KeyImage#`, `KeyImage#D` | `Receptor` (two sprites; `Press` shows the pressed key, `Lift` the other) | column wide at the key's own height (legacy units, not scaled by k); offset so osu!'s stage bottom sits `HitPosition` below the hit line, plus half the note height, because Etterna judges a note at its centre and osu! at its bottom edge; `ReverseOff` (upscroll) mirrors it, as lazer does |
| `LightingN` + `LightingNWidth` | `Explosion`: additive sprite flashed on `W1`–`W5` (80 ms in, 120 ms out, lazer's fade), frames at `max(1000/60, 170/F)` ms | zoom = width scale × k; centred on the receptor (the note's centre at its hit), not osu!'s hit line |
| `LightingL` + `LightingLWidth` | `Explosion`: sprite shown on `HoldingOn`/`RollOn` | looping |
| `Hit300g` … `Hit0` | `Assets/Judgments/<name> 1x6 (doubleres).png` (rows W1 Marvelous, W2, W3, W4, W5, Miss; `Player judgment` themes index rows so) | first frame of each, on one cell size; chosen under Assets → Judgments; omitted (noted) when any is osu!'s built-in look or missing |
| `Colour#`, `ColourLight#`, `StageLight`, `StageLeft/Right/Bottom/Hint`, `JudgementLine`, `ScorePosition`, `ColourBarline` | — | stage furniture, judgement placement and lane colours belong to Etterna's theme |
| mines, lifts, fakes, mine explosions | `common`'s fallbacks | Etterna-only; the generated loader passes them to `common` |
| rotation | none | Etterna's dance `default` rotates one Down arrow per button. osu! notes are per-column images (circles, bars, or arrows already drawn per column), so every column draws its own image unrotated |
| upscroll flip of notes | — | Etterna cannot flip tap notes by scroll direction: notes look as in osu!'s downscroll (Etterna's reverse) in both directions |
| animation per column | per button | Etterna times animations per button in metrics; a double style's second side uses the first side's frame counts (noted) |

## Verification (what was proven)

- **Unit tests** (`cargo test -p vosu-skin-studio`, `bun test` in `web/`): key-count support, element names, sprite-sheet layout (exact cell counts, scaling to 8192 px), hit-position, lighting and judgement conversions, request parsing and validation, both writers end to end on synthetic stages; the web side's lazer lookups (`@2x` per frame, head/tail fallbacks, doubled alpha).
- **End to end** (`web/e2e/export.e2e.ts`): an isolated vosu with a read-only copy of a real skin exports both targets through the UI and checks names, reports, archives and that the copy is unchanged.
- **Quaver's own parser**: a .NET harness compiled against Quaver's `ConfigHelper`, `ModeHelper`, `GameMode`, `Judgement`, `SkinKeysFolder` and IniFileParserStandard 1.0.1 with `ConcatenateDuplicatedKeysIniDataParser` reads the exported `skin.ini` as `SkinStore.LoadConfig` does, checks that every written key is one `SkinKeys.ReadConfig` reads (extracted from its source) and that Quaver's reader accepts the value, finds every texture `SkinKeys`/`SkinStore` look up (sprite-sheet regex and cell division included), decodes them with SkiaSharp, and recomputes the hit line with `GameplayPlayfieldKeys`'s formula. Quaver itself cannot be built from source (`Quaver.Server.Client` is private), so no Quaver screenshot.
- **Etterna's own Lua**: each `NoteSkin.lua` compiles with LuaJIT and runs under a loader that chains Etterna's `common/common/NoteSkin.lua` first and resolves files with `NoteSkinManager::GetPath`'s rules, for every element and column of the style. Etterna builds from source here (no Vulkan, no crashpad), but a gameplay run was not done.
