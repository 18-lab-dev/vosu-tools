# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## Beatmap downloader / osu-db

`crates/osu-db` ports the read-only stable database parser from
`shiruviaa/vosu` commit `4c06922`,
`crates/vosu-tool-skill-tracker/src/stable.rs` (MIT OR Apache-2.0),
extended with collection metadata and ownership identifiers.
No code from mirror implementations or osu-web is included.
Downloader Rust dependencies and their selected permissive license texts
are shipped by the package license generator; see `tools/downloader/Cargo.toml`.
