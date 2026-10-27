# Mania ratings provenance and semantics

## Calculator selection

The compiled calculator is **MinaCalc 527** from Etterna revision
[`2d706147cc4bcf95a8ceb24dc4f4129be207f803`](https://github.com/etternagame/etterna/tree/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/MinaCalc),
retrieved 2026-10-21. License: MIT; copyright (c) 2016–2023 Etterna.
`../../crates/minacalc/vendor/LICENSE` retains the full grant. The source paths are
`src/Etterna/MinaCalc/**`, `src/Etterna/Models/NoteData/NoteDataStructures.h`,
and root `LICENSE`, mapped to `crates/minacalc/vendor/`.

One local patch surrounds the `load_calc_params_from_disk(true)` call in
`Calc::InitializeHands` with the same `!STANDALONE_CALC && !PHPCALC` guard
used elsewhere upstream. Without this guard upstream standalone compilation
fails because the method is not declared. No difficulty arithmetic is modified.
`crates/minacalc/src/minacalc.cpp` is a project-authored exception-safe C ABI;
its build uses `cc` and a C++20 compiler, with no bindgen, Git or downloads.

Alternatives evaluated:

* [Glubus/minacalc-rs](https://github.com/Glubus/minacalc-rs/tree/0e39361919080e8f883ea9fd0ce99b16a78cb647)
  is MIT, wraps version **515**, and its sys build script invokes bindgen/libclang
  and Git to patch a temporary source tree. It is neither the latest upstream
  calculator nor suitable for our compiler-only build contract. None of its code
  is vendored.
* [`etterna` 0.1.0](https://docs.rs/etterna/0.1.0/etterna/) exposes a player skill
  timeline, not a current chart calculator. The suggested `minacalc` Rust crate
  could not be established at docs.rs (404); no verified pure-Rust 527 port was
  found. We do not substitute an unverified port for upstream algorithm fidelity.

## Input semantics

`rosu-map =0.2.1` parses native mania. The key count is the one osu! (lazer)
`2026.1005.0-lazer` plays (`crates/mania-keys`, the rule every tool shares
with the web UIs' `maniaKeyCount`): `LegacyBeatmapDecoder.applyDifficultyRestrictions` clamps a mania
`CircleSize` to 1–18 (`MAX_MANIA_KEY_COUNT`), `ManiaBeatmapConverter.getColumnCount`
returns `Math.Max(1, Math.Round(CircleSize))` for a native map (`Math.Round`
rounds half to even: 1.111111 → 1, 6.5 → 6, 7.49 → 7, 7.5 → 8), and above
`MAX_STAGE_KEYS` (10) the converter plays two stages of half the count each, so
11, 13, 15 and 17 become 10, 12, 14 and 16 columns. A missing `CircleSize` is
osu!'s default 5. (Converted osu! maps derive the count from OD and the
slider/spinner share instead; they are not rated.) The chart's `CircleSize` line
is rewritten to that count before any calculator reads it, so every system and
the column mapping use it; `tests/playable.rs` checks the columns against
lazer's own converter. Each calculator rates only the key counts its upstream supports and
otherwise reports `unrated.<system> = {scope:"keys", reason}` instead of a value:
MinaCalc 4K–7K (one dedicated `Ulbu` model each; 5K is Etterna's pump/5K model), Quaver.API
1K–10K (its `LaneToFinger`, including the 10K two-thumb layout), Interlude 3K–10K
(`Layout.keys_on_left_hand`), osu!mania stars every key count, Reform 4K only.
No calculator is ever run on another key count's model. See `KEYMODES.md`.

MinaCalc 527 has a Technical model only on 4K and 5K (the 6K/7K/generic models
never fill `TechBase`), so `msd.technical` is `null` elsewhere. Outside 4K the
Jumpstream and Handstream slots hold its generic chordstream and bracketing
models; upstream names them `Skill_Chordstream` and `Skill_Bracketing`
(`GenericSkillset`), and so do the UI, CLI and timeline `skill_names`; the JSON
keys stay `jumpstream`/`handstream`. Its `Chisel` search stops at 100
and returns 0 for a skillset past that; non-4K outputs are then scaled by 4/keys,
so 5K, 6K and 7K top out at 80, 66.67 and 57.14 MSD. Past that, upstream returns 0 for the
skillset and NaN stamina (the cause of the old "MinaCalc failed (2)" rate-curve
error on hard 7K charts). Such outputs are reported as `unrated.etterna =
{scope:"rate"}` with the reason; rate curves and local-MSD timelines leave gaps.
Column is `floor(x * keys / 512)` with x=512 clamped to the last column, matching
osu's right-edge behavior. Equal float-second timestamps are merged with OR;
input timestamps remain unscaled and playback rate is passed separately.

**Slider and spinner objects are converted as osu! plays them.** Some native
mania charts contain slider- or spinner-type
objects, and the game plays them. osu! (lazer) `2026.1005.0-lazer`
(`9a10d935b05a3b896f4bd811d620f2023331db93`, MIT, ppy Pty Ltd):
`ManiaBeatmapConverter` for a native map (`IsForCurrentRuleset`) sends a slider
through `PassThroughPatternGenerator`, which makes it a hold over the slider's
duration (spans × `SliderPath.Distance` ÷ velocity, velocity =
100 × `SliderMultiplier` × SV ÷ beat length) in the column of its x. A spinner
goes through `SpinnerPatternGenerator`: a column drawn from `LegacyRandom`
(seeded from the clamped HP, CS, OD and AR; column 0 on 8K for a finish spinner
shorter than 1 s), a hold of the spinner's length, or a note under 100 ms.
`src/playable.rs` ports this and rewrites only those lines before any
calculator reads the chart, so every system rates the chart that is played; the
reported checksum stays the file's MD5. lazer's converter is a port of stable's;
stable itself was not run.

The upstream loaders would rate a different chart: Etterna's `NotesLoaderOSU`
(`2d706147`), Quaver.API's `OsuBeatmap` (`a921d561`) and Interlude's
`OsuConverter` (`1fe55766`) skip these objects, and Prism's chart parser reads
them as taps (on a local 7K chart, 903 of 3,232 objects are sliders). They all
get the converted chart instead. `tests/reference/lazer/generate.py` runs
lazer's own decoder and converter (the `packages/ruleset-convert` oracle) and
`tests/playable.rs` checks every converted note and hold (start, end, column,
kind) against it, on committed fixtures and, through `VOSU_LAZER_REFERENCE`, on
local charts.

**Long notes contribute heads only.** MinaCalc's `NoteInfo` has only a column
bitmask and time, not a hold duration or release flag. Etterna's serialized input
uses tap/hold-head/roll-head rows, not release events. Artificial tail taps would
invent jack/stream difficulty; this adapter does not do so. MSD/SSR therefore
measure the chart's *rice/head pattern*, not LN release, overlap, or holding
strain. This limitation also applies to the experimental dan estimate.

MSD calls `CalcMain` with `ssr=false` and canonical 0.93 goal. SSR uses upstream
`MinaSDCalc` with the supplied Wife-style score goal, including upstream goal
caps and low-accuracy/grind scaling; this is not osu!mania accuracy. Notes are
limited to 0–24000 seconds, ensuring the slowest allowed 0.5 rate remains below
upstream's 100000 half-second interval bound. Upstream dense/joke-chart skipping
behavior is retained, including all-zero results for rejected interval density.

## Experimental Reform model

Model id: **`reform-v1-course-msd527@1`**. This is a deliberately transparent
piecewise-linear interpolation of overall MSD against ten *actual course*
measurements, not fabricated thresholds or a trained player-performance model.
`calibration.json` contains computed 1.0x overall MSD for Reform v1 dans 1–10.
Dans 1–6 use the 1st Pack; 7–10 use the 2nd Pack. The duplicate 6th in 2nd Pack
is deliberately not used. Values are rounded to six significant decimal digits.
`calibration-sources.json` records archive URL, exact filenames, MD5 and SHA-256.
Charts/audio are **not redistributed**; their authors retain their rights.

Source: [Emik's DDMythical-authorized archive](https://sites.google.com/view/danreform/home),
[archive ZIP](https://cdn.emik.dev/archive/dan/all.zip),
[original project thread](https://osu.ppy.sh/community/forums/topics/597350).
The archive explicitly warns that metadata is modified and course versions are
not interchangeable. This model describes only these v1 course charts.

Reproduce: download `all.zip`, extract `1st Pack - v1.osz` and `2nd Pack - v1.osz`
as ZIPs, verify each selected `.osu` against `calibration-sources.json`, then run
`vosux mania-ratings <chart.osu> --rate 1 --json`
in ascending dan order. The CLI uses the exact production parser and native
calculator and prints computed values without changing model files. Calibration
was independently computed with a standalone C++20 reference driver calling
upstream `Calc::CalcMain(notes, 1.F, 0.93F)`, `keycount=4`, `ssr=false`, head-only
rows grouped by float seconds; production computations reproduce these anchors.

Between anchor MSDs A[n] and A[n+1], value = n + (MSD-A[n])/(A[n+1]-A[n]).
The label is `Reform floor(value)`. No extrapolation: below dan 1, above dan 10,
non-finite values, and every key count other than 4K return `dan:null` with an
`unrated.reform` reason. Estimation uses rate-specific MSD,
not the requested score goal. `experimental:true` is always set. A single map
cannot certify a course clear: stamina distribution, breaks, LN strain and
osu!mania's 96% course-clear accuracy rule are not modeled. These are similarity
estimates, not player ranks or clear guarantees.

Research alternatives: [Companella](https://github.com/Leinadix/companella/tree/1f0af45835d044d98ac164bc0c0e879df757051b)
is MIT (copyright 2025 Leinadix). Its `DanModelService` loads an ONNX gradient
boosting regressor requiring eight MSD features plus Interlude and Sunny ratings;
its shipped `dans.json` contains -1 unset anchors. We reuse neither its model nor
its code. Its Daniel implementation credits TheBagelOfMan under MIT, but adds a
separate strain calculator, not a simple calibration of current MinaCalc.

## Experimental 7K Regular dan model (ours)

Model id: **`jinjin-7k-regular-msd527@1`**, 7K only. Piecewise-linear
interpolation of MinaCalc 527 **7K** overall MSD (1.00×, 0.93 goal, rate-specific
like Reform) between the 14 charts of Jinjin's osu!mania 7K Regular Dan courses
(0th–10th, Gamma, Azimuth, Zenith; [forum topic 981680](https://osu.ppy.sh/community/forums/topics/981680)).
`calibration-7k.json` holds the anchors; `calibration-7k-sources.json` records
beatmapset/beatmap ids (450069, 451788, 930218), versions, MD5 and SHA-256, and
where to get them: the sets on osu! or any mirror by set id, checked by MD5
(retrieved 2026-10-26 through osu.direct). Charts are not redistributed. With
`VOSU_JINJIN_DIR` pointing at the 14 `.osu` files, `tests/keymodes.rs`
re-derives every anchor.

The anchors increase strictly (13.78 → 41.58 MSD). Held-out error: predicting
each interior course from its two neighbours (leave-one-out) gives MAE 0.095,
RMSE 0.121 and max 0.225 dan steps; the estimate is shown as "≈ <dan>" with
**± 0.2**. That number measures how well 7K MSD orders this marathon ladder, not
the error on ordinary single songs, which is larger and unmeasured. No estimate is
given outside the course range, without a MinaCalc 7K value (e.g. past the 7K
ceiling at high rates) or when ≥ 30% of the notes are holds (the Regular courses
are rice; their hold share is under 2%). `experimental:true` is always set;
course rules (96%, no pauses) and stamina are not modelled.

## Prism (mania-tracker), Interlude patterns, LN statistics, 7K view

* **Prism 0.25** (6K–8K), vendored unmodified from mania-hub
  `9ab23951357831a0dbbc48da20dd2140f22bd850` (`vendor/prism`, MIT). `src/prism.rs`
  feeds the `.osu` text to Prism's own parser and calls `analyze_prism` /
  `analyze_prism_ln` at the playback rate with Prism's defaults (96.5% goal, map
  OD). Values are Prism's MSD-scale numbers in its own skillset names (Stamina
  omitted: Prism reports 0 there); never shown as Etterna. The rate curve uses
  Prism overall where MinaCalc has no model (8K); the `prism` timeline rates
  centred windows with `PrismPrepared::within`. `tests/reference/prism/generate.py`
  checks the vendored files against the pinned upstream, builds the pristine
  crates and writes `tests/fixtures/prism-reference.json`; `tests/prism.rs`
  requires bit-identical results.
  Windows: upstream `jsmath` declares POSIX `clock_gettime` for
  `js::thread_cpu_seconds`, a CPU-time helper in a private module that nothing
  in Prism calls; MSVC has no such function, so debug and test binaries failed
  to link (LNK2019). The vendored files stay untouched: `src/windows_clock.rs`
  (ours, Windows only) supplies `clock_gettime` for the thread CPU clock jsmath
  asks for, from `GetThreadTimes`. No rating reads it.
* **Interlude patterns** (3K–10K): `src/patterns.rs` ports Prelude's
  `Calculator/Patterns` (Density, Primitives, Patterns, FindPatterns,
  Clustering, Categorise, Summary) and `OsuConverter.convert_hit_objects` (holds
  as HOLDHEAD/HOLDBODY/HOLDTAIL rows), f32 in upstream order, with Interlude's
  finger strains (`interlude::finger_strains`) for cluster ratings. Upstream
  quirks are kept (the last pattern's end uses the absolute last-note time;
  charts with a note inside a hold are refused, as Interlude's importer does).
  SV conversion is not ported, so categories never carry "SV". BPMs are chart
  BPMs counting each row as a 1/16 note (Interlude's convention) and are shown
  × the rate. `tests/reference/patterns` runs the unmodified F# through a small
  type adapter; `tests/patterns.rs` compares categories, cluster patterns, BPM,
  mixed flags, specific-type shares, amounts, densities and ratings on the
  fixtures (3K–10K demo maps, cyclic 4K, refused mixed 7K). With
  `VOSU_PATTERNS_REFERENCE` it compares any charts; on 2026-10-26 it matched
  Interlude on 74 local charts (3K–10K, 30 of them 7K) at 1.00× and 1.50×: 72
  analysed identically, 2 refused by both for stacked holds.
* **LN statistics (ours)**, every key count, `src/ln.rs`: hold share, hold
  coverage (held time / columns × length), releases per playback second and
  the most in one second, inverse share (holds whose column is pressed again
  within 150 ms of the release), off-row release share (releases not within 2 ms
  of any head) and short-hold share (< 150 ms). Indicators: "full LN" (≥ 90%
  holds), "LN-heavy" (≥ 30%), "inverse" (inverse share ≥ 50% and coverage
  ≥ 40%), "release tech" (≥ 30% holds and ≥ 50% off-row releases). Thresholds
  are ours. The `ln` timeline counts releases per playback second.
* **7K skill view (ours)**, `src/view7k.rs`: the community 7K categories (see
  `KEYMODES.md`) from Interlude's 7K matches before clustering — jack
  (Longjacks, Minijacks, plain Jacks), chordjack (Chordjacks), speed/stream
  (Stream, Double Stream), chordstream (Dense/Light/plain Chordstream), bracket
  (Brackets), tech (any match with mixed rhythm) — as the share of the chart's
  length their spans cover (whole percent) and the BPM whose matches span the
  most time. Each category shows the MinaCalc 7K skillset that measures it
  (Jack Speed, Chordjack, Stream, Chordstream, Bracketing; one decimal); tech has
  none (MinaCalc 527 has no 7K technical model). The LN family shows LN
  statistics: general = hold share, tech = off-row releases, inverse = inverse
  share, release = peak releases per second. Nothing here is combined into a
  rating.

## Golden fixture

`tests/fixtures/cyclic.osu` is project-authored synthetic data dedicated to CC0:
1200 cyclic single notes, 100 ms spacing, starting at 1 second, lanes 0,1,2,3.
The golden **overall MSD = 6.11** at 1.0x was produced by the standalone upstream
C++ reference invocation above (not by an alternate formula). The Rust golden
checks absolute tolerance 0.0001 to accommodate compiler floating-point variation.

## Service and cache

The package provides a service, thin CLI and browser analysis UI. SQLite in
`VOSU_TOOL_DATA_DIR/ratings.sqlite3` retains submitted bytes and JSON results.
Cache identity includes body MD5, rounded rate in 0.05 ticks, exact f32 score
bits or absent score, calculator revision/adapter id, the Quaver, Interlude,
Prism and patterns revisions, and both dan model ids.
GET lookup can compute new rates from stored bytes. Missing MD5 is 404.
`/rates?step=0.05` returns rates 0.50–2.00 inclusive, 31 entries.

One blocking worker bounds native working sets; sixteen admitted requests bound
queued work, with 503 beyond that. Every worker rechecks SQLite after acquiring
the shared permit, so concurrent identical requests calculate once. Dropping an
HTTP request does not abandon a blocking computation before its cache write.
Parsing, disk reads, SQLite and native calculation are all off the async runtime.

## Additional systems and reproducible reference values

* Quaver.API 0.0.5, revision
  [`a921d561b2ece7f6bf3682446696c06c17b81649`](https://github.com/Quaver/Quaver.API/tree/a921d561b2ece7f6bf3682446696c06c17b81649),
  MPL-2.0. `src/quaver.rs` is a separate covered source file. The package ships
  `licenses/Quaver-MPL-2.0.txt`; modified calculator source is distributed in this
  repository. Default StrainConstantsKeys only; native rates divide timestamps.
  Holds retain durations. Historical odd-key second-pass accumulation, chord
  anchor timing and bin-index behavior are intentionally retained.
* Interlude/YAVSRG Prelude revision
  [`1fe55766ae1fece3d433c966bf25822647bc8af6`](https://github.com/YAVSRG/YAVSRG/tree/1fe55766ae1fece3d433c966bf25822647bc8af6),
  MIT, copyright 2024 percyqaz. `src/interlude.rs` ports NoteDifficulty,
  finger Strain, Difficulty weighted aggregation and Layout. Hand strain v2
  and variety do not feed the upstream Overall value and are not exposed.
* osu!mania reference stars and native strain peaks use `rosu-pp =4.0.1` (MIT);
  these are reference stars, not Etterna or Quaver units.

`tests/reference/{quaver,interlude}` retain unmodified upstream calculator files
and minimal native-chart adapters. Run `python tools/mania-ratings/tests/reference/generate.py`
from the workspace with .NET 8 installed to reproduce `tests/fixtures/reference.json`.
The generated fixtures include full strain arrays and overall values at 0.75,
1.00 and 1.50× on synthetic cyclic 4K and mixed chord/LN/gap 7K charts.
Rust tests compare overall within 0.0002 and strains within 0.003 (float-second
ABI round-tripping to milliseconds affects Interlude's f32 state slightly).
The former vosu `4c06922` MinaCalc golden and calibration are preserved unchanged.

## API, windows and section policy

All query times are **chart seconds**, not playback seconds. Read routes:
`GET /v1/beatmap/current?rate=`,
`GET /v1/beatmap/<md5>?rate=&systems=`,
`GET /v1/beatmap/<md5>/rates?step=0.05`,
`GET /v1/beatmap/<md5>/timeline?rate=&system=etterna&window=12&hop=1`,
`GET /v1/beatmap/<md5>/section?start=&end=&rate=`.
`POST /v1/calculate?rate=` accepts raw .osu bytes, up to 1 MiB. CLI file/stdin
imports use this route; read routes never modify osu! data. `systems` validates
comma-separated identifiers; the result retains the fixed comparison schema.
Results also carry `prism` (6K–8K), `patterns` (3K–10K), `ln` (every key count),
`view7k` and `dan7k` (7K), with `unrated.<system>` reasons where they do not
apply. Rate points carry `prism` overall; timelines accept `system=` `etterna`,
`etterna-native`, `prism`, `quaver`, `interlude`, `osu`, `ln` or `nps`.

### Local MSD (default Etterna timeline)

`system=etterna` now returns **actual local MSD**, not a conversion of native
strain. Each sample independently runs the unchanged MinaCalc `CalcMain` at
0.93 goal on the heads in a **centered 12 s chart-time window**, sampled every
**1 s of chart time** by default. All eight returned skillsets are included:
overall, stream, jumpstream, handstream, stamina, jackspeed, chordjack, technical.
The `value` field is local overall MSD; `skills` follows `skill_names`.
The response also carries whole-map `overall` and `overall_skills`.

Context is reset for each window; rows in `[start,end)` are rebased by subtracting
the window start before calculation. Windows are clipped at the chart's edges;
their actual bounds accompany each sample. This prevents song-position silence
from changing local difficulty and avoids inheriting earlier phrase strain.
There is no post-smoothing or averaging, and short windows do not model the
stamina demands of a complete chart/course. Local windows are not the same
context policy as the explicit multi-system `/section` endpoint below.

Results are persistently cached in SQLite `timelines`, keyed by chart MD5,
calculator/model revisions, rate tick, system, exact window/hop bits and
window-context version. Cache lookup, parsing, all window calculations and cache
writes run through the same **single blocking worker**, with at most 16 admitted
requests. A queued identical request rechecks the cache after acquiring the
worker, so it does not recompute the same timeline. No native arithmetic changes.

The analysis page and compact overlay default to local MSD with a dotted
whole-map MSD reference and a 0–40 scale (expanded in tens if needed).
Discrete bands are `<10`, `10–20`, `20–30`, `30–40`, `40+`: one theme accent at
rising strength with 40+ in the text colour, in both the tool and the overlay;
no rainbow gradient is used.

### Native strain option

`system=etterna-native` retains contextual native interval features, **not local
MSD**. MinaCalc's C ABI copies existing `base_adj_diff[hand][skill][interval]`
arrays after `CalcMain`; it reports the maximum across hands at native 500 ms
**playback** intervals. Overall/stamina slots here are not local ratings.
Quaver exposes native action strain; Interlude exposes peak finger strain by row;
osu!mania exposes rosu-pp's native 400 ms playback strain peaks. These modes take
the maximum of overlapping native samples/intervals, defaulting to a 1 s
chart-time window and 0.25 s hop (0.5 s in the compact overlay), no smoothing.
NPS is head count in the selected half-open window divided by playback duration;
the local-MSD NPS series uses the centered window and actual clipped bounds.

### Measured cost

On Rice Fusion (7,849 heads, 423 samples), using the debug tool build through an
isolated real vosu dev daemon: **398.71 ms cold HTTP response**, **8.15 ms cached**,
12 s centered windows / 1 s hop / rate 1.00. These include HTTP transfer and JSON
parsing, not just calculator CPU time. A fresh temporary data directory ensured
the first request had no cached timeline. `tests/smoke.py` reproduces this and
writes `/tmp/vosu-tools-evidence/mania-ratings/timings.json`. Hardware-load variation
and release optimization will affect timings; these are observations, not SLAs.

Sections recompute all systems on heads inside `[start,end)`, retain associated
holds in full, reset prior strain context, and preserve original chart timestamps.
This last policy preserves initial-note timing in Interlude and ensures a
whole-map section has identical numerical ratings to the complete map.
Reset-context section results need not equal plotted contextual strain peaks.

The UI uses the shared 18-LAB system (`/tools/_host/v1/theme.css`) and is one
screen with no page scroll at 1920 × 1080, 2560 × 1440, 1280 × 720 and 960 × 1080
(below ~830 px it stacks). Readouts show only the systems that rate the chart's
key count; the others are listed in one "Not for NK" cell with their reasons on
hover. The breakdown panel switches between the sources that apply (Etterna,
Prism, 7K (ours), Interlude patterns, LN (ours)); its default is the 7K view on
7K, Prism on 8K, Interlude patterns on 3K/9K/10K, Etterna on 4K–6K and LN
statistics elsewhere. Labels only, with help hovers on ambiguous labels. Through `vosu.subscribe` (the bridge owns reconnects;
its status shows as the bar's status dot) it subscribes to
`/websocket/v2/subscribe` (`/beatmap/checksum`, `/play/mods/rate`,
`/play/mods/name`, `/state/number`, `/beatmap/time/live`, `/beatmap/mode/name`)
and re-analyses the selected chart at the game's rate, rounded to 0.05×; during
play it marks the live position. Manual mode (a typed rate or an opened .osu)
re-rates the chart on screen by checksum and ignores the game until Follow game.
Non-mania selections keep the last mania analysis dimmed and state why.
Defaults come from `settings.json` (follow, readouts shown incl. Prism and the
7K dan, timeline system,
window/hop, rate-curve step), read through the bridge or `/tools/<id>/_settings`.
It draws Canvas timelines/NPS and an SVG rate curve without chart libraries.
Drag a range or enter explicit times to request section ratings. Reform estimates
are always experimental. No additional dan model is claimed: Companella's rice
model needs its trained ONNX and multiple other calculators; its LN calibration
requires its own LN model, not MSD or Interlude substituted as input.
