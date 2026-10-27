# Map analysis

A selected-map dashboard for all four osu! rulesets. Official difficulty attributes
come from the existing rosu-pp 4.0.1 dependency, with explicit mods and clock rate.
Its algorithms match osu!lazer 2025-10-13; current lazer may differ (also stated on the stars help hover).
MinaCalc, Quaver, Interlude, Prism, Reform, 7K and LN views remain available for mania.
The former rate curve and `/rates` API route have been removed.

## Other rulesets

Standard shows aim, speed, flashlight and slider factor. Taiko shows colour,
rhythm, stamina and reading. Catch exposes its actual official attributes:
fruit/droplet counts and approach preempt, not invented aim skills.
PP at 95/98/99/100% uses the optional Server pp calculator's `/v1/targets` API.
Without that tool the dashboard gives one reason and all analysis remains usable.

Pattern/section timelines are **ours**, not official difficulty. They count events
per second in centred windows (default 12 seconds, 1 second hop), clipped at map
edges. Standard: fast runs at gaps ≤200 ms (8+ notes = stream, shorter = burst),
jumps ≥100 playfield pixels, and slider heads. Taiko: rim/centre changes,
interval-ratio changes exceeding 2^0.25, and consecutive hits ≤200 ms apart.
Catch uses ruleset-convert's played fruit/droplet objects, hyperdash flags and
horizontal direction reversals. Modded geometry and playback rate apply.
The section summary reports peak event density, not a skill rating.

Converts use packages/ruleset-convert for descriptive timelines; official
attributes use rosu-pp's ruleset conversion. Active mode follows play mode during
play, otherwise settings mode, falling back to the native beatmap mode.

### Community calculator hook

Future community providers belong beside `src/official.rs`, with an explicit
provider ID, pinned revision, licence, supported rulesets and separate labelled
results; never replace official attributes. None are integrated: osu_skills_rs
is GPL-3.0 and needs a licensing decision; no verified taiko/catch candidate was
found.

### Upgrading

Catalog replacement metadata migrates mania-ratings automatically on a compatible
vosu. On vosu 1.2.0/1.2.1 install Map analysis manually as a new tool; mania-ratings
continues working but receives no further updates. Upgrade vosu for data migration.

Interfaces: **service + CLI + UI**. The background service computes and caches ratings; it starts on demand unless you enable **Start with vosu**.

![Map analysis](../../docs/screenshots/map-analysis.webp)

## What it shows

- **Ratings per map**: MinaCalc 527 overall MSD with its seven skillsets (Stream, Jumpstream, Handstream, Stamina, Jack Speed, Chordjack, Technical; on 5K–7K the second and third are MinaCalc's Chordstream and Bracketing), Quaver, Interlude and osu!mania stars. MinaCalc covers 4K–7K, Quaver 1K–10K, Interlude 3K–10K, osu!mania every key count; a calculator that cannot rate a key count says so instead of showing a value. See [KEYMODES.md](KEYMODES.md).
- **Timeline**: local MSD from centred windows (Etterna) or each system's native strain, plus note density.
- **Sections**: ratings for a chosen start and end time.
- **Prism (mania-tracker)** for 6K–8K: mania-tracker's MSD-scale calculator with its skillsets and LN rating, vendored unmodified; never shown as Etterna.
- **Interlude patterns** for 3K–10K: Interlude's own pattern analysis (category, BPM clusters, shares), ported and checked against Interlude's code.
- **7K skills, pattern analysis (ours)**: jack, chordjack, speed/stream, chordstream, bracket and tech coverage from Interlude's 7K patterns beside MinaCalc's 7K skillsets, plus the LN family.
- **≈ 7K dan (ours)** (experimental): MinaCalc 7K MSD interpolated between Jinjin's 7K Regular dan courses, shown with its held-out error (± 0.2).
- **LN statistics (ours)** for every key count: hold share, coverage, release density, inverse and off-row release shares.
- **Reform dan estimate** (experimental): an interpolation of overall MSD against the Reform v1 course charts. It describes similarity to those courses, not a course clear; only 4K maps have one.

The page follows the beatmap selected in osu! at the game's actual rate (DT/HT/NC and lazer rate mods included). Turn **Follow game** off to set the rate yourself, or open an `.osu` file. Long notes count by their heads only, so MSD measures a chart's head patterns, not LN release or holding strain. Slider and spinner objects in a mania chart count the way osu! plays them: a slider is a hold over its length, a spinner a hold (or a note) in the column the game picks.

[Provenance and semantics](PROVENANCE.md) records the calculator revisions, input rules, the Reform model, the cache and the API.

## CLI

```sh
vosux map-analysis                                 # the selected map
vosux map-analysis chart.osu --rate 1.1 --json
vosux map-analysis chart.osu --timeline
vosux map-analysis chart.osu --section 1:30-2:15
```

## Settings

Edited on the vosu dashboard (Tools → Map analysis → Settings): whether the page follows the game, which readouts it shows, the default timeline system and its window and hop sizes.
