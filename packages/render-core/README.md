# render-core

Deterministic WebGPU beatmap rendering, MIT OR Apache-2.0. Import from `@vosu-tools/render-core`; parse maps with `@vosu-tools/osu-parse`.

```ts
const map = parseOsu(osuText);
const renderer = await createRenderer({ canvas, width: 1920, height: 1080 });
renderer.setBeatmap(map, { mods: [{ acronym: 'HR' }], scrollSpeed: 20, noteSpeed: 1 });
renderer.renderAt(12345, {
  cursor: { x: 256, y: 192, pressed: false },
  keys: [false, true, false, false],
  judgements: [{ x: 256, y: 192, time: 12200, result: 300 }],
});
renderer.destroy();
```

`renderAt` takes **absolute beatmap milliseconds**, before rate scaling. Audio/replay clocks belong to callers. Calls can arrive in any order, including backwards seeks; no accumulated animation state or random frame state exists. `applyMods` returns a copy; DT/HT rate metadata never rescales hit times. The caller scales its playback clock.

`createRenderer({ device, format: 'rgba8unorm', width, height })` borrows a GPU device and does not destroy it. Without `device`, vgpu creates and owns one. Without a canvas, every `renderAt` call must supply `frame.target: GPUTextureView`; the caller owns target lifetime and readback. Canvas targets and offscreen targets use the same pipeline. `resize(width,height)` sets output pixel size. Map coordinates are 512×384, centered inside a 640×480 virtual viewport, aspect-preserving.

`setBeatmap(map, { mods?, ar?, cs?, scrollSpeed?, noteSpeed? })` compiles immutable GPU instance data. `scrollSpeed` is mania's display scroll setting (20 default); `noteSpeed` independently multiplies mania/taiko movement. `ar`/`cs` override post-mod values. `setSkin(skin?)` rebuilds the atlas and current scene. Compile and skin changes allocate; normal frames reuse typed arrays, descriptors, submission arrays, and GPU buffers. WebGPU command encoders/passes and canvas views are API-required per-frame objects. Static batches contain 128 instances with precomputed lifetime bounds; invisible batches are skipped on the CPU, and WGSL evaluates note movement, holds, approaches, visibility, and slider-ball interpolation.

`loadSkin(async filename => Blob | null, name?)` accepts an asset resolver. Use `/files/skin/<filename>` for the current client skin, or a user-selected folder. It consumes `@vosu-tools/skin-spec`, including repeated Mania sections selected by Keys. Assets try @2x first. Missing/corrupt elements fall back independently. The engine packs one atlas (4096px or the device limit, whichever is smaller); skins exceeding capacity throw rather than silently dropping elements. `Skin.assets` owns ImageBitmaps; callers may close them after renderer destruction or after replacing the skin.

Replay layers are supplied externally: cursor coordinates, per-column key state, and judgement events. The engine does not grade replay input or infer accuracy. Judgements are colour-coded transient markers; replay grading belongs to `packages/replay`. Catch previews interpolate a deterministic automatic catcher when no external cursor is supplied.

`parseOsu` preserves General, Metadata, needed Difficulty settings, timing/sample controls, events/breaks, combo colours, circles/holds/spinners and flattened slider paths. Path math supports linear, segmented Bezier, perfect arcs, and Catmull. Mods include HR/EZ/DA, deterministic RD, MR, HD/FI/FL and mania UD. Unsupported lazer mods are not advertised by the preview UI.
