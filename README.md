# vosu tools

Official tools for [vosu](https://github.com/shiruviaa/vosu) by 18-LAB. Each tool is an out-of-process application hosted by vosu (tool protocol v1): it may have a browser UI under `/tools/<id>/`, a supervised background service, and a command line run through `vosux <id>`. vosu installs them from this repository's releases through the dashboard's tool catalog.

| Tool | id | Interfaces | Purpose |
| --- | --- | --- | --- |
| osu! practice tool | `practice` | CLI, UI | Bring lazer's map-changing mods and rate changes to osu!stable as practice copies |
| Server pp calculator | `server-pp` | service, CLI | pp as calculated by popular private servers |
| Ratings | `ratings` | service, CLI, UI | Etterna, Quaver, Interlude and dan ratings for osu!mania, per map and per section |
| skin.ini editor | `skin-editor` | service, UI | Offline Monaco editor for stable skins: wiki-revisioned validation, completion, colours, external-change detection and atomic saves with backups; read-only without a dashboard session; lazer unsupported |
| Map preview | `map-preview` | UI | Render any map in the browser before playing it, with lazer mods and custom settings |
| Replay renderer | `replay-renderer` | CLI, UI | Render one or more replays to video with your choice of skin, settings and overlays |
| Beatmap downloader | `downloader` | UI | Batch-download maps by mapper, skill level or ratings |

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

## License

Project code is available under the MIT or Apache-2.0 license, at your option. Ported third-party code keeps its own license, recorded next to it and in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
