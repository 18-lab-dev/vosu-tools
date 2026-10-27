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
| osu! Random | `osu.Game.Rulesets.Osu/Mods/OsuModRandom.cs`, `Utils/OsuHitObjectGenerationUtils{,.Reposition}.cs` | Seeded Gaussian section/flow offsets, angle sharpness 1–10, combo/downbeat analysis, slider flipping/rotation, centre-of-mass sampling, edge steering, path bounds, oversized-slider fallback and decreasing shifts of up to ten preceding circles. |
| Catch Mirror | `osu.Game.Rulesets.Catch/Mods/CatchModMirror.cs` | Mirror native fruit and juice-stream x positions and slider control points. **Caveat:** stable generates banana-shower positions at runtime; those are not encoded or guaranteed mirrored by this bake. |
| Mania / taiko Constant Speed | `ManiaModConstantSpeed.cs`, `TaikoModConstantSpeed.cs`; stable scroll normalization described below | Remove authored scroll changes by compensating local BPM, while retaining timing/sample/effect data and preserving taiko roll durations/tick counts. |
| HT / DT | `osu.Game/Rulesets/Mods/Mod{HalfTime,DoubleTime}.cs`, `RateAdjustModHelper.cs` | Defaults 0.75 / 1.5, tempo-only by default; pitch toggle uses resampling. |
| NC / DC | `osu.Game/Rulesets/Mods/Mod{Nightcore,Daycore}.cs` | Frequency always 1.5 / 0.75, then tempo factor `selectedRate/defaultRate`. Custom NC at 1.2× therefore keeps 1.5× pitch, rather than resampling at 1.2×. Percussion overlays are not exported. |

The seeded compatibility generator was checked against <https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Random.CompatImpl.cs> (MIT). Signed integer seeds, including `int.MinValue`, retain .NET wrapping subtraction. Default seed is explicitly 0; the UI/CLI exposes it and generated names record it.

Reference vector derived by stepping that generator at seed 1: `Next()` = **534011718, 237820880, 1002897798, 1657007234, 1412011072**. Sorting the first four gives mania lane mapping **[1, 0, 2, 3]**. Multiplying samples by 2 and truncating gives taiko **centre, centre, centre, rim, rim**. Golden fixtures assert the emitted map, not merely reproducibility between two calls to the same implementation.

Canonical combination order: Invert/Hold Off, Random, Mirror, Constant Speed, rate/difficulty rewrite. Invert+Hold Off and taiko Swap+Random are rejected. One rate mod may be selected. A custom rate overrides its default. A literal 1.0 together with HT/DT/NC/DC selects that mod's default (use no rate mod for a true 1.0× transform).

## Ported implementation

`crates/osu-file/src/{map,audio}.rs` and `tools/practice/src/{store,main,cli,tests}.rs` originate from vosu `4c06922:crates/vosu-tool-trainer`, MIT OR Apache-2.0. Retiming preserves unknown sections/comments, CRLF, embedded storyboard variables, sample/animation/video/break/bookmark timestamps, red beat lengths, inherited timing semantics, slider lengths/repeats, spinner ends, hold ends, preview time and BeatmapID=0. Audio is decoded as MP3, Vorbis or WAV, processed offline with Signalsmith Stretch or rubato, and encoded as Vorbis. Export packaging retains named assets and emits warnings for unavailable/unsafe assets; it never imports automatically or opens applications.

Mania transforms (Invert, Hold Off, Mirror, Random) and the reported key count use the key count osu! (lazer) plays from `CircleSize` (`crates/mania-keys`, also `maniaKeyCount` in `@vosu-tools/osu-parse`): clamped to 1–18, rounded half to even, two stages of half the count above 10 keys, 5 when the line is missing.

Generated deletion is index-based, validates containment and hashes before any removal, and preserves shared assets and user-modified files. Named option profiles (`profiles.json`) live in the tool data directory, never browser storage; profiles keep trim padding but not one map's trim ranges. Map analysis are fetched from the optional `map-analysis` tool and labeled as source-map data at the selected rate, never presented as post-transform ratings.

Resampled rate changes (pitch follows rate) previously dropped rubato's `output_delay()` frames although `SincFixedIn` output is already aligned with its input, so resampled maps were early by `sinc_len / 2 / rate` samples (≈1.9 ms at 1.5×). That drop is removed; `crates/osu-file/tests/trims.rs::resampled_clicks_stay_on_time` measures click placement for both pitch modes.

## Trims (original implementation)

`crates/osu-file/src/trim.rs` is original vosu-tools code. A trim keeps the objects whose start lies in a selected source range. Each range's window runs from `lead_in_ms` before its first kept object (never before 0) to `lead_out_ms` after its last kept tail (slider, spinner and hold ends included), in whole milliseconds; touching windows merge. Windows are laid end to end with `gap_ms` between them, and the gap is written as a break when it is at least 650 ms. Order of operations: ruleset transforms on the whole map (so a trimmed section equals the same section of an untrimmed copy, Random included), then the trim, then the rate change.

At each window start the active red line is re-emitted a whole number of beats before the window (beat phase kept) when that lands after the previous window, otherwise exactly at the window start; it takes volume, sample set and effects from the latest point and the meter from the red line, followed by a copy of an active green line. Points inside the window are shifted. The first object of each section starts a new combo. Breaks are clipped to their window (kept when ≥650 ms), bookmarks outside every window are dropped, and a PreviewTime outside every window moves to the first kept object. Trimmed maps keep the background event only; storyboard, video and event samples are removed and reported, and a stable folder's shared `.osb` is reported because it still plays untrimmed.

