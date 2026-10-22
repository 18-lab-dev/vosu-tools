# vosu tools

Official tools for [vosu](https://github.com/shiruviaa/vosu) by 18-LAB. Each tool is an out-of-process application hosted by vosu (tool protocol v1): it may have a browser UI under `/tools/<id>/`, a supervised background service, and a command line run through `vosux <id>`. vosu installs them from this repository's releases through the dashboard's tool catalog.

| Tool | id | Interfaces | Purpose |
| --- | --- | --- | --- |
| osu! practice tool | `practice` | CLI, UI, service | Offline rates, Constant Speed, seeded Random and ruleset-specific map transforms; see [scope and provenance](tools/practice/PROVENANCE.md) |
| Server pp calculator | `server-pp` | service, CLI | Reproduce pinned public Akatsuki and Mamestagram calculator snapshots, with official pp comparison |
| Mania ratings | `mania-ratings` | service, CLI, UI | Etterna, Quaver, Interlude and dan ratings for osu!mania, per map and per section |
| skin.ini editor | `skin-editor` | service, UI | Offline Monaco editor for skin.ini: wiki-revisioned validation, completion, colours, external-change detection and atomic saves with backups; stable Skins plus folders added by path (including lazer's "Edit externally" folder); lazer's current skin is viewable read-only; read-only without a dashboard session |
| Map preview | `map-preview` | UI | WebGPU previews for all four rulesets, audio-synced seeking/rate, visual mods, AR/CS and scroll controls; skins from the client's current skin (stable, or lazer via vosu's `/files/skin/` report, with built-in lazer skins falling back to defaults), an `.osk` file, or a skin folder; [shared renderer API](packages/render-core/README.md) |
| Replay renderer | `replay-renderer` | service, CLI, UI | Deterministic multi-replay studio with player presets and per-ruleset render settings; browser WebM and native MP4 using a SHA-256-pinned managed browser plus external FFmpeg, without Node. [Settings/runtime contract](tools/replay-renderer/README.md). Judgement HUD appears only when stored counts verify. |
| Beatmap downloader | `downloader` | service, UI | Context-aware discovery, read-only stable library/history, and a polite validated mirror queue |
| Lazer library | `lazer-library` | service, CLI | Read-only, consistent Realm snapshots for MD5 map lookup, owned sets, skins and replay files; [schema and concurrency design](crates/realm-reader/DESIGN.md) |

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

## Release packaging

With Python 3.11+, the target's native build dependencies, Rust, and Bun installed:

```sh
bun install --frozen-lockfile
python scripts/package.py --target x86_64-unknown-linux-gnu \
  --base-url https://github.com/shiruviaa/vosu-tools/releases/download/v0.1.0
python -m unittest discover -s scripts -p test_package.py
```

Packages and `catalog.json` are written to `dist/`. The script builds release binaries with the locked Cargo graph, builds offline UIs with hidden source maps for bundled-package license discovery, and emits verified, deterministic ZIPs. `--dry-run` validates manifests and prints the build plan; `--skip-build` packages existing binaries and hidden-sourcemap UI output. Windows releases use `x86_64-pc-windows-msvc`; the native Windows runner also checks Clippy and tests. Universal UI-only packages are published once from Linux (`--native-only` omits them on the Windows packaging job). Catalog merging and license provenance are described in the [package contract](docs/catalog.md#building-and-merging-catalogs).

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
