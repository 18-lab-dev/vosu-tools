# @vosu-tools/demo-maps

Short, original looping beatmaps for skin previews: one per ruleset (`osu`, `taiko`, `fruits`) and mania in 4K and 7K (`mania-4k`, `mania-7k`). MIT OR Apache-2.0.

```ts
import { demoLoop } from "@vosu-tools/demo-maps";

const loop = demoLoop("osu");
renderer.setBeatmap(loop.beatmap, options);
// Any time in [loop.start, loop.start + loop.length) shows one period;
// the edges match, so wrapping elapsed time loops seamlessly.
renderer.renderAt(loop.start + (elapsed % loop.length));
```

Each `maps/*.osu` holds one period. `demoLoop` repeats it three times and returns the middle copy's window, so objects approaching from the previous period and fading into the next are drawn at both ends. Combo numbers and colours are periodic too. The catch map includes a juice stream, a hyper-dash and a banana shower; the osu! map circles, sliders and a spinner; taiko dons, kats, finishers, a drumroll and a swell; mania notes and holds in every column. The maps are imported as text (`?raw`), supported by Vite and Bun.