Audio is cut with the same mapping, sample-exactly (`round(ms × rate / 1000)` per window edge), with optional raised-cosine fades at section edges and silence in gaps, before the rate change. The golden test `trimmed_map_golden` freezes a hand-derived two-section result; `audio_cut_is_sample_exact`, `audio_fades_shape_section_edges` and `audio_cut_survives_rate_change_and_vorbis` check click placement through the cut, a 1.5× resample and a Vorbis round trip (≤1 ms, including integer-ms rounding of object times).

## Stable Constant Speed bake

The osu! wiki [mania ranking criteria](https://github.com/ppy/osu-wiki/blob/c9fa3ff277dba4c620d4731fd2c3fbb74770c20b/wiki/Ranking_criteria/osu!mania/en.md) explicitly requires normalizing variable-BPM sections to the most-used BPM shown in song selection. Its glossary identifies inherited green lines as the additional scroll multiplier. The [taiko mapping explanation](https://osu.ppy.sh/community/forums/topics/1068894) confirms that inherited SV affects taiko scroll speed. Lazer's stable-compatibility `LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength` and `TaikoBeatmapConverter.shouldConvertSliderToHits` were inspected at the recorded osu revision; the latter documents the operation ordering needed for stable's integer drumroll durations. The historical stable-reference repository URL was unavailable (GitHub repository-not-found); no claim of running stable itself is made.

For a fixed player scroll setting and map slider multiplier, section scroll speed is proportional to `localBPM × SV / mainBPM` (the map-wide scaling is constant). Let `L` be the local beat length and `M` the dominant/main beat length. Set `SV = L/M`, so `localBPM × SV = mainBPM`; serialize inherited beat length as `−100 × M/L`. This removes authored SV effects without deleting red timing points. Every existing point retains its meter, sample set/index, volume, uninherited flag and effects; after a red reset, add a compensating green line unless one already follows at that timestamp. No-op reapplication is idempotent. Absolute mania hold endpoints and all object timestamps remain unchanged.

In stable mania/taiko, negative inherited beat length is float-quantized and its magnitude clamped to 10–10000 (`SV` 0.01–10); unrepresentable BPM ratios are rejected, never silently clamped. Taiko rolls lock their timing/SV at the head. Rewrite pixel length by `oldLength × oldBeatFactor/newBeatFactor`, retaining repeats. An ULP-level correction preserves the exact legacy integer-duration result if division crosses a truncation boundary. The timing beat length and slider tick rate are unchanged, so roll ticks are unchanged, including rolls crossing subsequent SV/BPM changes. The multi-BPM golden fixtures preserve kiai and sample-only timing points and independently check legacy durations and tick counts.

## osu! Random reference verification

`crates/osu-file/src/osu_random.rs` ports the recorded lazer algorithms; `rosu-map 0.2.1` (MIT) supplies parsed slider paths and the Bezier/Catmull/perfect/linear curve implementation. The rotation epsilon is the framework float epsilon, 0.001. Circle radius includes the legacy 1.00041 allowance. The fast playfield diagonal matches osuTK's single-Newton-step inverse-square-root formula, rather than substituting exact sqrt.

The three golden outputs `osu-random-{1-7,1337-1,-42-10}.osu` were produced by **executing the original C# `OsuModRandom` and both generation helper files** on .NET 8.0.131. Reproducible reference sources and harness are under `crates/osu-file/tests/reference/`; run `dotnet run --project crates/osu-file/tests/reference -- crates/osu-file/tests/fixtures/osu-random.osu 1 7`. The small reference type adapters implement circle/spinner and linear-path behavior used by that fixture; they are test-only, not a replacement production renderer. The fixture exercises repeated sliders, an oversized slider, spinners, combo sections, meter/BPM changes and edge fitting. Exact serialized integer coordinates and path points match for seeds 1, 1337 and −42 at sharpness 7, 1 and 10. `.osu` integer coordinates use ties-to-even rounding; this necessarily quantizes lazer's floating-point positions.

Catch Mirror's banana-shower caveat appears in both UI and CLI help. It deliberately preserves spinner/shower records rather than pretending generated bananas have explicit map coordinates.


## Intentionally not offered

This implementation is **not the complete requested transform catalog**. No approximate/fake implementations or non-functional controls are shipped for:

- Native mania key conversion and Dual Stages: `ManiaKeyMod.cs` and `ManiaModDualStages.cs` explicitly skip native-mania conversion. Dual Stages' remaining native-map effect is playfield presentation. The standard-to-mania converter is not ported.
- Wind Up / Down: nonlinear timing cannot be faithfully represented inside arbitrary stable sliders by merely scaling each object's start; variable-rate audio plus slider/tick restructuring has not been implemented.
- Difficulty values outside 0–10: stable acceptance has not been established, so those inputs are rejected rather than silently clamped.

Gameplay-only visibility/input/scoring behavior, No Release and adaptive speed cannot be encoded as a static map. Nightcore's beat overlay is explicitly excluded. Generated practice maps are unranked local copies; no lazer scoring equivalence is asserted.
