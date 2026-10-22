# Read-only lazer Realm access

## Pinned compatibility

The target is osu!lazer **2026.1005.0-lazer**, ppy/osu revision
[`9a10d935b05a3b896f4bd811d620f2023331db93`](https://github.com/ppy/osu/tree/9a10d935b05a3b896f4bd811d620f2023331db93).
`osu.Game/Database/RealmAccess.cs` declares application schema **52**;
`osu.Game/osu.Game.csproj` uses Realm .NET **20.1.0**. Its native submodule
is realm-core **20.1.2**, revision
[`3aba889bd9c93c91ea7906b9ec4b60a5c5dcab45`](https://github.com/realm/realm-core/tree/3aba889bd9c93c91ea7906b9ec4b60a5c5dcab45),
whose `Group::g_current_file_format_version` is **24**. Application schema and
file format are separate numbers. Unknown application schemas fail closed.

These models were checked at that osu revision (paths relative to `osu.Game/`):

| Model / source | Native table | Relevant persisted shape |
| --- | --- | --- |
| `Beatmaps/BeatmapSetInfo.cs` | `class_BeatmapSet` | UUID ID primary key; OnlineID; Beatmaps links; Files embedded-list; DeletePending, Protected, Hash, dates/status |
| `Beatmaps/BeatmapInfo.cs` | `class_Beatmap` | UUID ID; indexed MD5Hash, OnlineID; SHA-256 Hash; Ruleset and BeatmapSet links; Metadata link; embedded Difficulty/UserSettings; DifficultyName. Path is **ignored**, resolved by matching Hash to set Files. |
| `Models/RealmNamedFileUsage.cs` | `class_RealmNamedFileUsage` (embedded) | Filename and File link |
| `Models/RealmFile.cs` | `class_File` | SHA-256 Hash primary key; backlink Usages is not stored as an ordinary property; no size field |
| `Skinning/SkinInfo.cs` | `class_Skin` | UUID ID; Name, Creator, InstantiationInfo, Hash, Protected, Files embedded-list, DeletePending |
| `Scoring/ScoreInfo.cs` | `class_Score` | UUID ID; BeatmapInfo link may be null; BeatmapHash is **SHA-256**, not MD5; Ruleset link; Files, Hash; embedded User; Mods JSON text; Date timestamp; TotalScore; DeletePending |
| `Rulesets/RulesetInfo.cs` | `class_Ruleset` | ShortName string primary key (`osu`, `taiko`, `fruits`, `mania`); indexed OnlineID, Name, InstantiationInfo, Available, LastAppliedDifficultyVersion |

Supporting BeatmapMetadata is a top-level object keyed by native object key
(no primary key): Artist, Title, embedded Author.Username, AudioFile and
BackgroundFile. Realm core resolves embedded lists and primary-key links;
Rust joins metadata by `_key`. UUID strings are consistently exposed in core's
representation, including for skins, so list IDs round-trip to file routes.
Soft-deleted sets/skins/scores are excluded. Online IDs <= 0 become null or
are excluded from the owned-set list. Unsupported custom rulesets are omitted
from the four-ruleset beatmap API.

## Decision: small FFI boundary to pinned Realm core

A pure Rust parser would need the dual-header selector, integer widths and
signed packed values, B+tree nodes/clusters, sparse object keys, nullable
columns, short/long/dictionary strings, chunked binaries, links, embedded
objects and collections, UUIDs and timestamps. Correctness includes format
upgrades and malformed-file bounds, not just extracting ASCII hashes.
[`realm-db-reader` 0.2.1](https://docs.rs/realm-db-reader/0.2.1/realm_db_reader/)
is an existing MIT read-only Rust implementation. Its published `src/realm.rs`
explicitly accepts only header formats `(9, 9)`, rejecting lazer's format 24;
`src/table/header.rs` leaves Binary and several other column types unimplemented,
and its ColumnType does not include UUID. This is a concrete compatibility
failure, not simply an ergonomic preference. The similarly named `realm_core`
0.5.1 crate is an unrelated network relay, not bindings to the mobile database.
A new pure-Rust format-24 parser would therefore be substantial, high-risk work.
We use the **same core revision as .NET**, not a second file-format implementation.

The vendored source archive comes from that core commit and its SHA-1/SHA-2
submodules, excluding `.git`, tests, docs, benchmarks and GitHub configuration.
Two small portability edits are retained: express INT64_MIN as
`(-0x7fffffffffffffffLL - 1)` in `array.hpp` (clang-cl otherwise diagnoses
the original literal as an overflowing constexpr), and disable core's optional
SIMD path specifically for clang-cl in `utilities.hpp` (its intrinsic inlining
otherwise requires a higher unconditional CPU baseline). Scalar core paths
remain functional; neither edit changes storage semantics or the file format.
CMake builds only Storage and our static C ABI bridge. No sync, network SDK,
.NET runtime, encryption, object store or runtime downloads.
C++ exceptions are caught at the ABI; Rust callbacks cannot unwind through it.
Only selected library tables are streamed one row at a time as core JSON.
The native Group constructor is explicitly read-only. It receives **only a
private temporary copy**, never the user's path, and never constructs DB,
SharedRealm, locks or management sidecars. Fixture generation is separate.

## Concurrent writes and MVCC

Opening an uncoordinated Group on a live file is **unsafe**, even if its header
is pinned: after later commits, Realm can reuse pages from the old version.
Opening DB read-only instead would participate in shared lock/reader state,
which violates our no-sidecar-modification requirement. We do neither.

1. Open the source with an ordinary read-only file handle. Read its 24-byte
   header. Bit 0 of byte 23 chooses one of the two little-endian top refs at
   bytes 0/8; bytes 20/21 hold the corresponding file format. Follow only that
   selected reference. Read the bounded top array (3..12 entries). Its seventh
   slot contains the monotonically increasing transaction version for DB
   commits. Read the header again and retry if it changed. Group::write's
   immutable streaming form is recognised via the footer.
2. Linux first attempts **FICLONE** into a fresh private temp file. Supported
   filesystems give a point-in-time COW image, so later page reuse cannot affect
   it. Otherwise copy with ordinary reads (also the portable Windows path).
3. Re-read the source stamp, reopen its pathname to detect replacement, and
   inspect the copy. Require identical headers, root arrays including commit
   version, lengths and source modification time across the operation; require
   the copy's committed root/header to equal the source's. **Do not merely
   compare the two top refs**: roots/slots may be reused (ABA), but transaction
   versions increase. A changing file is retried eight times, then unavailable.
4. Only after those checks does Realm core parse the private copy. No writer
   can reclaim or overwrite its pages. Source commits after validation do not
   affect it. A copy that spans any commit is rejected. Uncommitted writes with
   an unchanged committed root can only touch pages unreachable from that root
   under Realm's MVCC contract, so they do not tear the selected snapshot.

Assumptions: normal Realm-core commit ordering and monotonic transaction
numbers, coherent local filesystem reads, and no hostile raw writer restoring
old bytes/versions behind our back. Atomic replacement is detected by the
reopened stamp; equivalent replacement data is harmless. This is not a crash
recovery tool, an encrypted-Realm reader, or a guarantee for adversarial/coarse
network filesystems. Those are rejected or unsupported, not silently repaired.

## Resource and refresh policy

The source file is limited to 4 GiB; an individual serialized row to 4 MiB
(enforced while streaming, before allocation grows beyond that); serialized
selected-table content and conservatively estimated JSON heap to 256 MiB each.
These are acceptance bounds, not proportional unbounded caches. At most one
refresh runs at a time and one previous immutable index may still be retained
by active HTTP requests. Whole-process memory includes native mappings,
allocator overhead, the immutable index and temporary response serialization.
Maps are indexed by lowercase MD5 and SHA-256; metadata and set-file lists are
shared rather than duplicated per difficulty. MD5 map lookup is O(1), with
response assembly proportional to the selected set's files, not library size.
Filesystem notifications are debounced for 350 ms; metadata polling supplements
missed events and retries missing folders. Host context/settings are refreshed
every two seconds; failures retry after thirty seconds. Index publication is
atomic under a short RwLock; native scans happen on a blocking task.

## Data location and read API

For active lazer context, use parent of songs_dir (`<base>/files`). Otherwise
use nonempty `lazer_data_dir`, then XDG_DATA_HOME/osu (Linux, falling back to
`~/.local/share/osu`) or `%APPDATA%/osu` (Windows). `storage.ini` FullPath redirects
that base. Hashed paths are `<base>/files/<hash[0]>/<hash[0..2]>/<hash>`.
Only 64-character hexadecimal hashes can form paths. Skin reads resolve names
case-insensitively; canonical paths must stay under files/. Raw responses are
limited to 128 MiB and served as attachment-like binary with nosniff.

The tool implements the round-3 v1 status, MD5 beatmap, owned-set IDs, skins,
skin-file list/bytes and score-by-beatmap routes. Scores join BeatmapHash via the
installed beatmap's SHA-256; scores for absent/old map revisions cannot safely
be associated with a current MD5 and are omitted. Score fields: `id`,
`beatmap_md5`, `username`, `ruleset`, `mods` (Realm's JSON **string**), `total_score`,
`date` (UTC ISO8601 text), `replay_hash`, `replay_path` (both nullable).
There is no all-scores route. Missing library is 503; missing map/skin/file is
404. Built-in skins have zero files; no assets are fabricated.

## Reproducible checks

`cargo test -p realm-reader -p vosu-lazer-library` generates native synthetic
fixtures from `native/bridge.cpp` (no private data). Tests cover linked maps,
embedded named files, control-character strings, schema, custom storage, bad
input, HTTP response shapes and case-insensitive skin reads. A separate child
process executes 200 real Realm DB commits, updating map generation and score
total in one transaction while the reader asserts that every accepted copy
contains matching generations; atomic pathname replacement is tested as well.
`cargo run -p vosu-lazer-library --example audit -- /path/to/copied/lazer-data`
reports cold load, O(1) MD5 lookup, response assembly and five MD5-vs-file-digest
spot checks. An optional second argument supplies a read-only source asset dir
from which only those five maps and one skin.ini are copied into the temp tree.
Never commit client.realm, copied library data or their metadata.

## Building and using the provider

Build with the workspace Rust toolchain, CMake >= 3.22 and a C++17 compiler:
`cargo build --locked -p vosu-lazer-library`. The source archive is bundled;
no separate Realm installation or network SDK is needed. Windows uses MSVC,
or `cargo xwin` with clang-cl for the cross-check. Native static libraries are
linked into the service executable.

Load `tools/lazer-library` with `vosu --tool <absolute tool directory>`.
Its dashboard settings expose `lazer_data_dir`. The tool has no UI: library
access is a service/CLI utility, not another editor.

CLI examples: `vosux lazer-library status --json`,
`vosux lazer-library beatmap <md5> --json`, `vosux lazer-library online-ids`,
`vosux lazer-library skins`, `vosux lazer-library skin-files <id>`,
`vosux lazer-library scores <md5>`. Every command is a thin client of its
own supervised service and `--help` lists the supported commands.

