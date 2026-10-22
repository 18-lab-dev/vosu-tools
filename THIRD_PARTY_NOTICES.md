# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## Practice / osu-file

- Mod algorithms: ppy/osu, revision `2f4e620cbc6245fb88fe1113c1842c213ea58701`, MIT, copyright ppy Pty Ltd. Source mapping and limitations: `tools/practice/PROVENANCE.md`; license: `tools/practice/licenses/osu-MIT.txt`.
- Seeded compatibility random algorithm: .NET runtime `v10.0.0`, `System/Random.CompatImpl.cs`, MIT, .NET Foundation and Contributors. License: `tools/practice/licenses/dotnet-MIT.txt`.
- Audio dependency license texts: `tools/practice/licenses/audio.txt`: Signalsmith Stretch and Linear (MIT), Rust Signalsmith bindings (MIT), minimp3 Rust bindings (MIT) and minimp3 decoder (CC0), rubato (MIT), hound (Apache-2.0), vorbis_rs and bundled Ogg/Vorbis libraries (BSD-3-Clause). Exact resolved versions are in Cargo.lock.
- The original trainer implementation was ported from vosu commit `4c06922` under MIT OR Apache-2.0.
