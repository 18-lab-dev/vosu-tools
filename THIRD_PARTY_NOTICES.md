# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## server-pp calculators

- Akatsuki `akatsuki-pp`, MIT, revision `c0e499ec3ac138c7cc329771fc70992de39fbb77`: https://github.com/osuAkatsuki/akatsuki-pp-rs.
- Mamestagram `mames-pp`, MIT, revision `11f4c0443f8dd777a356cad1d06e675971ec0a4e`: https://github.com/Mamestagram/mamestagram-pp-rs.
- Both are used unmodified as source dependencies; copyright and MIT text ship in `tools/server-pp/licenses/calculators-MIT.txt`.
- Server callsite research: Akatsuki performance-service revision `2e89b9c9d4365e98e2b0d98ba506862db5e92c60` (MIT), consulted but not vendored. No Ripple or other closed/unidentified calculator code is included.
- Calculator transitive dependencies `rosu-map` and `rosu-mods` are MIT; the Mamestagram `rosu-map` Git dependency is resolved at `5a9af8ab` by Cargo.lock. Runtime dependencies use MIT/Apache-2.0/BSD/ISC/Unicode-compatible licenses, resolved in Cargo.lock.

## skin.ini editor

- Monaco Editor 0.52.2, Microsoft Corporation, MIT: https://github.com/microsoft/monaco-editor. License: `tools/skin-editor/licenses/monaco-editor-MIT.txt`. Editor and worker are bundled offline.
- `packages/skin-spec/spec.json` contains interoperability facts extracted from the osu! wiki skin.ini reference at revision `c9fa3ff277dba4c620d4731fd2c3fbb74770c20b`: https://github.com/ppy/osu-wiki/blob/c9fa3ff277dba4c620d4731fd2c3fbb74770c20b/wiki/Skinning/skin.ini/en.md. Wiki prose and images (CC-BY-NC-4.0) are not redistributed; hover wording is independently authored. Regenerate factual fields with `bun packages/skin-spec/generate.ts`.

## Ratings

- MinaCalc 527: Etterna `2d706147cc4bcf95a8ceb24dc4f4129be207f803`,
  copyright 2016–2023 Etterna, MIT. Vendored in `crates/minacalc/vendor`;
  package license `tools/ratings/licenses/MinaCalc.txt`.
- Quaver.API calculator 0.0.5: Quaver/Quaver.API
  `a921d561b2ece7f6bf3682446696c06c17b81649`,
  copyright 2017–2018 Swan & The Quaver Team, MPL-2.0. Separate port
  `tools/ratings/src/quaver.rs` and unmodified test reference source.
  Covered source is available in this repository; license
  `tools/ratings/licenses/Quaver-MPL-2.0.txt`.
- Interlude/YAVSRG Prelude calculator:
  `1fe55766ae1fece3d433c966bf25822647bc8af6`, copyright 2024 percyqaz,
  MIT. Separate port `tools/ratings/src/interlude.rs` and unmodified test
  reference files; license `tools/ratings/licenses/Interlude-MIT.txt`.
- osu!mania reference ratings: rosu-pp 4.0.1, MIT, resolved in Cargo.lock.
- Reform calibration metadata inherited from vosu `4c06922`; course sources
  and checksums are in `tools/ratings/calibration-sources.json`. No third-party
  beatmaps or audio are distributed. Synthetic test charts are CC0.

## Practice / osu-file

- Mod algorithms: ppy/osu, revision `2f4e620cbc6245fb88fe1113c1842c213ea58701`, MIT, copyright ppy Pty Ltd. Source mapping and limitations: `tools/practice/PROVENANCE.md`; license: `tools/practice/licenses/osu-MIT.txt`.
- Seeded compatibility random algorithm: .NET runtime `v10.0.0`, `System/Random.CompatImpl.cs`, MIT, .NET Foundation and Contributors. License: `tools/practice/licenses/dotnet-MIT.txt`.
- Audio dependency license texts: `tools/practice/licenses/audio.txt`: Signalsmith Stretch and Linear (MIT), Rust Signalsmith bindings (MIT), minimp3 Rust bindings (MIT) and minimp3 decoder (CC0), rubato (MIT), hound (Apache-2.0), vorbis_rs and bundled Ogg/Vorbis libraries (BSD-3-Clause). Exact resolved versions are in Cargo.lock.
- The original trainer implementation was ported from vosu commit `4c06922` under MIT OR Apache-2.0.

## Beatmap downloader / osu-db

`crates/osu-db` ports the read-only stable database parser from
`shiruviaa/vosu` commit `4c06922`,
`crates/vosu-tool-skill-tracker/src/stable.rs` (MIT OR Apache-2.0),
extended with collection metadata and ownership identifiers.
No code from mirror implementations or osu-web is included.
Downloader Rust dependencies and their selected permissive license texts
are shipped by the package license generator; see `tools/downloader/Cargo.toml`.
## Map preview and shared render-core

- vgpu 0.6.0 and its bundled @vgpu runtime modules: MIT, Copyright (c) 2025 Vercel, Inc.; https://github.com/vercel-labs/vgpu. License shipped in `tools/map-preview/licenses/vgpu-MIT.txt`. Used for WebGPU device initialization and lifecycle; rendering uses an original WGSL instance pipeline.
- No third-party skin images, audio, beatmaps, or fonts are distributed by this tool. User-selected skin and map data remain user-owned.
