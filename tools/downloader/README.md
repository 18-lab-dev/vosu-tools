# Beatmap downloader

18-LAB's UI + service for vosu 1.2.0. Build with `cargo build -p vosu-downloader` and `bun run --cwd tools/downloader/web build`, then launch `vosu --tool tools/downloader` in an isolated development environment. The manifest uses Cargo's development binary fallback; release packages place the executable in `bin/`.

## Discovery

- Search all four rulesets, exact creator, status, star range, submitted date, length (seconds), and BPM. The mirror's supported query/mode/status/amount/offset parameters are sent to the server; the full filter set is checked locally against returned difficulties on each page. **A sparse or empty filtered page is not an exhaustive search.** Advance the mirror offset or official cursor. Matching difficulty conditions must all hold on the same difficulty.
- Same mapper and ±1-star similarity use the difficulty selected in vosu. History searches the creators of your three most recently played maps from a stable database snapshot.
- Optional mania MSD similarity calls the Ratings tool's read-only cached endpoints, without a hard dependency or writes. It restricts the ±1-star candidate window to cached difficulties within ±2 overall MSD. Uncached/unsupported candidates are excluded and counted, not assigned invented MSD values. If the current rating/tool is unavailable, it explicitly falls back to stars.
- Paste positive **set IDs**, `/beatmapsets/` or `/s/` links; `/beatmaps/` or `/b/` links resolve difficulty IDs to sets. Up to 50 IDs per operation, with deduplication.
- Official beatmap pack list/details require your own osu! API credentials. Select individual sets for downloading from the chosen mirror; the tool does not scrape pack archives or redistribute them.
- Searches and filter presets persist in service settings. Source enablement, priority, request spacing, parallelism, and size caps are configurable. There is no automatic mirror failover.

## Providers and credentials

**osu.direct** is the only preconfigured mirror. Its operator terms expressly permit automatic downloading but prohibit API spamming. Its OpenAPI documents public search and download APIs, including `noVideo=true` (no-video **if available**, not a guarantee). Checked 2026-10-21:

- https://osu.direct/tos — section 4: “Automatic downloading is allowed, but spamming API routes will lead to a ban.”
- https://osu.direct/api/docs and https://osu.direct/api/docs/json — public base limit 120/minute, burst 25/5 seconds; download budget 200/hour, 8 GiB/day, up to 5 concurrent per IP. We intentionally use much lower defaults: one file at a time and ≥2 seconds between requests.

Custom mirrors must implement the osu.direct API shape. Their settings must include an HTTPS origin, terms URL, and an explicit `automation_permitted` assertion from the user who reviewed those terms. **Do not enable an adapter if the operator forbids automation or its terms are unknown.** No adapters for Mino, Nerinyan, BeatConnect, Sayobot or Chimu ship: authorization/contracts were not verified. Sources are selected explicitly or by enabled priority at queue creation. Queued jobs retain that source configuration; changing settings affects new requests/jobs, not the already-authorized queue.

Official metadata uses the public client-credentials grant with the user's own registered client ID and secret. No credential is bundled. Settings are stored by the service as a private-permission file in its vosu tool data directory, not browser storage; they are **not keychain-encrypted**. GET routes return only whether credentials are configured. The secret is not read back or logged. Blank credential fields preserve existing values. Tokens are memory-only. Metadata URLs never contain credentials. Client-credential authorization is not used for official downloads (`OAuth lazer` is not a public-download permission).

- https://osu.ppy.sh/docs/index.html#terms-of-use — ≤60 requests/minute, caching, exponential backoff, no harvesting. This tool paces official requests at ≥1 second and caches metadata for 10 minutes.
- https://osu.ppy.sh/docs/index.html#authentication
- Official search parameters `q`, `m`, `s`, and query operators were cross-checked against ppy/osu-web's `BeatmapsetSearchRequestParams.php` on 2026-10-21 as an API compatibility reference only; no AGPL code was copied. The official endpoint documentation still marks search parameter documentation TODO. Client-side filters remain authoritative.

Retries are limited to four attempts for connection errors, HTTP 429 and server errors. Both numeric and HTTP-date Retry-After values defer requests to the same source; ordinary permanent errors are not retried. Credentials and URL query strings never appear in network errors. Results only contain official beatmap links opened with `noopener`.

## Queue and import

New queues and queues recovered after a service restart are paused. Queue creation returns job IDs; inspect `/v1/jobs/<id>`, cancel with DELETE. Search/library work also uses cancellable 202 jobs. Resume is explicit. Pause interrupts active streaming at the next chunk; a file restarts from zero on resume. **Logical queue resume is supported; byte-range continuation is deliberately not assumed across mutable mirror archives.** Transient HTTP request failures have bounded retry; interrupted response streams are marked failed and can be retried explicitly.

Files stream into a temporary sibling and must fit the configured compressed-size cap (64 MiB default, maximum 128 MiB), match Content-Length when supplied, parse as ZIP, have safe entry names, contain `.osu` files, pass every entry's decompression/CRC check, and match all available beatmap MD5s from metadata. Expanded size is bounded to 512 MiB and entries to 10,000. No files are extracted. A SHA-256 is recorded and rechecked before import. Metadata hashes cover `.osu` files, not the entire audio/video archive; SHA-256 records the bytes received and does not authenticate a mirror. Downloads have no automatic import.

Stable import requires explicit confirmation of the exact Songs destination. It atomically places an `.osz` without overwriting anything. **Press F5 in stable Song Select or restart stable to import.** Existing databases and collections are never edited. Optional collection creation is omitted: a safe cross-process exclusion/atomic replace contract with a running stable client is not established.

Lazer import opens the completed archive with the OS file handler (`xdg-open` / `explorer.exe`); choose lazer if prompted or drag the archive into lazer. No import-completion assertion is made. There is no supported local library-enumeration API; the tool does not query, lock or write internal Realm storage. Lazer ownership is unknown, and tool download history is not treated as proof a map is still installed.

Stable ownership uses positive set IDs and difficulty MD5s from a temporary copy of `osu!.db`, never folder-name guesses. `scores.db` supplies history, `collection.db` is read-only. Refresh the snapshot after importing; if snapshot parsing fails the UI reports incomplete/unknown ownership. Databases are never modified.

## Verification

`cargo test --locked -p osu-db -p vosu-downloader` covers synthetic legacy/modern DB fixtures, all truncated prefixes, size/count bounds, ownership, query construction, ID parsing, numeric/mode filtering, rate limiting, durable queue recovery/deduplication, and archive checksums. To also parse read-only temporary copies of real databases, set `OSU_DB_FIXTURE_DIR` to a stable installation directory; tests copy all three files into a fresh temporary directory first.

Use only isolated HOME/XDG directories and the reserved 25850/25851 test listeners for headless dev smoke runs. Never target the user's running daemon or import into the real Songs directory during development. Screenshots/evidence belong under `/tmp/vosu-tools-evidence/downloader/`.
