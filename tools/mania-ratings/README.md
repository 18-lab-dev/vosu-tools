# Mania ratings

A live osu!mania difficulty dashboard for a second monitor: Etterna (MinaCalc MSD), Quaver, Interlude and osu!mania star ratings for the selected map at the game's rate, with a rate curve, timelines, per-section ratings and an experimental Reform dan estimate.

Interfaces: **service + CLI + UI**. The background service computes and caches ratings; it starts on demand unless you enable **Start with vosu**.

![Mania ratings](../../docs/screenshots/mania-ratings.webp)

## What it shows

- **Ratings per map**: MinaCalc 527 overall MSD with its seven skillsets (Stream, Jumpstream, Handstream, Stamina, Jack Speed, Chordjack, Technical), Quaver, Interlude and osu!mania stars. MinaCalc covers 4K, 6K and 7K.
- **Rate curve**: MinaCalc MSD from 0.50× to 2.00× in the configured step, with the neighbouring rates of the current one.
- **Timeline**: local MSD from centred windows (Etterna) or each system's native strain, plus note density.
- **Sections**: ratings for a chosen start and end time.
- **Reform dan estimate** (experimental): an interpolation of overall MSD against the Reform v1 course charts. It describes similarity to those courses, not a course clear; 6K and 7K maps have none.

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
