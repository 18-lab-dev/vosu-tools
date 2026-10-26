# Server pp calculator

Service, CLI and browser UI for **recorded public calculator snapshots**, not a promise of parity with a private server's current production deployment, plus **your own pp formulas** as sandboxed WebAssembly calculators. No account credentials, remote score submission, or map downloads are used.

![Server pp calculator](../../docs/screenshots/server-pp.webp)

## Custom calculators

Drop a `.wasm` calculator into the calculator folder (`<vosu data directory>/tool-data/server-pp/calculators` by default) and use its file name as `--server`/`server=`. Any language that compiles to WebAssembly works. server-pp hands the module rosu-pp 4.0.1 difficulty attributes and the score state, and the module returns pp plus an optional breakdown. The dashboard's tool settings choose the folder, extra files, enabled ids, display names and the fuel/memory limits. The ABI, the settings, Rust and AssemblyScript examples, the fidelity reference and the runtime benchmarks are in [CALCULATORS.md](CALCULATORS.md).

## Browser UI

The results table compares every calculator on the map selected in osu!. It follows song select live, and as a "what if" it applies the mods, accuracy, misses, combo and ruleset in the results toolbar. **Live play** shows the score as it stands while you play. A tab opened from the dashboard can also score an `.osu` file (top bar) instead of the selected map. Each row shows pp, if-FC pp, the difference from vosu's official pp, stars and the calculator's breakdown. The side panel lists built-in profiles and every discovered custom calculator with its status, load error, version, rulesets and file, plus the calculator folder and limits; the gear in the top bar opens the tool's dashboard settings. The page uses vosu's shared design system (`/tools/_host/v1/theme.css`).

## Provenance and coverage

