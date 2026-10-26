# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## Practice / osu-file

- Mod algorithms: ppy/osu, revision `2f4e620cbc6245fb88fe1113c1842c213ea58701`, MIT, copyright ppy Pty Ltd. Source mapping and limitations: `tools/practice/PROVENANCE.md`; license: `tools/practice/licenses/osu-MIT.txt`.
- Seeded compatibility random algorithm (`crates/osu-file`, and `NetRandom` in `packages/osu-parse` for the replay renderer's seeded Random): .NET runtime `v10.0.0`, `System/Random.CompatImpl.cs`, MIT, .NET Foundation and Contributors. License: `tools/practice/licenses/dotnet-MIT.txt` (also shipped as `tools/replay-renderer/licenses/dotnet-MIT.txt`).
- Audio dependency license texts: `tools/practice/licenses/audio.txt`: Signalsmith Stretch and Linear (MIT), Rust Signalsmith bindings (MIT), minimp3 Rust bindings (MIT) and minimp3 decoder (CC0), rubato (MIT), hound (Apache-2.0), vorbis_rs and bundled Ogg/Vorbis libraries (BSD-3-Clause). Exact resolved versions are in Cargo.lock.
- The original trainer implementation was ported from vosu commit `4c06922` under MIT OR Apache-2.0.
- Slider curve parsing/calculation: rosu-map 0.2.1, MaxOhn, MIT. License: `tools/practice/licenses/rosu-map-MIT.txt`.
- Fast vector-length reference formula: osuTK/OpenTK MathHelper, MIT, copyright Stefanos Apostolopoulos. License: `tools/practice/licenses/osuTK-MIT.txt`. No graphics/runtime library is linked.
- The practice tool icon and banner (`tools/practice/art/`) are original artwork. Its UI uses the fonts of vosu's shared theme and bundles none.
- The practice UI's playfield preview bundles the workspace `packages/render-core` and `packages/osu-parse` (project code) and their npm dependencies (see "Map preview and shared render-core"); packaging records the bundled packages and their license texts from the UI's source maps.
## server-pp calculators

- Akatsuki `akatsuki-pp`, MIT, revision `c0e499ec3ac138c7cc329771fc70992de39fbb77`: https://github.com/osuAkatsuki/akatsuki-pp-rs.
- Mamestagram `mames-pp`, MIT, revision `11f4c0443f8dd777a356cad1d06e675971ec0a4e`: https://github.com/Mamestagram/mamestagram-pp-rs.
- Both are used unmodified as source dependencies; copyright and MIT text ship in `tools/server-pp/licenses/calculators-MIT.txt`.
- Server callsite research: Akatsuki performance-service revision `2e89b9c9d4365e98e2b0d98ba506862db5e92c60` (MIT), consulted but not vendored. No Ripple or other closed/unidentified calculator code is included.
- Calculator transitive dependencies `rosu-map` and `rosu-mods` are MIT; the Mamestagram `rosu-map` Git dependency is resolved at `5a9af8ab` by Cargo.lock. Runtime dependencies use MIT/Apache-2.0/BSD/ISC/Unicode-compatible licenses, resolved in Cargo.lock.
- Custom calculators: wasmi 2.0.0 (MIT OR Apache-2.0, Robin Freyler, https://github.com/wasmi-labs/wasmi) runs user modules; its dependencies (wasmparser, libm, spin and others) are MIT, Apache-2.0 or dual-licensed and resolved in Cargo.lock. The published wasmi, wasmi_core, wasmi_ir, wasmi_collections 2.0.0 and wasmparser 0.228.0 crates include no license file. Their upstream MIT texts are retained in `tools/server-pp/licenses/wasmi-MIT.txt` (wasmi revision `2970aa871cc1001b57b267ccecdcd1e42306199e`) and `tools/server-pp/licenses/wasm-tools-MIT.txt` (wasm-tools revision `e66235859a6ec0502bf6f9dcc358953eda4cafcc`). `scripts/package.py` binds them to those versions, revisions and text blobs. rosu-pp 4.0.1 (MIT, Max) supplies the difficulty attributes and score states handed to modules. The test-only `wat` crate (Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT) is not shipped.
- `tools/server-pp/examples/rosu-reference` ports rosu-pp 4.0.1's stable performance formulas (MIT, Copyright (c) 2021 Max; text in `tools/server-pp/examples/rosu-reference/LICENSE-rosu-pp`) as a fidelity test module; the compiled copy lives only under `tests/fixtures`. The AssemblyScript example builds with AssemblyScript 0.28.20 (Apache-2.0, dev dependency, not shipped).
- The tool icon and banner are original artwork. The UI uses vosu's shared design system and bundles no fonts.

## Skin studio

- Monaco Editor 0.52.2, Microsoft Corporation, MIT: https://github.com/microsoft/monaco-editor. License: `tools/skin-studio/licenses/monaco-editor-MIT.txt`. Editor and worker are bundled offline.
- Mixing behaviour (per-element source skins, `@2x`/animation-frame matching, transparent "blank" elements, skin.ini values travelling with their elements) follows osu!SkinMixer by rednir (MIT), revision `091fb50e91b89e2b28e45f3190b093192ba113ed`: https://github.com/rednir/OsuSkinMixer. It was consulted as a behavioural reference only; no code or assets are copied. Element group lists are authored from the osu! wiki skinning reference.
- Native dependencies `png` (MIT OR Apache-2.0) for APNG animation previews and `zip` (MIT) for `.osk` export, resolved in Cargo.lock.
- Native dependency `image` 0.25 (MIT OR Apache-2.0; PNG and JPEG codecs only) for the Quaver and Etterna exports, resolved in Cargo.lock.
- The Quaver and Etterna exports follow those games' skin formats as read in Quaver `d22a4a312479e73cd652a5f4683d3607e6795620` (MPL-2.0) and Etterna `2d706147cc4bcf95a8ceb24dc4f4129be207f803` (MIT); sources per rule in `tools/skin-studio/EXPORT.md`. No code, Lua, metrics or images of either game are copied: exported images come from the user's mix or are drawn by Skin studio, and the generated `NoteSkin.lua` and `metrics.ini` are original.
- `packages/skin-spec/spec.json` contains interoperability facts extracted from the osu! wiki skin.ini reference at revision `c9fa3ff277dba4c620d4731fd2c3fbb74770c20b`: https://github.com/ppy/osu-wiki/blob/c9fa3ff277dba4c620d4731fd2c3fbb74770c20b/wiki/Skinning/skin.ini/en.md. Wiki prose and images (CC-BY-NC-4.0) are not redistributed; hover wording is independently authored. Regenerate factual fields with `bun packages/skin-spec/generate.ts`.

## Mania ratings

- MinaCalc 527: Etterna `2d706147cc4bcf95a8ceb24dc4f4129be207f803`,
  copyright 2016–2023 Etterna, MIT. Vendored in `crates/minacalc/vendor`;
  package license `tools/mania-ratings/licenses/MinaCalc.txt`.
- Quaver.API calculator 0.0.5: Quaver/Quaver.API
  `a921d561b2ece7f6bf3682446696c06c17b81649`,
  copyright 2017–2018 Swan & The Quaver Team, MPL-2.0. Separate port
  `tools/mania-ratings/src/quaver.rs` and unmodified test reference source.
  Covered source is available in this repository; license
  `tools/mania-ratings/licenses/Quaver-MPL-2.0.txt`.
- Interlude/YAVSRG Prelude calculator:
  `1fe55766ae1fece3d433c966bf25822647bc8af6`, copyright 2024 percyqaz,
  MIT. Separate port `tools/mania-ratings/src/interlude.rs` and unmodified test
  reference files; license `tools/mania-ratings/licenses/Interlude-MIT.txt`.
- osu!mania reference ratings: rosu-pp 4.0.1, MIT, resolved in Cargo.lock.
- Reform calibration metadata inherited from vosu `4c06922`; course sources
  and checksums are in `tools/mania-ratings/calibration-sources.json`. No third-party
  beatmaps or audio are distributed. Synthetic test charts are CC0.
- Icon and banner art (`tools/mania-ratings/art`) are original to this project.

## Beatmap downloader / osu-db

`crates/osu-db` ports the read-only stable database parser from
`shiruviaa/vosu` commit `4c06922` (historical repository identity retained for provenance; now [`18-lab-dev/vosu`](https://github.com/18-lab-dev/vosu)),
`crates/vosu-tool-skill-tracker/src/stable.rs` (MIT OR Apache-2.0),
extended with collection metadata and ownership identifiers.
No code from mirror implementations or osu-web is included.
Downloader Rust dependencies and their selected permissive license texts
are shipped by the package license generator; see `tools/downloader/Cargo.toml`.

The icon and banner artwork in `tools/downloader/art/` is original.

## Map preview and shared render-core

- vgpu 0.6.0 and its bundled @vgpu runtime modules: MIT, Copyright (c) 2025 Vercel, Inc.; https://github.com/vercel-labs/vgpu. License shipped in `tools/map-preview/licenses/vgpu-MIT.txt`. Used for WebGPU device initialization and lifecycle; rendering uses an original WGSL instance pipeline.
- naga 30.0.0 (wgpu project): MIT OR Apache-2.0; https://github.com/gfx-rs/wgpu. A development tool only (`packages/render-core/glsl`), never shipped: it translates render-core's own WGSL into the GLSL ES 3.00 in `packages/render-core/src/shader-glsl.ts` used by the WebGL2 fallback. The generated shader is a translation of render-core's code, not naga's.
- osu! (lazer) by ppy Pty Ltd: MIT, Copyright (c) 2025 ppy Pty Ltd; https://github.com/ppy/osu at tag 2026.1005.0-lazer (commit 9a10d935b05a3b896f4bd811d620f2023331db93). `packages/render-core/src/builtin.ts` is an original Canvas 2D/WGSL reimplementation of the look of the clients' built-in skins (Argon, Argon Pro, Triangles, classic) using measurements, colours and colour formulas read from that MIT source (for example `ArgonMainCirclePiece`, `ManiaArgonSkinTransformer`, `LegacySliderBody`, `DrawableSliderPath`); no source code or textures are copied, and nothing from osu-resources (CC BY-NC) is used. Judgement drawing (`packages/render-core/src/judgements.ts` and its shader profiles) is a port (translated code) of lazer's judgement, legacy judgement piece, particle and hit explosion drawables at the same tag; its catch explosion stand-ins are drawn, not lazer's textures. Replay-driven gameplay drawing (`packages/render-core/src/gameplay.ts`, the taiko mascot and kiai glow, the catch plate and trails) is likewise a port of lazer's input drum, mascot, kiai glow, catcher, trail and cursor drawables at the same tag. Details in `packages/render-core/PROVENANCE.md`; license shipped in `tools/map-preview/licenses/ppy-osu-MIT.txt`.
- Ruleset conversion and slider paths are ports (translated code) of MIT sources. `packages/ruleset-convert` ports osu! (lazer) at the same tag: `osu.Game.Rulesets.{Taiko,Mania,Catch}/Beatmaps` converters, the mania legacy pattern generators, `LegacyRandom`, `CatchBeatmapProcessor`, `JuiceStream`/`BananaShower` nesting and `SliderEventGenerator`. `packages/osu-parse` slider paths port `ConvertHitObjectParser`'s path splitting and `SliderPath` from the same osu! revision and `PathApproximator`/`CircularArcProperties` from osu!framework 2026.921.1 (https://github.com/ppy/osu-framework, commit 37c3e328c8cc7a018234ec78982ea12d3712096a; MIT, Copyright (c) 2024 ppy Pty Ltd). File-by-file mapping in `packages/ruleset-convert/README.md`. Both are bundled by every tool UI that uses render-core: licenses ship as `tools/map-preview/licenses/ppy-osu-MIT.txt` and `ppy-osu-framework-MIT.txt`, `tools/replay-renderer/licenses/ppy-osu-MIT.txt` and `ppy-osu-framework-MIT.txt`, and `tools/practice/licenses/osu-MIT.txt` and `osu-framework-MIT.txt`. The C# oracle in `packages/ruleset-convert/test/reference` only runs locally for golden tests and is never packaged.
- The judgement and health simulation in `packages/replay` (`src/osu.ts`, `src/catch.ts`, `src/taiko.ts`, `src/mania.ts`, `src/health.ts`, `src/mods.ts`, `src/scoring.ts`) and the mod handling in `packages/osu-parse` (`applyMods`) are ports (translated code) of osu! (lazer)'s gameplay, mod and scoring rules at commit 920019169c2cb7ea3c6956499e529450064619ea (MIT, Copyright (c) 2025 ppy Pty Ltd): `OsuHitWindows`, `TaikoHitWindows`, `ManiaHitWindows`, `StartTimeOrderedHitPolicy`, `LegacyHitPolicy`, `OrderedHitPolicy`, `SliderInputManager`, `SliderEventGenerator`, `DrawableSlider`/`DrawableSpinner`, `DrawableHit`/`DrawableDrumRoll`/`DrawableSwell` and `DrawableHoldNote` judgement, `SpinnerSpinHistory`, `Catcher.CanCatch`, the health processors (`DrainingHealthProcessor`, `LegacyDrainingHealthProcessor`, `AccumulatingHealthProcessor` and each ruleset's), the Easy/Hard Rock/Difficulty Adjust/Random/Mirror/Swap/Invert/Hold Off/No Release mods, `ScoreProcessor` and each ruleset's score processor, the score multiplier calculators, and the osu!stable ScoreV1 rules lazer documents in `OsuLegacyScoreSimulator`/`CatchLegacyScoreSimulator` and `LegacyRulesetExtensions`. The license text ships in `tools/replay-renderer/licenses/ppy-osu-MIT.txt`.
- The legacy mania layout in `packages/render-core` (`src/mania.ts` and the mania parts of `src/scene.ts` and `src/shader.ts`) is a port (translated code) of osu! (lazer)'s legacy mania skinning at the same tag (`LegacyManiaSkinDecoder`, `LegacyManiaSkinConfiguration`, `LegacySkin` mania lookups, `Stage`/`ColumnFlow`/`Column`, `osu.Game.Rulesets.Mania/Skinning/Legacy/*`, `BarLineGenerator`), the legacy taiko and catch layouts (`src/taiko.ts`, `src/fruits.ts`, `src/colour.ts`: lazer's taiko/catch playfields and `Skinning/Legacy/*`, `CatchAutoGenerator`, `StatelessRNG`, combo colour normalisation), with element sizing from osu!framework 2026.921.1's `Sprite`/`TextureAnimation`; MIT, bundled by the same tool UIs with the same license files as the ports above. Details in `packages/render-core/PROVENANCE.md`. The C# harness in `packages/render-core/test/reference` only runs locally for golden tests and is never packaged.
- The Map preview icon and banner (`tools/map-preview/art/`) are original artwork under the project license. No third-party skin images, audio, or beatmaps are distributed by this tool. User-selected skin and map data remain user-owned.

## Replay renderer, replay and render-export

- LZMA-JS (`lzma` 2.3.2): MIT, Copyright (c) 2015 Nathan Rugg; https://github.com/nmrugg/LZMA-JS. Unmodified decompression dependency.
- webm-muxer 5.1.4: MIT, Copyright (c) Vanilagy; https://github.com/Vanilagy/webm-muxer. WebCodecs chunk muxing; no encoders or codecs are bundled.
- Native dependencies: clap (MIT OR Apache-2.0), uuid (MIT OR Apache-2.0), md-5 (MIT OR Apache-2.0), walkdir (Unlicense OR MIT; choose MIT), plus the shared vosu-tool-sdk. Release packaging includes the selected permissive dependency license texts.
- Replay overlay compositing additionally uses rosu-pp 4.0.1 (MIT) for replay-driven pp, the existing vosu-mania-ratings library and its retained calculator notices for timelines, tokio-tungstenite/tungstenite (MIT) for the private browser protocol transport, and base64 (MIT OR Apache-2.0). The release license collector retains their resolved dependency texts. Installed overlay pages remain user-owned external inputs.
- Chrome Headless Shell 156.0.8078.47 is downloaded as an external subprocess runtime from Google's [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) archive, SHA-256-pinned for Linux/Windows x86_64. Its entire upstream `LICENSE.headless_shell` and other archive notices remain beside the executable in the tool cache. It is not bundled into the tool package or linked into Rust code. `VOSU_RENDER_CHROMIUM` supports an explicit external runtime override. FFmpeg remains user-installed (`VOSU_RENDER_FFMPEG` override); MP4 uses VP9 (libvpx) and AAC, not libx264. Prefer an LGPL-only external FFmpeg distribution.
- The tool icon and banner are original artwork. The UI uses vosu's shared theme and bundles no fonts.
- No beatmaps, replays, skins, audio or third-party overlay content are distributed. Tests use synthetic inputs or explicit temporary copies of locally installed user files.

## Packaging license retention

The published `dasp` family 0.11.0 crates and `dasp_window` 0.11.1 omit the upstream monorepo's root license texts. Packaging selects MIT and retains the exact `Copyright (c) 2016 RustAudio Developers` text at `scripts/licenses/dasp-MIT.txt` (upstream Git blob `b35b54912ac435a64227b09c9347475caefa1cbd`). It is identical at their published VCS revisions [`221b8103`](https://github.com/RustAudio/dasp/blob/221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc/LICENSE-MIT), [`97c3bb9b`](https://github.com/RustAudio/dasp/blob/97c3bb9b2363c0b46ac1633858bf1054fd02a980/LICENSE-MIT), and [`e4d53532`](https://github.com/RustAudio/dasp/blob/e4d535324f8b6c83d16c4f006a9ba3f07f3f147d/LICENSE-MIT). Each exception checks the exact crate version and `.cargo_vcs_info.json` revision before use.

`vorbis_rs` 0.5.6 likewise omits its repository-root BSD-3-Clause text; the already-retained `tools/practice/licenses/audio.txt` carries Alejandro González's notice and terms. Its packaging exception checks published revision `6934784e7188e98dd053370c79604c72b201e97a`. All other dependency notices come directly from their resolved source packages; missing or disallowed licenses fail the build.

## Lazer library / realm-reader

- Realm core 20.1.2, commit `3aba889bd9c93c91ea7906b9ec4b60a5c5dcab45` (the native pin in Realm .NET 20.1.0): Apache-2.0. Vendored build source in `crates/realm-reader/native/realm-core-20.1.2.tar.gz`; package text in `tools/lazer-library/licenses/realm-core-Apache-2.0.txt`. Two portability patches preserve integer-min constant semantics for clang-cl and use core's scalar implementations for clang-cl rather than raising the CPU baseline.
- Native bundled dependencies: S2 geometry (Apache-2.0), Intel RDFP Math 20U2 (BSD-3-Clause), mpark variant, nlohmann JSON and jsonsl (MIT), SHA-1 by Steve Reid and kalven SHA-2 (public domain). Their original source notices remain in the archive; redistribution texts ship in `tools/lazer-library/licenses/`. SHA-1 pin `d9ae30f34095107ece9dceb224839f0dc2f9c1c7`; SHA-2 pin `0e9aebf34101c6aa89355fd76ac9cd886735dee1`.
- Rust dependencies are permissively licensed: cmake, notify, chrono, tempfile, clap, serde/serde_json, thiserror, axum, tokio, libc, unicase, tower, md-5 and the existing SDK; release packaging collects their resolved dependency texts. No osu! client assets or private Realm data ship.
- The icon and banner (`tools/lazer-library/art/`) are original project artwork.
