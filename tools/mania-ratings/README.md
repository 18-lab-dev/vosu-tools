# Mania ratings

A live osu!mania difficulty dashboard for a second monitor: Etterna (MinaCalc MSD), Quaver, Interlude and osu!mania star ratings for the selected map at the game's rate, with a rate curve, timelines, per-section ratings and an experimental Reform dan estimate.

Interfaces: **service + CLI + UI**. The background service computes and caches ratings; it starts on demand unless you enable **Start with vosu**.

![Mania ratings](../../docs/screenshots/mania-ratings.webp)

## What it shows

- **Ratings per map**: MinaCalc 527 overall MSD with its seven skillsets (Stream, Jumpstream, Handstream, Stamina, Jack Speed, Chordjack, Technical; on 5K–7K the second and third are MinaCalc's Chordstream and Bracketing), Quaver, Interlude and osu!mania stars. MinaCalc covers 4K–7K, Quaver 1K–10K, Interlude 3K–10K, osu!mania every key count; a calculator that cannot rate a key count says so instead of showing a value. See [KEYMODES.md](KEYMODES.md).
- **Rate curve**: MinaCalc MSD from 0.50× to 2.00× in the configured step (or, for key counts MinaCalc does not rate, the first calculator that does), with the neighbouring rates of the current one. Rates past a calculator's range are gaps with its reason.
- **Timeline**: local MSD from centred windows (Etterna) or each system's native strain, plus note density.
- **Sections**: ratings for a chosen start and end time.
- **Prism (mania-tracker)** for 6K–8K: mania-tracker's MSD-scale calculator with its skillsets and LN rating, vendored unmodified; never shown as Etterna.
- **Interlude patterns** for 3K–10K: Interlude's own pattern analysis (category, BPM clusters, shares), ported and checked against Interlude's code.
- **7K skills, pattern analysis (ours)**: jack, chordjack, speed/stream, chordstream, bracket and tech coverage from Interlude's 7K patterns beside MinaCalc's 7K skillsets, plus the LN family.
- **≈ 7K dan (ours)** (experimental): MinaCalc 7K MSD interpolated between Jinjin's 7K Regular dan courses, shown with its held-out error (± 0.2).
- **LN statistics (ours)** for every key count: hold share, coverage, release density, inverse and off-row release shares.
- **Reform dan estimate** (experimental): an interpolation of overall MSD against the Reform v1 course charts. It describes similarity to those courses, not a course clear; only 4K maps have one.

The page follows the beatmap selected in osu! at the game's actual rate (DT/HT/NC and lazer rate mods included). Turn **Follow game** off to set the rate yourself, or open an `.osu` file. Long notes count by their heads only, so MSD measures a chart's head patterns, not LN release or holding strain.

[Provenance and semantics](PROVENANCE.md) records the calculator revisions, input rules, the Reform model, the cache and the API.

## CLI

```sh
vosux mania-ratings                                 # the selected map
vosux mania-ratings chart.osu --rate 1.1 --json
vosux mania-ratings chart.osu --rates               # rate curve
vosux mania-ratings chart.osu --timeline
vosux mania-ratings chart.osu --section 1:30-2:15
```

## Settings

Edited on the vosu dashboard (Tools → Mania ratings → Settings): whether the page follows the game, which readouts it shows, the default timeline system and its window and hop sizes, and the rate curve step.