| Profile | Recorded source | Rulesets / policy | Difference from official |
| --- | --- | --- | --- |
| `akatsuki` | [akatsuki-pp c0e499ec3ac138c7cc329771fc70992de39fbb77](https://github.com/osuAkatsuki/akatsuki-pp-rs/tree/c0e499ec3ac138c7cc329771fc70992de39fbb77) | Native osu!, taiko, catch, mania; vanilla all, RX osu/taiko/catch, AP osu | osu! RX uses custom `osu_2019`; remaining scores use the fork's modern stable performance builder, matching the public service dispatch |
| `mamestagram` | [mames-pp 11f4c0443f8dd777a356cad1d06e675971ec0a4e](https://github.com/Mamestagram/mamestagram-pp-rs/tree/11f4c0443f8dd777a356cad1d06e675971ec0a4e) | Native four rulesets, vanilla stable scoring only | Historical rosu-pp fork, not vosu's current official engine; differences depend on map and score |

Akatsuki's [public service callsite at 2e89b9c9d4365e98e2b0d98ba506862db5e92c60](https://github.com/osuAkatsuki/performance-service/blob/2e89b9c9d4365e98e2b0d98ba506862db5e92c60/src/api/routes/calculate.rs) pins the Akatsuki revision above. In particular, RX is **not** routed through ordinary upstream rosu-pp. AP uses the fork's ordinary performance path, exactly as this callsite does. Raw library f64 pp is exposed (the service callsite separately rounds f32 to two decimals); no account-total aggregation or eligibility is reproduced. Exact deployed revisions are unverified for both servers. Mamestagram's public calculator is identifiable, but its live server dependency and score policy are not verified: the profile explicitly represents the library, not an asserted live backend.

All built-in calculations use stable score semantics (`lazer(false)`). Accepted legacy mods: NM/NF/EZ/HD/HR/SD/DT/NC/HT/FL/SO/PF plus the server/ruleset RX/AP coverage above. Acronyms may be concatenated or separated by spaces, commas or `+`; legacy integer bits are accepted with the same validation. For built-in profiles, ScoreV2, key overrides, automation, lazer-specific mods, unknown bits, incompatible mods and ruleset conversions are rejected, not approximated (custom calculators additionally receive TD and ScoreV2 and may score converts, see CALCULATORS.md). Mamestagram RX/AP are rejected because its server policies are unverified. Akatsuki's legacy RX accuracy generator has representability/unsigned-underflow bugs on some accuracy/miss combinations (especially small maps); those inputs return a clear error instead of changing the algorithm. Supply exact hit judgements where possible.

Unsupported profiles are returned with reasons by `servers`: Ripple documents custom standard RX, but no current identifiable source/revision; its classic taiko/catch version is also unpinned. Gatari, Kurikku and Titanic have no verified current implementation/revision. `bancho.py` is a framework, not a particular deployed calculator. None is silently replaced by official pp or a guessed multiplier.

## CLI

```sh
vosux server-pp servers --json
vosux server-pp /path/to/map.osu --server akatsuki --mods RX --acc 98.5 --json
cat map.osu | vosux server-pp - --server mamestagram --acc 99 --combo 1200 --misses 2
vosux server-pp --server akatsuki --json   # selected map + current live score
vosux server-pp map.osu --server my-server --mode mania --acc 97   # custom calculator, converted map
```

On Windows use `vosu x server-pp ...` when no `vosux` link exists. CLI commands are thin clients of the supervised service. File/stdin bytes are uploaded through its authenticated write route and share the cache. Human output includes official pp details and an explicit deployment warning (custom results add the module's breakdown). JSON returns the raw comparison response. `--mods`, `--acc`, `--combo`, `--misses` and `--mode` apply to file/stdin; live mode always takes the game's actual state. `servers` lists built-in profiles and every discovered custom calculator with its status or load error.

## Overlay/service API

All paths below are relative to `/tools/server-pp/api`; vosu authenticates its service connection. GET routes are overlay-readable; POST requires the tool's write session or CLI token.

- `GET /v1/servers`: supported source profiles (`kind: "builtin"`), exact versions, coverage, deviations, deployment warning, unsupported reasons; custom calculators (`kind: "custom"`, `status` ready/disabled/error, name, version, rulesets, breakdown labels, md5, path, error) and the effective calculator configuration under `calculators`.
- `GET /v1/current?server=akatsuki`: fetch `/json/v2`, selected map bytes from `/files/beatmap/file`, live numeric mods, combo and per-ruleset judgements. Missing live data returns an error, never synthetic pp; converts are an error for built-in profiles and scored as the played ruleset by custom calculators. Catch progress counts fruits/droplets, not tiny droplets; standard progress does not double-count geki/katu.
- `GET /v1/pp?server=akatsuki&checksum=<md5>&mods=RX&acc=98.5&combo=1000&misses=1`: calculate a cached or currently selected map. Unknown checksum returns 404, not a different map. Omit checksum to use the selected map. There is no network map lookup.
- `POST /v1/calculate?server=akatsuki&mods=HD&acc=99`: raw `.osu` body, at most 1 MiB. Optional checksum must match actual MD5. Exact score parameters `n300`, `n100`, `n50`, `n_geki`, `n_katu`, `misses`, `combo`, `passed_objects` are accepted; accuracy and judgements are mutually exclusive. `mode=osu|taiko|fruits|mania` scores a conversion (custom calculators only) and is passed to the official comparison.

Responses contain `kind`, `current`, `if_fc`, `stars`, checksum, ruleset, mods, server revision, deployment flag, and `official`; custom results add `name`, `md5`, `breakdown`, `if_fc_breakdown`, `fuel` and `base` (rosu-pp 4.0.1's stable pp for the same inputs). `current` respects passed objects and current combo. `if_fc` is explicitly a **full-map projection at achieved accuracy, zero misses and maximum combo**, not a claim about future accuracy. With exact judgements it derives ruleset-specific achieved accuracy. Official comparison invokes vosu's `/api/calculate/pp` with identical stable score parameters against a temporary copy in the tool cache, removed after the request. An unavailable host comparison is reported as `official.available=false` with a reason; it is never replaced with an estimate.

The bounded 32-entry LRU cache reuses parsed map bytes partitioned by `(server, checksum, mods)`. Scores are not cached, so new hit counts/accuracy cannot reuse stale pp. Evicted arbitrary maps must be uploaded again. Caches are memory-only and reset with service restart.

## Verification and reference values

`cargo test --locked -p vosu-server-pp` executes each **actual pinned server library independently** as the reference oracle on the included original deterministic map in each native ruleset, for NM/HD/DT and verified RX/AP combinations. The adapter's full-precision current pp must match to `1e-10`. Expected values are therefore generated directly at the recorded revisions, not borrowed from the official calculator or invented constants. Additional tests cover incompatible/unverified mods including ScoreV2, LRU partitioning/eviction, live judgement translation and official API parameter spelling, FC projection, and the legacy RX underflow guard. No private server connection is required. The custom calculator tests (sandbox limits, malformed modules, settings, discovery and reload, API, and the rosu-pp fidelity reference) are described in CALCULATORS.md.

Both calculator dependencies are unmodified MIT libraries; original license text is in `licenses/calculators-MIT.txt`. Cargo.lock pins the entire resolution, including Mamestagram's transitive Git rosu-map dependency. This tool does not import server application code.
