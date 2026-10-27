# Map analysis across key counts

Research for rating osu!mania key counts other than 4K: what each calculator in
this tool supports, what the community uses for 5K–10K, and what the tool can
show. Retrieved 2026-10-26. Source links are pinned revisions; community pages
are linked as they were on that date.

Short version: only **osu!mania stars** rate every key count. **MinaCalc** has
dedicated models for 4K–7K, **Quaver** rates 1K–10K, **Interlude** 3K–10K, and
the **Reform** dan estimate is 4K only. None of them reports named skillsets
outside 4K except MinaCalc on 5K–7K, whose middle two skillsets are
*chordstream* and *bracketing* there. Community 7K skill vocabularies exist and
agree with each other (jack, tech, speed, stream/chordstream, plus a separate LN
family), but they come from dan courses and community trackers, not from a
calculator this tool ships.

## Per calculator

| Key count | MinaCalc 527 | Quaver.API | Interlude | osu!mania (rosu-pp) | Reform dan |
| --- | --- | --- | --- | --- | --- |
| 1K–2K | refused (generic model) | yes | refused (layout) | yes | refused |
| 3K | refused (generic model) | yes | yes | yes | refused |
| 4K | **dedicated**, 7 skillsets | yes | yes | yes | **yes** |
| 5K | **dedicated** (pump/5K) | yes (odd) | yes | yes | refused |
| 6K | **dedicated**, no Technical | yes | yes | yes | refused |
| 7K | **dedicated**, no Technical | yes (odd) | yes | yes | refused |
| 8K–9K | refused (generic model) | yes | yes | yes | refused |
| 10K | refused (generic model) | yes (two thumbs) | yes | yes | refused |
| 12K–18K dual stage | refused | refused | refused | yes | refused |

"Refused" means the tool reports `unrated.<system> = {scope:"keys", reason}`
with the calculator's own limit; it never runs a calculator on another key
count's model. 1K–10K is checked against the `@vosu-tools/demo-maps` fixtures in
`tests/fixtures/demo/` by `tests/calculator.rs`.

### Etterna MinaCalc 527

