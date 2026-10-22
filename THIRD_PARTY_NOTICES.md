# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

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

