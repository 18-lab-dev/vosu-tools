# vosu tools

Official tools for [vosu](https://github.com/18-lab-dev/vosu) by 18-LAB. Each tool is an out-of-process application hosted by vosu (tool protocol v1): it may have a browser UI under `/tools/<id>/`, a supervised background service, and a command line run through `vosux <id>`. vosu installs them from this repository's releases through the dashboard's tool catalog.

| Tool | id | Interfaces | Purpose |
| --- | --- | --- | --- |
| osu! practice tool | `practice` | CLI, UI | Offline rates, ruleset-specific transforms (Constant Speed, seeded Random, Mirror…), trims to chosen sections with cut audio, a render-core playfield preview of the result and named profiles; see [scope and provenance](tools/practice/PROVENANCE.md) |
| Server pp calculator | `server-pp` | service, CLI, UI | Reproduce pinned public Akatsuki and Mamestagram calculator snapshots and run user-supplied WebAssembly pp calculators; a results table compares them on the selected map, with official pp comparison |
| Mania ratings | `mania-ratings` | service, CLI, UI | Etterna, Quaver, Interlude and dan ratings for osu!mania, per map and per section |
| Skin studio | `skin-studio` | UI | Browse stable skins, added folders and `.osk` files, and lazer skins (via `lazer-library`), with an in-page file Explorer whose selections feed per-asset mixing; preview images, @2x, animations (cached APNG at AnimationFramerate), hitsounds and a looping gameplay preview per ruleset; mix element groups per ruleset plus single assets (carrying the skin.ini keys that make them draw) into a new stable skin (atomic, never overwrites without confirmation) or a downloaded `.osk`; Monaco skin.ini editor with wiki-revisioned checks and backups. [Details](tools/skin-studio/README.md) |
| Map preview | `map-preview` | UI | Opens on the game's current map at the current time and follows map, mods, clock (the track's actual rate) and skin live; hidden during the player's own gameplay. All four rulesets with the client's skin (stable or lazer, files or built-in Argon / Triangles / classic look; [client-skin](packages/client-skin/README.md)), an `.osk` file or a skin folder; legacy mania skins are laid out as osu!lazer lays them out, golden-tested against lazer itself; osu! maps played in taiko, mania or catch are converted as osu!lazer converts them (key count, key mods and Dual Stages included; [ruleset-convert](packages/ruleset-convert/README.md)); manual `.osu` preview with audio (muted until unmuted, remembered) and a ruleset choice; settings in the dashboard; [shared renderer API](packages/render-core/README.md) |
| Replay renderer | `replay-renderer` | CLI, UI | Deterministic multi-replay studio with player presets and per-ruleset render settings; browser WebM and native MP4 using a SHA-256-pinned managed browser plus external FFmpeg, without Node. [Settings/runtime contract](tools/replay-renderer/README.md). Judgement HUD appears only when stored counts verify. |
| Beatmap downloader | `downloader` | UI | Context-aware discovery, read-only stable library/history, and a polite validated mirror queue |
| Lazer library | `lazer-library` | service | Read-only, consistent Realm snapshots for MD5 map lookup, owned sets, skins and replay files; [schema and concurrency design](crates/realm-reader/DESIGN.md) |

UI/CLI tools can have a native **backend** for local files or rendering. vosu starts it on demand and stops it when idle; it is not a separate service interface. Only background services have Start/Stop/Restart and **Start with vosu** controls. That per-user setting overrides the manifest default and is available in Details, tool Settings, or `vosux --autostart <id> on|off|default`. Server pp, mania ratings and lazer library default to on-demand; enable startup for whichever background services you use.

## Layout

- `crates/vosu-tool-sdk`: Rust helpers for the tool protocol (environment, readiness handshake, token checks, vosu/host/dependency clients, CLI output helpers).
- `crates/*`: shared Rust libraries.
- `packages/tool-web`: shared web tooling (bridge types, Vite preset). `packages/*`: shared browser libraries.
- `tools/<id>/`: one tool per directory: `Cargo.toml` (binary `vosu-<id>`), `tool.toml`, optional `settings.json`, optional `web/` (Vite project building to `web/dist`).
- `scripts/package.py`: builds release packages and `catalog.json` ([contract](docs/catalog.md)).

## Development

Requirements: the pinned Rust toolchain (`rust-toolchain.toml`), Bun, and a vosu 1.2.0 build.

```sh
bun install
bun run build                      # build every tool UI into web/dist
cargo build --locked
vosu --tool tools/<id>             # run a tool from this checkout; vosu restarts it after rebuilds
vosux <id> --help
```

Beatmap fixtures use LF on every checkout, including Windows (`.gitattributes`),
so golden comparisons and section-insertion tests do not depend on Git's
`core.autocrlf` setting.

## Release packaging

With Python 3.11+, the target's native build dependencies, Rust, and Bun installed:

```sh
bun install --frozen-lockfile
python scripts/package.py --target x86_64-unknown-linux-gnu \
  --base-url https://github.com/18-lab-dev/vosu-tools/releases/download/v0.1.0
python -m unittest discover -s scripts -p test_package.py
```

Packages and `catalog.json` are written to `dist/`. The script builds release binaries with the locked Cargo graph, builds offline UIs with hidden source maps for bundled-package license discovery, and emits verified, deterministic ZIPs. `--dry-run` validates manifests and prints the build plan; `--skip-build` packages existing binaries and hidden-sourcemap UI output. Windows releases use `x86_64-pc-windows-msvc`; the native Windows runner also checks Clippy and tests. Universal UI-only packages are published once from Linux (`--native-only` omits them on the Windows packaging job). Catalog merging and license provenance are described in the [package contract](docs/catalog.md#building-and-merging-catalogs).
Manifest, catalog, lockfile and source-map text, along with Cargo's captured
metadata, is decoded as UTF-8 regardless of the build machine's locale.

The reusable real-package smoke requires a separately built vosu `test-harness` binary and both generated catalogs:

```sh
python scripts/smoke_install.py --vosu /tmp/vosu-int-target/debug/vosu \
  --tools /tmp/vosu-tools-evidence/integration/packages/tools \
  --overlays /tmp/vosu-tools-evidence/integration/packages/overlays \
  --playwright-module /tmp/vosu-tools-evidence/catalog/browser/node_modules/playwright/index.mjs \
  --browser-cache /tmp/vosu-tools-evidence/catalog/browser-cache
```

It serves test-only loopback catalog copies (package digests/bytes are unchanged), isolates HOME and every XDG root including `XDG_RUNTIME_DIR`, uses only daemon ports 25150/25151, installs and approves the real tools, starts services, reads their APIs, exercises CLI help, and opens all UIs in a private headless browser. JSON receipts, logs, CLI help, and dark/light screenshots go under `/tmp/vosu-tools-evidence/integration/`. It never generates practice maps, modifies skins, downloads user beatmaps, or renders to a user's directories.


## License

Project code is available under the MIT or Apache-2.0 license, at your option. Ported third-party code keeps its own license, recorded next to it and in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
