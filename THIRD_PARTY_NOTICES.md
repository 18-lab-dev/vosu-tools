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
