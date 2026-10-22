# @vosu-tools/ruleset-convert

osu! beatmaps converted to osu!taiko, osu!mania and osu!catch exactly as
osu!lazer converts them, for previews that must show what the player sees.
MIT. Golden-tested against lazer's own converter.

```ts
import { parseOsu, applyMods } from "@vosu-tools/osu-parse";
import { convertBeatmap, catchObjects, maniaKeys } from "@vosu-tools/ruleset-convert";

const map = parseOsu(osuText);                 // an osu! (Mode: 0) map
const mania = convertBeatmap(map, 3, [{ acronym: "4K" }]);
const taiko = convertBeatmap(map, 1);
maniaKeys(map);                                // { columns: 7, stages: 1 }
const fruits = catchObjects(applyMods(convertBeatmap(map, 2), [{ acronym: "HR" }]));
```

- `convertBeatmap(map, ruleset, mods?)` returns an osu-parse `Beatmap` of the
  target ruleset, so renderers treat it like a native map. Maps that are not
  osu! maps, and ruleset 0, come back unchanged (the clients only convert
  osu! maps).
  - **mania**: lazer's legacy pattern generators with their seeded
    `LegacyRandom`; `difficulty.cs` is the total key count. Key count follows
    lazer's rule (CS, OD and the share of sliders/spinners), then the key mods
    `1K`…`10K`; `DS` (Dual Stages) doubles it. osu! slider velocity does not
    scroll mania converts (lazer only scrolls by effect points, which osu!
    maps never carry), so inherited lines are flattened to 1×, kiai kept.
  - **taiko**: hits (kat = whistle/clap, big = finish), drum rolls, swells,
    and sliders split into hits when lazer does. Slider velocity becomes
    scroll speed at each slider's start (not at the green line), as lazer's
    converter post-processes it; this is written into the timing as
    inherited lines.
  - **catch**: the objects stay as they are; use `catchObjects`.
- `catchObjects(map)` returns every fruit, droplet, tiny droplet and banana of
  an osu!-format map (native catch maps go through the same code in lazer)
  after mods were applied: seeded tiny-droplet and banana offsets, Hard Rock
  offsets (`HR` in `visualMods`) and hyper-dash marking with the catcher width
  from the modded circle size.
- Lower level: `legacyBeatmap` (the decoder's view: float difficulty,
  control points resolved in file order with lazer's redundancy rules, node
  sounds, `SliderPath.Distance`), `convertToMania`, `convertToTaiko`,
  `convertToCatch`, `maniaLayout`, `LegacyRandom`.

## Provenance

A port (translated code) of osu! (lazer) by ppy Pty Ltd, MIT,
https://github.com/ppy/osu at tag `2026.1005.0-lazer`
(commit `9a10d935b05a3b896f4bd811d620f2023331db93`):

| This package | lazer source |
| --- | --- |
| `src/random.ts` | `osu.Game/Utils/LegacyRandom.cs` |
| `src/legacy.ts` | `osu.Game/Beatmaps/Formats/LegacyBeatmapDecoder.cs` (timing lines, pending/flush), `Beatmaps/ControlPoints/*` (redundancy, `ControlPointInfo.Add`), `Rulesets/Objects/Legacy/ConvertHitObjectParser.cs` (node sounds, zero-length guard), `LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength`, `Rulesets/Scoring/Legacy/LegacyBeatmapConversionDifficultyInfo.cs` |
| `src/mania.ts` | `osu.Game.Rulesets.Mania/Beatmaps/ManiaBeatmapConverter.cs`, `Patterns/Pattern.cs`, `Patterns/Legacy/{LegacyPatternGenerator,HitCirclePatternGenerator,SliderPatternGenerator,SpinnerPatternGenerator,PatternType}.cs`, `Mods/{ManiaKeyMod,ManiaModDualStages}.cs` |
| `src/taiko.ts` | `osu.Game.Rulesets.Taiko/Beatmaps/TaikoBeatmapConverter.cs`, `Objects/Hit.cs` (type and strength from samples) |
| `src/catch.ts` | `osu.Game.Rulesets.Catch/Beatmaps/{CatchBeatmapConverter,CatchBeatmapProcessor}.cs`, `Objects/{JuiceStream,BananaShower}.cs`, `osu.Game/Rulesets/Objects/SliderEventGenerator.cs`, `UI/Catcher.cs` (catch width) |

The slider paths it relies on live in `@vosu-tools/osu-parse` and port
`ConvertHitObjectParser` path splitting and `SliderPath` (same osu! revision)
plus `PathApproximator` and `CircularArcProperties` from osu!framework
2026.921.1 (commit `37c3e328c8cc7a018234ec78982ea12d3712096a`, MIT).
License texts ship with each tool that bundles this code (see
`THIRD_PARTY_NOTICES.md`).

Float/double boundaries, integer casts, banker's rounding (`Math.Round`) and
the order of every random draw are kept on purpose: later mania patterns and
catch offsets depend on all of them.

## Differences from osu!stable

lazer's converters are written to match stable's (lazer keeps stable's
float quirks for that), so previews of stable play match in nearly every
case. The differences lazer's source itself documents:

- Sliders whose path has zero length lose their repeats in lazer (an
  anti-exploit guard that lazer notes does not match stable).
- Stable makes a drum roll's last tick optional when the next object is too
  close; lazer does not (judgement only, nothing changes on screen).
- Dual Stages (`DS`) is lazer's mod. Stable's equivalent, Co-op, is not
  recognised as a conversion mod here.

## Known limits

- `catchObjects` follows Hard Rock offsets; lazer's catch Mirror and mania
  Random are post-conversion mods that previews approximate in osu-parse's
  `applyMods` (mania Random there is not lazer's .NET `Random`).
- osu-parse drops `NaN` green lines, which lazer reads as 1× without slider
  ticks, and does not add the +24 ms that lazer applies to file formats
  below v5.

## Tests

- `bun test`: three project-authored maps in `test/fixtures` (v7, v12, v14;
  out-of-order timing lines, rounding midpoints, every curve type, spinners,
  hitsounds, kiai, breaks), each compared with lazer's output for taiko,
  mania (automatic, 4K, 7K, DS) and catch (plain, HR). The expected JSON was
  produced by lazer itself through the oracle below.
- `test/golden.ts`: the same comparison for any real maps on the machine,
  copied to a temporary folder first:

  ```sh
  # once: .NET 10 SDK and a ppy/osu checkout at 2026.1005.0-lazer
  dotnet build -c Release -o /tmp/oracle-bin -p:OsuSource=/path/to/osu test/reference
  bun test/golden.ts --oracle /tmp/oracle-bin/oracle.dll --report report.json Songs/*/*.osu
  bun test/golden.ts --oracle /tmp/oracle-bin/oracle.dll --write-fixtures test/fixtures/*.osu
  ```

  `test/reference` (C#, never shipped) runs lazer's
  `WorkingBeatmap.GetPlayableBeatmap` for a ruleset and mods and prints the
  objects. Mania and taiko must match exactly; catch x positions within
  0.05 px.
