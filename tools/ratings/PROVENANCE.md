# Ratings provenance and semantics

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

`rosu-map =0.2.1` parses native mania. Only 4K, 6K and 7K are exposed, even though
this upstream revision also contains 5K logic. Keys must be integral CS.
Column is `floor(x * keys / 512)` with x=512 clamped to the last column, matching
osu's right-edge behavior. Equal float-second timestamps are merged with OR;
input timestamps remain unscaled and playback rate is passed separately.

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
`vosux ratings <chart.osu> --rate 1 --json`
in ascending dan order. The CLI uses the exact production parser and native
calculator and prints computed values without changing model files. Calibration
was independently computed with a standalone C++20 reference driver calling
upstream `Calc::CalcMain(notes, 1.F, 0.93F)`, `keycount=4`, `ssr=false`, head-only
rows grouped by float seconds; production computations reproduce these anchors.

Between anchor MSDs A[n] and A[n+1], value = n + (MSD-A[n])/(A[n+1]-A[n]).
The label is `Reform floor(value)`. No extrapolation: below dan 1, above dan 10,
non-finite values, and 6K/7K return `dan:null`. Estimation uses rate-specific MSD,
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
bits or absent score, calculator revision/adapter id, and dan model id.
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
and minimal native-chart adapters. Run `python tools/ratings/tests/reference/generate.py`
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
Discrete warm bands are `<10`, `10–20`, `20–30`, `30–40`, `40+` (a single-hue
pen ramp on the analysis page, light and dark variants); no rainbow gradient is
used.

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
writes `/tmp/vosu-tools-evidence/ratings/timings.json`. Hardware-load variation
and release optimization will affect timings; these are observations, not SLAs.

Sections recompute all systems on heads inside `[start,end)`, retain associated
holds in full, reset prior strain context, and preserve original chart timestamps.
This last policy preserves initial-note timing in Interlude and ensures a
whole-map section has identical numerical ratings to the complete map.
Reset-context section results need not equal plotted contextual strain peaks.

The UI draws Canvas timelines/NPS and an SVG rate curve without chart libraries.
Drag a range or enter explicit times to request section ratings. Reform estimates
are always experimental. No additional dan model is claimed: Companella's rice
model needs its trained ONNX and multiple other calculators; its LN calibration
requires its own LN model, not MSD or Interlude substituted as input.
