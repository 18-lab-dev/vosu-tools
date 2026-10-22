# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## server-pp calculators

- Akatsuki `akatsuki-pp`, MIT, revision `c0e499ec3ac138c7cc329771fc70992de39fbb77`: https://github.com/osuAkatsuki/akatsuki-pp-rs.
- Mamestagram `mames-pp`, MIT, revision `11f4c0443f8dd777a356cad1d06e675971ec0a4e`: https://github.com/Mamestagram/mamestagram-pp-rs.
- Both are used unmodified as source dependencies; copyright and MIT text ship in `tools/server-pp/licenses/calculators-MIT.txt`.
- Server callsite research: Akatsuki performance-service revision `2e89b9c9d4365e98e2b0d98ba506862db5e92c60` (MIT), consulted but not vendored. No Ripple or other closed/unidentified calculator code is included.
- Calculator transitive dependencies `rosu-map` and `rosu-mods` are MIT; the Mamestagram `rosu-map` Git dependency is resolved at `5a9af8ab` by Cargo.lock. Runtime dependencies use MIT/Apache-2.0/BSD/ISC/Unicode-compatible licenses, resolved in Cargo.lock.
