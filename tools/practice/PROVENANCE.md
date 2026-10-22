# Practice transform provenance

## Recorded sources

The source checkout inspected on 2026-10-21 is **ppy/osu `2f4e620cbc6245fb88fe1113c1842c213ea58701`** (MIT). All source paths below are relative to <https://github.com/ppy/osu/tree/2f4e620cbc6245fb88fe1113c1842c213ea58701>.

| Transform | Inspected source | Baked behavior |
| --- | --- | --- |
| Mania Invert | `osu.Game.Rulesets.Mania/Mods/ManiaModInvert.cs` | Group by lane, sort starts, generate one hold per adjacent pair with duration `max(delta/2, delta - beatLengthAtNext/4)`; discard final object of each lane, preserve head samples, clear breaks. Existing hold tails are not source locations. |
| Mania Hold Off | `osu.Game.Rulesets.Mania/Mods/ManiaModHoldOff.cs` | Holds become taps at their starts with head samples. Changes to most-common BPM caused by shortened final holds are compensated in scroll-speed control points. Common beat length follows `osu.Game/Beatmaps/Beatmap.cs`, including first timing point forced to zero and 0.001 ms beat-length grouping. |
| Mania Mirror | `osu.Game.Rulesets.Mania/Mods/ManiaModMirror.cs` | `column = totalColumns - 1 - column`; serialize lane centers to avoid the x=512 boundary. |
| Mania Random | `osu.Game.Rulesets.Mania/Mods/ManiaModRandom.cs` | Stable ordering of columns by one seeded `System.Random.Next()` per column. This is **not Fisher-Yates**. |
| Taiko Swap / Random | `osu.Game.Rulesets.Taiko/Mods/TaikoMod{Swap,Random}.cs` | Only single hits change. Rim is whistle/clap bits (2 or 8); finish/strong bit 4 is retained. Rolls and spinners consume no random values and remain unchanged. Random uses `Next(2) == 0` for centre. |
| osu! Mirror | `osu.Game.Rulesets.Osu/Mods/OsuModMirror.cs` | Horizontal x=512−x; vertical y=384−y; reflect every absolute slider control point; spinners remain unchanged. |
| HT / DT | `osu.Game/Rulesets/Mods/Mod{HalfTime,DoubleTime}.cs`, `RateAdjustModHelper.cs` | Defaults 0.75 / 1.5, tempo-only by default; pitch toggle uses resampling. |
| NC / DC | `osu.Game/Rulesets/Mods/Mod{Nightcore,Daycore}.cs` | Frequency always 1.5 / 0.75, then tempo factor `selectedRate/defaultRate`. Custom NC at 1.2× therefore keeps 1.5× pitch, rather than resampling at 1.2×. Percussion overlays are not exported. |

The seeded compatibility generator was checked against <https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Random.CompatImpl.cs> (MIT). Signed integer seeds, including `int.MinValue`, retain .NET wrapping subtraction. Default seed is explicitly 0; the UI/CLI exposes it and generated names record it.

Reference vector derived by stepping that generator at seed 1: `Next()` = **534011718, 237820880, 1002897798, 1657007234, 1412011072**. Sorting the first four gives mania lane mapping **[1, 0, 2, 3]**. Multiplying samples by 2 and truncating gives taiko **centre, centre, centre, rim, rim**. Golden fixtures assert the emitted map, not merely reproducibility between two calls to the same implementation.

Canonical combination order: Invert/Hold Off, Random, Mirror, rate/difficulty rewrite. Invert+Hold Off and taiko Swap+Random are rejected. One rate mod may be selected. A custom rate overrides its default. A literal 1.0 together with HT/DT/NC/DC selects that mod's default (use no rate mod for a true 1.0× transform).

## Ported implementation

`crates/osu-file/src/{map,audio}.rs` and `tools/practice/src/{store,main,cli,tests}.rs` originate from vosu `4c06922:crates/vosu-tool-trainer`, MIT OR Apache-2.0. Retiming preserves unknown sections/comments, CRLF, embedded storyboard variables, sample/animation/video/break/bookmark timestamps, red beat lengths, inherited timing semantics, slider lengths/repeats, spinner ends, hold ends, preview time and BeatmapID=0. Audio is decoded as MP3, Vorbis or WAV, processed offline with Signalsmith Stretch or rubato, and encoded as Vorbis. Export packaging retains named assets and emits warnings for unavailable/unsafe assets; it never imports automatically or opens applications.

Generated deletion is index-based, validates containment and hashes before any removal, and preserves shared assets and user-modified files. Settings live in the tool data directory, never browser storage. Ratings are fetched from the published ratings current-map API and labeled as source-map/rate data, never presented as post-transform ratings.

## Intentionally not offered

This implementation is **not the complete requested transform catalog**. No approximate/fake implementations or non-functional controls are shipped for:

- osu! Random (requires full slider path geometry, combo/beat analysis and boundary fitting from `OsuHitObjectGenerationUtils`, not a point scatter).
- Catch Mirror: the inspected source mirrors post-conversion fruit offsets, juice-stream nested objects and generated banana positions. Reflecting only `.osu` x coordinates does not reproduce those generated positions, so this is not advertised as faithful.
- Constant Speed: both inspected mania/taiko classes set a drawable `ScrollVisualisationMethod.Constant`, not simply delete inherited timing points. A correct stable bake requires scroll normalization across BPM changes while preserving slider/roll durations and hitsound timing. Blanket SV deletion is not shipped.
- Native mania key conversion and Dual Stages: `ManiaKeyMod.cs` and `ManiaModDualStages.cs` explicitly skip native-mania conversion. Dual Stages' remaining native-map effect is playfield presentation. The standard-to-mania converter is not ported.
- Wind Up / Down: nonlinear timing cannot be faithfully represented inside arbitrary stable sliders by merely scaling each object's start; variable-rate audio plus slider/tick restructuring has not been implemented.
- Difficulty values outside 0–10: stable acceptance has not been established, so those inputs are rejected rather than silently clamped.

Gameplay-only visibility/input/scoring behavior, No Release and adaptive speed cannot be encoded as a static map. Nightcore's beat overlay is explicitly excluded. Generated practice maps are unranked local copies; no lazer scoring equivalence is asserted.
