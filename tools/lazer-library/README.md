# Lazer library

Read-only access to your osu!lazer library for the other tools: beatmaps by MD5, owned beatmap sets, skins and replay files, read from consistent Realm snapshots.

Interfaces: **service only**, with no page or command line of its own. It starts on demand unless you enable **Start with vosu**.

## Who uses it

Other tools call its open read routes (`/tools/lazer-library/api/v1/…`) when it is installed. None of them requires it:

- [Replay renderer](../replay-renderer/README.md) finds lazer maps by MD5 and lists lazer scores with replays.
- [Skin studio](../skin-studio/README.md) lists imported lazer skins and reads their files.
- [Beatmap downloader](../downloader/README.md) hides sets you already own in lazer.

## Routes

All relative to `/tools/lazer-library/api`:

- `GET /v1/status`
- `GET /v1/beatmaps/by-md5/<md5>`
- `GET /v1/beatmapsets/online-ids`
- `GET /v1/skins`, `GET /v1/skins/<id>/files`, `GET /v1/skins/<id>/file/<name>`
- `GET /v1/scores/by-beatmap/<md5>`

Lazer's Realm database is only read, never written. The [schema and concurrency design](../../crates/realm-reader/DESIGN.md) covers the pinned lazer and Realm versions, schema compatibility, consistent snapshots while the client writes, refresh policy and the data location.

## Settings

**Lazer data folder** (`lazer_data_dir`): an optional folder containing `client.realm` and `files`. The active lazer client's folder takes precedence, and `storage.ini` custom locations are followed.
