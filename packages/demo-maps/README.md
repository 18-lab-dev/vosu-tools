# @vosu-tools/demo-maps

Short, original looping beatmaps for skin previews: one per ruleset (`osu`, `taiko`, `fruits`) and mania in every key count from 1K to 10K (`mania-1k` … `mania-10k`; `maniaDemo(keys)` returns the id, or `undefined` for other counts such as dual-stage layouts). MIT OR Apache-2.0.

```ts
import { demoLoop } from "@vosu-tools/demo-maps";

const loop = demoLoop("osu");
renderer.setBeatmap(loop.beatmap, options);
// Any time in [loop.start, loop.start + loop.length) shows one period;
// the edges match, so wrapping elapsed time loops seamlessly.
renderer.renderAt(loop.start + (elapsed % loop.length));
```

Each demo's `.osu` text holds one period: `maps/*.osu` for osu!, taiko and catch; mania charts are generated deterministically (`src/mania.ts`, `maniaOsu(keys)`) from one 8 s phrase laid out over the columns. `demoLoop` repeats it three times and returns the middle copy's window, so objects approaching from the previous period and fading into the next are drawn at both ends. Combo numbers and colours are periodic too. The catch map includes a juice stream, a hyper-dash and a banana shower; the osu! map circles, sliders and a spinner; taiko dons, kats, finishers, a drumroll and a swell; mania a staircase, a long-note chord, mirrored jumps, a 3 s hold beside a short one and a stream, with every column used and no column overlapping itself. The osu!, taiko and catch maps are imported as text (`?raw`), supported by Vite and Bun.
