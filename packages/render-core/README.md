# render-core

Deterministic WebGPU beatmap rendering, MIT OR Apache-2.0. Import from `@vosu-tools/render-core`; parse maps with `@vosu-tools/osu-parse`.

```ts
const map = parseOsu(osuText);
const renderer = await createRenderer({ canvas, width: 1920, height: 1080 });
renderer.setBeatmap(map, {
  mods: [{ acronym: "HR" }],
  scrollSpeed: 20,
  noteSpeed: 1,
});
renderer.renderAt(12345, {
  cursor: { x: 256, y: 192, pressed: false },
  keys: [false, true, false, false],
  judgements: [{ x: 256, y: 192, time: 12200, result: 300 }],
});
renderer.destroy();
```

`renderAt` takes **absolute beatmap milliseconds**, before rate scaling. Audio/replay clocks belong to callers. Calls can arrive in any order, including backwards seeks; no accumulated animation state or random frame state exists. `applyMods` returns a copy; DT/HT rate metadata never rescales hit times. The caller scales its playback clock.

`createRenderer({ device, format: 'rgba8unorm', width, height })` borrows a GPU device and does not destroy it. Without `device`, vgpu creates and owns one. Without a canvas, every `renderAt` call must supply `frame.target: GPUTextureView`; the caller owns target lifetime and readback. **Default presentation is the canvas's direct WebGPU swapchain, with no image transfer or CPU readback.** `presentation: 'bitmap'` explicitly selects an OffscreenCanvas WebGPU swapchain transferred into a visible ImageBitmapRenderingContext, for fallback/capture environments. Pass a fresh canvas when selecting its context type. The preview UI exposes that opt-in as `?presentation=bitmap`; normal launches remain direct. `resize(width,height)` sets output pixel size. Map coordinates are 512×384, centered inside a 640×480 virtual viewport, aspect-preserving; skin stage coordinates can extend into its margins.

`setBeatmap(map, { mods?, ar?, cs?, scrollSpeed?, noteSpeed? })` compiles immutable GPU instance data. `scrollSpeed` is mania's display scroll setting (20 default); `noteSpeed` independently multiplies mania/taiko movement. `ar`/`cs` override post-mod values. `setSkin(skin?)` rebuilds the atlas and current scene. Compile and skin changes allocate; normal frames reuse typed arrays, descriptors, submission arrays, and GPU buffers. WebGPU encoders/passes and swapchain views are API-required per-frame handles; transferred ImageBitmaps exist only in explicitly selected bitmap mode. Note/animation data is never rebuilt per frame. Static chunks contain 128 instances with lifetime bounds. WGSL evaluates movement, holds, approaches, visibility, slider-ball interpolation, animation UV selection, pressed key layers and tiled hold bodies.

`loadSkin(async filename => Blob | null, name?)` accepts an asset resolver. Use `/files/skin/<filename>` for the current client skin, or a user-selected folder. It consumes `@vosu-tools/skin-spec`, selects the matching repeated Mania Keys section, and gates known commands against General.Version. An absent INI uses the latest version; an INI without Version uses 1.0. Supported HD skins try @2x first and preserve SD logical dimensions; named subdirectories, explicit @2x paths, and prefixes are retained. Animated elements use `-0`, `-1`, … (sliderb uses `sliderb0`, `sliderb1`, …) and an immutable GPU UV table. General.AnimationFramerate controls ordinary animations; -1/default completes all frames in one second. Mania note/key/hit-lighting animations, slider balls and circle overlays use their fixed-rate exceptions; StageLight uses LightFramePerSecond. Missing/corrupt elements fall back independently. Gameplay images are height-sorted into a 4096px atlas (or the device limit); oversized images retain aspect while being fitted to 1024px, and capacity overflow throws. `Skin.assets` owns ImageBitmaps; callers may close them after renderer destruction or replacing a skin.

Replay layers are supplied externally: cursor coordinates, per-column key state, judgement events and optional `failed` state. The engine does not grade replay input or infer accuracy. Judgements are colour-coded transient markers; replay grading belongs to `packages/replay`. Without external keys, mania previews generate deterministic merged key/hold intervals for pressed receptors and hit lighting. Catch previews interpolate an automatic catcher; idle/kiai/fail sprites follow timing-point effects and `frame.failed`.

`parseOsu` preserves General, Metadata, needed Difficulty settings, timing/sample controls, events/breaks, combo colours, circles/holds/spinners and flattened slider paths. Path math supports linear, segmented Bezier, perfect arcs, and Catmull. Mods include HR/EZ/DA, deterministic RD, MR, HD/FI/FL and mania UD. Unsupported lazer mods are not advertised by the preview UI.

For instrumentation, `frame.timestampWrites` accepts `GPURenderPassTimestampWrites`; callers must request `timestamp-query` on their borrowed device. Queries measure GPU pass time, not presentation latency. Headless NVIDIA Chromium works with `--enable-unsafe-webgpu --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface`, adding `--disable-gpu-vsync --disable-frame-rate-limit` for pacing experiments. `frame.captureTarget: GPUTexture` copies the **actual presented swapchain texture after its render pass** into a same-format/same-size texture with COPY_DST usage. This is optional and zero-copy overhead is retained when absent; use COPY_SRC on the capture texture and `copyTextureToBuffer` to inspect it. It does not render an alternative scene or depend on the headless compositor capturing WebGPU correctly. Bitmap mode additionally supports direct canvas screenshots/toDataURL. The first fresh headless adapter request may return null during startup; test harnesses perform a readiness request before initialization.

`parseSkinIni` is exported by `@vosu-tools/osu-parse` and delegates lossless syntax parsing to skin-spec. It exposes every section and repeated Mania block without discarding unknown commands. Skin combo colours and slider border/track overrides are honoured when no beatmap override is present. Taiko uses a horizontal native drum lane with the native 1.4 velocity factor (BPM and inherited SV), finishers, rim/centre notes, rolls, beat lines, and swells; it is not a mania conversion.

Gameplay skin layers include Mania StageLeft/Right/Bottom/Hint/Light, per-key normal/pressed images, note/hold-head/body/tail images, spacing/width/start/hit/light coordinates, KeysUnderNotes, NoteBodyStyle, and normal/hold hit lighting; taiko drum, scrolling background, bar edges, normal/big notes and overlays, rolls and hit position; standard hit circles/overlays, prefixed digit widths and overlap, approach circles, animated slider balls/follow circles/arrows/ticks, skin-coloured tracks and spinner components; catch fruit/drop/banana overlays and catcher states.

Mania's StageBottom keeps its native SD size (0.625 playfield scale), is bottom-anchored and overlays notes rather than stretching to the columns. Stage side images stretch vertically, not horizontally. StageLight is bottom-anchored at LightPosition, tinted per ColourLight and drawn under notes; normal/hold lighting is centred at HitPosition and respects LightingNWidth/LightingLWidth. NoteBodyStyle selects stretch/top cascade/bottom cascade, with the version-appropriate default. Version 2+ modern spinner components replace rather than accumulate with the legacy circle/approach sprites. Element geometry and version/rate rules follow the public [skin.ini reference](https://osu.ppy.sh/wiki/en/Skinning/skin.ini) and [mania skinning reference](https://osu.ppy.sh/wiki/en/Skinning/osu%21mania).