Pinned to Etterna
[`2d706147`](https://github.com/etternagame/etterna/tree/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/MinaCalc)
(vendored unmodified in `crates/minacalc/vendor`, so line numbers match).

- **Key counts.** `Calc::InitializeKeycountLogic`
  ([MinaCalc.cpp:495–535](https://github.com/etternagame/etterna/blob/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/MinaCalc/MinaCalc.cpp#L495-L535))
  picks one model per key count: 4K `TheGreatBazoinkazoinkInTheSky` (`Ulbu.h`),
  5K `TheFiveEaredBazoinkazoink` (`UlbuFiveKey.h`), 6K
  `TheSixEyedBazoinkazoink`, 7K `TheSevenFootedBazoinkazoink`. Every other count
  silently falls back to the base `Bazoinkazoink` (`UlbuBase.h`), an untuned
  generic model. (The 5K `case` has no `break`; it falls into the 6K case, whose
  `emplace` is then a no-op, so 5K still gets its own model.) Etterna itself runs
  MinaCalc for every steps type with the type's track count
  ([Steps.cpp:424–437](https://github.com/etternagame/etterna/blob/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/Models/StepsAndStyles/Steps.cpp#L424-L437));
  the 0.75.0 changelog lists "MinaCalc pump/5k support enhanced"
  ([Release_0-75-0.md](https://github.com/etternagame/etterna/blob/master/.changelog/Release_0-75-0.md)).
  This tool rates 4K–7K and refuses the generic fallback.
- **Skillsets per key count.** MinaCalc always returns the same eight slots
  (`enum Skillset`: Overall, Stream, Jumpstream, Handstream, Stamina, JackSpeed,
  Chordjack, Technical). Outside 4K the models fill the Jumpstream and
  Handstream slots with generic pattern mods (`GChordStream`, `GBracketing`), and
  upstream names those slots accordingly:
  `enum GenericSkillset { Skill_Chordstream = Skill_Jumpstream, Skill_Bracketing = Skill_Handstream }`,
  "since JS and HS dont really 'work' for things like 7k"
  ([NoteDataStructures.h:26–32](https://github.com/etternagame/etterna/blob/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/Models/NoteData/NoteDataStructures.h#L26-L32)).
  Only the 4K and 5K models compute a technical base (`TechBase`, `Ulbu.h:580`,
  `UlbuFiveKey.h:246`); on 6K and 7K the Technical slot is a constant floor, not a
  rating.
- **Scale.** Non-4K skillsets (except JackSpeed and Technical) are multiplied by
  4/keys "to values familiar to the 4k calc"
  ([MinaCalc.cpp:179–188](https://github.com/etternagame/etterna/blob/2d706147cc4bcf95a8ceb24dc4f4129be207f803/src/Etterna/MinaCalc/MinaCalc.cpp#L179-L188)).
  `Calc::Chisel` searches player skill up to `max_rating = 100`
  (`MinaCalcHelpers.h:7`) and returns 0 past it, so a pattern skillset tops out
  at 80 (5K), 66.67 (6K) and 57.14 (7K) MSD. Past that the skillset is 0 and
  Stamina is NaN.

**The screenshot (7K, Ultimate Force [Neutron Star [1.1x Rate]]).** The overall
31.01 and the per-skillset values are legitimate MinaCalc 7K output. Three things
on our side were wrong, all fixed:

1. The Jumpstream and Handstream labels were MinaCalc's 4K names; on 7K those
   slots are its chordstream and bracketing models. They are now labelled that
   way in the UI, CLI and timeline `skill_names` (the JSON keys are unchanged).
2. Technical was shown on 6K/7K although it is the unmodelled floor; it is now
   `null` and hidden.
3. **"MinaCalc failed (2)"** was the removed rate curve. It rates 0.50–2.00×; on a hard
   7K chart the higher rates cross the 57.14 ceiling, MinaCalc returns 0 and
   NaN, our C shim reported status 2 (non-finite output), and the whole curve
   request failed: hence the toast *and* the empty curve panel. Reproduced on
   local 7K maps (e.g. *Kokushi musou [Tenhou]* fails from 2.00×; Stamina `-nan`
   in a standalone upstream driver). Of 178 local 7K maps, 62 cross the ceiling
   somewhere in 0.50–2.00× (one already at 1.00×); none of 22 local 6K maps does.
   Each rate past the range is now a gap with the reason "Beyond MinaCalc 527's
   7K range …", and the curve and local-MSD timeline keep the other points.

### Quaver.API

Pinned to
[`a921d561`](https://github.com/Quaver/Quaver.API/tree/a921d561b2ece7f6bf3682446696c06c17b81649);
ported in `src/quaver.rs`, unmodified reference in `tests/reference/quaver`.

- **Key counts.** `GameMode` has `Keys4`, `Keys7` (the original modes) and
  `Keys1`–`Keys10`
  ([GameMode.cs](https://github.com/Quaver/Quaver.API/blob/a921d561b2ece7f6bf3682446696c06c17b81649/Quaver.API/Enums/GameMode.cs)).
  `LaneToFinger` maps lanes for up to 9 keys by a general rule, gives 10K two
  thumbs, and throws `"Key count must be between 1 and 10"` otherwise
  (`DifficultyProcessorKeys.cs:78–114`). Odd key counts make the middle lane
  `Hand.Ambiguous`; the overall rating is computed once assuming left and once
  assuming right and averaged (`:166–170`). Scratch-lane notes (Quaver's 7K+1)
  are excluded; osu! has no scratch lane.
- **Output.** One `OverallDifficulty`. Internally strain is categorised per
  finger action (`FingerAction`: SimpleJack, TechnicalJack, Roll, Bracket) and
  two manipulation flags (`QssPatternFlags`: SimpleVibro, Rolls), but no
  skillset ratings are reported, and the strain constants are not per key count.
  The tool shows Quaver for 1K–10K and refuses above.

### Interlude (YAVSRG Prelude)

Pinned to
[`1fe55766`](https://github.com/YAVSRG/YAVSRG/tree/1fe55766ae1fece3d433c966bf25822647bc8af6);
`prelude/` is MIT. Ported in `src/interlude.rs`.

- **Key counts.** `Layout.keys_on_left_hand` covers 3K–10K and fails with
  `Invalid keymode` otherwise
  ([Layout.fs](https://github.com/YAVSRG/YAVSRG/blob/1fe55766ae1fece3d433c966bf25822647bc8af6/prelude/src/Calculator/Layout.fs)).
- **Output.** One difficulty number per chart. Pattern analysis is a separate
  module, `prelude/src/Calculator/Patterns`, which this tool does not port yet.
  It has three core patterns (Stream, Chordstream, Jacks) and per-key-count
  pattern sets chosen by `chart.Keys` (`FindPatterns.fs:101–110`,
  [Patterns.fs:280–349](https://github.com/YAVSRG/YAVSRG/blob/1fe55766ae1fece3d433c966bf25822647bc8af6/prelude/src/Calculator/Patterns/Patterns.fs#L280-L349)):
  - **4K:** Rolls, Trills, Minitrills; Handstream, Split Trill, Jumptrill,
    Jumpstream; Longjacks, Quadstream, Gluts, Chordjacks, Minijacks.
  - **7K:** Brackets, Double Stream, Dense Chordstream, Light Chordstream;
    Longjacks, Chordjacks, Minijacks (stream subtypes "todo").
  - **Other (3K, 5K, 6K, 8K–10K):** Chord Rolls, Double Stream, Dense/Light
    Chordstream; Longjacks, Chordjacks, Minijacks.

### osu!mania stars (rosu-pp 4.0.1)

One strain skill with an individual strain per column (`Strain::new(total_columns)`
in `rosu-pp` `mania/difficulty/skills/strain.rs`), so stars work for any column
count, including dual stage. osu!(lazer) splits native charts with more than
`MAX_STAGE_KEYS = 10` columns into two stages
([ManiaBeatmapConverter.cs:65–72](https://github.com/ppy/osu/blob/4e11ab19feb423c905cf98d9b8fa34700a8aeffa/osu.Game.Rulesets.Mania/Beatmaps/ManiaBeatmapConverter.cs#L65-L72)).
No skillsets. The tool plays any `CircleSize` with lazer's key count (clamped to 1–18, rounded half to even; see `PROVENANCE.md`).

### Reform dan estimate

Our interpolation of MinaCalc 4K overall MSD against the Reform v1 4K course
charts (`PROVENANCE.md`). 4K only; every other key count reports "Reform dan
courses are 4K only".

## Community skillsets for 5K–10K

| Source | Key counts | Categories | How established |
| --- | --- | --- | --- |
| Jinjin's 7K dan courses, [forum 981680](https://osu.ppy.sh/community/forums/topics/981680) (2019) | 7K | **Regular** (96%): jack, tech, speed, consistency/endurance (chordstream, stamina). **LN** (95%): general, tech, inverse, release. 0th–Zenith, plus Stellium | The long-standing osu!mania 7K skill ladder; the category split below is copied from it |
| Ez2Lazer skills system, [wiki](https://github-wiki-see.page/m/SK-la/Ez2Lazer/wiki/Mania-Skills-System-English) (MIT client, `bdacb888`) | 4K, 6K–8K, 7K LN | 4K RC: jack/tech/speed/stamina. **6/7/8K RC: jack/tech/speed/stream.** **7K LN: lngeneral/lntech/lninverse/lnrelease.** 4K/6K LN: headline only | Community lazer fork; says it aligns with mania-hub |
| [mania-hub](https://github.com/aleju03/mania-hub/tree/9ab23951357831a0dbbc48da20dd2140f22bd850) / mania-tracker.com (MIT) | 4K, 6K–8K | MinaCalc on 4K; **Prism 0.25**, its own Rust MSD calculator for 6K–8K, "the keymodes MinaCalc was never built for", fitted to osu! plays, on the MSD scale in MinaCalc's slots (Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical, plus Speed) | Active community tracker (score ingestion, dan ladders); young (2026) |
| [osumania_map_analyser](https://github.com/LeoBlackMT/osumania_map_analyser/tree/bc5e8c6f7801f58efaec22cb492a7aa9dd7e5945) (MIT) | 4K, 6K, 7K | RC/LN pattern analysis based on Interlude's; dan estimators for 4/6/7K RC and LN; "Polaris" for 7K RC and LN | Popular tosu overlay (151 stars); README says it is entirely AI-written and that 6K/7K estimates are "relatively average" |
| Sunny "Star-Rating-Rebirth" ([`b6c1d891`](https://github.com/sunnyxxy/Star-Rating-Rebirth/tree/b6c1d8915fc06060804389a1120424d493a4f06e)) | 1K–10K (per-K cross matrix) | One star rating with LN handling | Widely used as a baseline (by the two tools above); **no licence**, so it cannot be vendored |
| beatmania IIDX Notes Radar, [Konami](https://p.eagate.573.jp/game/2dx/27/howto/new/notes.html) | 7K + scratch | NOTES, CHORD, PEAK, CHARGE, SCRATCH, SOF-LAN | Official, since 6th style (2001); scratch has no osu! equivalent |
| Interlude patterns (above) | 3K–10K | 7K: brackets, double stream, dense/light chordstream, long/chord/minijacks | Shipped in a released game; MIT |

What these agree on for 7K (and roughly 6K–8K): **jack** (long/minijacks),
**chordjack**, **speed/stream** (incl. jumptrill/double stream), **chordstream**
(dense/light), **bracket**, **tech**, and a separate **LN** family (general, tech,
inverse, release). "Handstream" and "jumpstream" are 4K words; 7K talks about
chordstream and brackets, which is exactly how MinaCalc names its slots there.
Nothing established covers 9K–10K or dual stage beyond star ratings.

## Proposal

**With real calculators (no new models):**

| Key count | Values | Skillsets  |
| --- | --- | --- |
| 4K | MinaCalc, Quaver, Interlude, stars, Reform dan | MinaCalc's 7  |
| 5K | MinaCalc, Quaver, Interlude, stars | MinaCalc's 7 (chordstream/bracketing names)  |
| 6K–7K | MinaCalc, Quaver, Interlude, stars | MinaCalc's 6 (no Technical)  |
| 8K–10K | Quaver, Interlude, stars | none  |
| 1K–2K | Quaver, stars | none  |
| 3K | Quaver, Interlude, stars | none  |
| 12K–18K | stars | none  |

This was Phase 1 (commits `d34843a`, `2e4da06`, `4666f06`).

## Phase 2 (implemented)

All five options were chosen. What each key count now shows (✓ = value, with
its source named in the UI):

| Key count | Etterna | Prism | Quaver | Interlude | stars | Interlude patterns | 7K view (ours) | Dan | LN stats (ours)  |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---  |
| 1K–2K | | | ✓ | | ✓ | | | | ✓  |
| 3K | | | ✓ | ✓ | ✓ | ✓ | | | ✓  |
| 4K | ✓ | | ✓ | ✓ | ✓ | ✓ | | Reform | ✓  |
| 5K | ✓ | | ✓ | ✓ | ✓ | ✓ | | | ✓  |
| 6K | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓  |
| 7K | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≈ 7K dan (ours) | ✓  |
| 8K | | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓  |
| 9K–10K | | | ✓ | ✓ | ✓ | ✓ | | | ✓  |
| 11K–18K | | | | | ✓ | | | | ✓  |

1. **Interlude patterns** (`src/patterns.rs`): Prelude's pattern module ported
   to Rust, differentially tested against the unmodified F# on the 3K–10K demo
   maps and 74 local charts.
2. **Prism (mania-tracker)** (`vendor/prism`, `src/prism.rs`): vendored
   unmodified, bit-identical to a pristine upstream build on the fixtures and 40
   local 6K–8K charts. Also available as a timeline system.
3. **7K skill view, pattern analysis (ours)** (`src/view7k.rs`). Method:
   Interlude's 7K pattern matches, before clustering, are sorted into the
   community categories, and each category shows (a) the share of the chart's
   length its matches cover and (b) the MinaCalc 527 7K skillset that measures
   it. Where each category comes from:

   | Category | Community source | Interlude 7K matches | MinaCalc 7K value |
   | --- | --- | --- | --- |
   | Jack | Jinjin Regular map 1 (jack), Ez2Lazer/mania-tracker "jack" | Longjacks, Minijacks, plain Jacks | Jack Speed |
   | Chordjack | Jinjin map 1 (chordjacks), mania-tracker Chordjack | Chordjacks | Chordjack |
   | Speed / stream | Jinjin map 3 (speed), Ez2Lazer "speed", "stream" (6/7/8K) | Stream, Double Stream | Stream |
   | Chordstream | Jinjin map 4 (chordstream endurance), Interlude 7K | Dense/Light/plain Chordstream | Chordstream (Jumpstream slot) |
   | Bracket | Interlude 7K "Brackets", MinaCalc `GBracketing` | Brackets | Bracketing (Handstream slot) |
   | Tech | Jinjin map 2 (tech), Ez2Lazer "tech", Interlude "Tech" (mixed rhythm) | any match with mixed rhythm | none: MinaCalc 527 has no 7K technical model |
   | LN general / tech / inverse / release | Jinjin 7K LN dans, Ez2Lazer 7K LN tiles | — | none: LN statistics (ours) |

   Honest scale: coverage is a whole percent of chart length; BPM is the steady
   rhythm covering most of the category (rows counted as 1/16 notes, Interlude's
   convention); MinaCalc values have one decimal; LN values are percentages or
   releases per second. Nothing is combined into a score.
4. **≈ 7K dan (ours)**: MinaCalc 7K MSD interpolated between Jinjin's 14
   Regular course charts; held-out error ± 0.2 dan steps; nothing outside the
   range or on LN-heavy charts (`PROVENANCE.md`, `calibration-7k-sources.json`).
5. **LN statistics (ours)** (`src/ln.rs`) for every key count, with indicator
   thresholds documented in `PROVENANCE.md`.

Still not done, deliberately: MinaCalc's generic model for 8K+, scaling 4K
skillsets to other key counts, vendoring Sunny (no licence), and SV detection in
Interlude patterns.
