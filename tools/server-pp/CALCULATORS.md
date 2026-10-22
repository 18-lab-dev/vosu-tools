# Custom pp calculators

server-pp runs user-supplied pp formulas next to its built-in server profiles. A calculator is a WebAssembly module written in any language that compiles to `wasm32` (Rust, AssemblyScript, C, Zig, …). server-pp computes the map's difficulty attributes and the score state with rosu-pp 4.0.1 (stable scoring). The module only turns those numbers into pp, so a formula stays small and fast and never parses beatmaps itself.

Modules run sandboxed in an interpreter. They have no imports, so they have no file, network, clock or host access. Every call has an instruction (fuel) budget and every module has a memory cap.

## Installing a calculator

1. Put the `.wasm` file in the calculator folder. By default that is `<vosu data directory>/tool-data/server-pp/calculators` (on Linux `~/.local/share/vosu/tool-data/server-pp/calculators`). server-pp creates this folder when it starts. The file name, lowercased, becomes the calculator id (`My Server.wasm` → `my-server`).
2. Optionally adjust the tool settings in the dashboard (Tools → Server pp calculator → Settings):

| Setting | Meaning |
| --- | --- |
| `calculators.folder` | Folder to scan instead of the default. |
| `calculators.files` | Extra module paths, one per line, optionally `id = path`. |
| `calculators.enabled` | Ids to enable, one per line; `*` (default) enables all. |
| `calculators.names` | `id = Display name` lines, overriding the module's own name. |
| `calculators.fuel` | Instruction budget per calculation, in millions (default 10). |
| `calculators.memory_mib` | Memory limit per module in MiB (default 16, 1–1024). |

Settings and files are re-read at most once per second, so a rebuilt module or a settings change applies to the next request without restarting anything. Compiled modules are cached by path, size and modification time.

3. Check the result. `vosux server-pp servers` (or `GET /v1/servers`) lists every discovered module as `kind: "custom"` with `status` `ready`, `disabled` or `error` and the exact load error. Then use the id like a built-in profile:

```sh
vosux server-pp servers
vosux server-pp map.osu --server my-server --mods HDDT --acc 98.5 --misses 2
vosux server-pp map.osu --server my-server --mode mania --acc 97   # convert
vosux server-pp --server my-server --json                          # live play
```

The API takes the same `server=<id>` on `/v1/pp`, `/v1/current` and `/v1/calculate`. Custom calculators accept every legacy mod including TD and ScoreV2 (built-ins do not), and they score osu! maps converted to other rulesets (`mode=`; live play uses the game's ruleset). The response looks like a built-in result plus:

- `kind: "custom"`, `name`, `version` and `md5` of the module.
- `breakdown` and `if_fc_breakdown` (label → value) when the module declares labels.
- `fuel`: instructions used by the current-score call.
- `base`: rosu-pp 4.0.1's own stable pp (`current`, `if_fc`) for exactly the attributes and score state the module received. Most server formulas start from that formula, so this shows how far the custom one deviates.
- `official`: vosu's own calculation, as for built-ins.

## ABI version 1

The layout is defined once in [`abi/v1.rs`](abi/v1.rs). The Rust helper crate `include!`s it and this section restates it.

### Exports

| Export | Type | Required | Meaning |
| --- | --- | --- | --- |
| `memory` | memory | yes | The module's linear memory. |
| `vosu_pp_abi_version` | `() -> i32` | yes | Must return `1`. |
| `vosu_pp_input` | `() -> i32` | yes | Address of a 512-byte input block (64 little-endian f64). |
| `vosu_pp_output` | `() -> i32` | yes | Address of a 128-byte output block (16 little-endian f64). |
| `vosu_pp_calculate` | `() -> i32` | yes | Reads the input block, writes the output block, returns a status. |
| `vosu_pp_info` | `() -> i32` | no | Address of a NUL-terminated UTF-8 JSON object (≤ 4096 bytes), read once at load. |
| `vosu_pp_error` | `() -> i32` | no | Address of a NUL-terminated UTF-8 message (≤ 512 bytes) for the last non-zero status. |

The module must not import anything. A start function is allowed and runs under the same fuel budget. The host may keep one instance alive across calls or create a fresh one at any time (it always does after a trap), so a module must not rely on state between calls. Calls into one module are never concurrent.

Status codes: `0` success, `1` unsupported ruleset, `2` unsupported mods, `3` invalid input; any other non-zero value is a module-defined failure. The host reports `vosu_pp_error`'s message with the status.

Output: slot 0 is pp, which must be finite and non-negative. Slots 1–15 are breakdown values in the order of the declared labels; unused slots may hold anything (NaN is reported as `null`).

### Info JSON

```json
{"name":"My server","version":"1.2.0","author":"me","description":"…",
 "rulesets":["osu","taiko"],
 "breakdown":{"osu":["aim","speed","accuracy"],"taiko":["difficulty"]}}
```

All fields are optional. `rulesets` defaults to all four (`osu`, `taiko`, `fruits`, `mania`); the host refuses other rulesets before calling the module. `breakdown` is either one array of up to 15 labels for every supported ruleset or an object keyed by ruleset.

### Input slots

Every value is an f64. Flags are 0 or 1, counts and mod bits are exact integers, and unknown values are NaN.

| Slot | Name | Meaning |
| --- | --- | --- |
| 0 | `ABI` | 1 |
| 1 | `RULESET` | 0 osu, 1 taiko, 2 catch, 3 mania (the ruleset being scored, after conversion) |
| 2 | `MODS` | Legacy mod bits (NC includes DT, PF includes SD) |
| 3 | `CLOCK_RATE` | 1.5 for DT/NC, 0.75 for HT, else 1 |
| 4 | `RELAX` | RX flag |
| 5 | `AUTOPILOT` | AP flag |
| 6 | `SCORE_V2` | V2 flag |
| 7 | `PROJECTION` | 0 = the score as played, 1 = if-FC projection (full map, achieved accuracy, no misses, max combo) |
| 8 | `ACCURACY` | Stable accuracy for the ruleset, 0–1 |
| 9 | `COMBO` | Score max combo (mania: the requested combo, else the map maximum) |
| 10–15 | `N300`, `N100`, `N50`, `N_GEKI`, `N_KATU`, `MISSES` | Judgements, see below |
| 16 | `PASSED_OBJECTS` | Objects judged so far (= total for a finished score) |
| 17 | `TOTAL_OBJECTS` | Hit objects in the (converted) map |
| 18–20 | `SLIDER_END_HITS`, `LARGE_TICK_HITS`, `SMALL_TICK_HITS` | osu! slider details as rosu-pp generates them for stable scores |
| 24 | `STARS` | Star rating at these mods (of the passed part for partial plays) |
| 25 | `MAX_COMBO` | Maximum combo at these mods (of the passed part) |
| 26 | `IS_CONVERT` | Map is a conversion |
| 27–30 | `AR`, `OD`, `CS`, `HP` | Map values after mods; AR and OD include the clock rate |
| 32 | `LIVE` | 1 for the game's live play (`/v1/current`) |
| 33 | `BEATMAP_ID` | From the .osu file, NaN when absent |
| 34 | `BEATMAPSET_ID` | From the .osu file, NaN when absent |
| 21–23, 31, 35–39, unused 40–63 | | Reserved, 0 |

Judgement slots by ruleset:

| Ruleset | `N300` | `N100` | `N50` | `N_GEKI` | `N_KATU` |
| --- | --- | --- | --- | --- | --- |
| osu | 300 | 100 | 50 | – | – |
| taiko | great | ok | – | – | – |
| catch | fruits | droplets | tiny droplets | – | missed tiny droplets |
| mania | 300 | 100 | 50 | 320 (MAX) | 200 |

When the request gives accuracy instead of judgements, the slots carry the judgements rosu-pp generates for it, exactly as rosu-pp's own calculation uses them.

Difficulty attributes start at slot 40 and use rosu-pp 4.0.1's field names:

| Slot | osu | taiko | catch | mania |
| --- | --- | --- | --- | --- |
| 40 | `aim` | `stamina` | `preempt` (ms) | `n_objects` |
| 41 | `aim_difficult_slider_count` | `rhythm` | `n_fruits` | `n_hold_notes` |
| 42 | `speed` | `color` | `n_droplets` | |
| 43 | `flashlight` | `reading` | `n_tiny_droplets` | |
| 44 | `slider_factor` | `great_hit_window` | | |
| 45 | `aim_top_weighted_slider_factor` | `ok_hit_window` | | |
| 46 | `speed_top_weighted_slider_factor` | `mono_stamina_factor` | | |
| 47 | `speed_note_count` | `mechanical_difficulty` | | |
| 48 | `aim_difficult_strain_count` | `consistency_factor` | | |
| 49 | `speed_difficult_strain_count` | | | |
| 50 | `nested_score_per_object` | | | |
| 51 | `legacy_score_base_multiplier` | | | |
| 52 | `maximum_legacy_combo_score` | | | |
| 53 | `ar` | | | |
| 54–56 | `great_hit_window`, `ok_hit_window`, `meh_hit_window` | | | |
| 57 | `hp` | | | |
| 58–61 | `n_circles`, `n_sliders`, `n_large_ticks`, `n_spinners` | | | |

Changing any number above is an ABI break. Additions go into reserved slots; anything else bumps the version.

## Writing a module

### Rust

[`examples/guest`](examples/guest) (`vosu-pp-guest`, no dependencies, `no_std`) provides typed access to the slots and an `export_calculator!` macro that generates every export. [`examples/rust-example`](examples/rust-example/src/lib.rs) is a complete osu! formula with RX/AP handling, a breakdown and error reporting:

```rust
use vosu_pp_guest::{Error, Input, Output, Ruleset, input, osu};

fn calculate(i: &Input) -> Result<Output, Error> {
    if i.ruleset() != Some(Ruleset::Osu) {
        return Err(Error::unsupported_ruleset("osu! only"));
    }
    let aim = i.get(osu::AIM);
    Ok(Output::new(aim * 100.0 * i.get(input::ACCURACY)).with(0, aim))
}

vosu_pp_guest::export_calculator! {
    info: r#"{"name":"Tiny","rulesets":["osu"],"breakdown":["aim"]}"#,
    calculate: calculate,
}
```

Build (the crate must be a `cdylib`):

```sh
rustup target add wasm32-unknown-unknown
cd tools/server-pp/examples
cargo build --release      # target/wasm32-unknown-unknown/release/rust_example.wasm
```

`std` is fine on `wasm32-unknown-unknown` (math functions are compiled in and add no imports). Use `panic = "abort"`.

### AssemblyScript

[`examples/assemblyscript`](examples/assemblyscript/assembly/index.ts) is an osu!mania formula. It reads and writes the blocks with `load<f64>`/`store<f64>` on static `memory.data` buffers.

```sh
cd tools/server-pp/examples/assemblyscript
bun install
bun run build              # build/assemblyscript_example.wasm
```

The build uses `--runtime stub --use abort=` so that the module imports nothing.

### Other languages

Any toolchain works as long as the result exports the functions above and imports nothing. For C with clang, use `--target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-dynamic`; without a libc you supply your own `pow`/`exp`/`log`. For Zig, use `-target wasm32-freestanding -dynamic -rdynamic`. To check a module, drop it in the folder and look at `vosux server-pp servers`.

### Fidelity reference

[`examples/rosu-reference`](examples/rosu-reference) ports rosu-pp 4.0.1's stable performance formulas for all four rulesets (MIT, notice in `LICENSE-rosu-pp`). server-pp's tests run it through the full host path:

- generated maps for every ruleset plus osu!→taiko/catch/mania conversions;
- 18 mod combinations;
- accuracy, judgement, combo-break and partial-play scores.

Two host details keep this exact.

- **Taiko scoring.** rosu-pp's generic `Performance::lazer(false)` does not reach taiko, which would score taiko HD as lazer. server-pp sets stable scoring on the difficulty settings instead, so taiko is classic like every other ruleset.
- **Score state.** The state handed to the module is generated once from the request, the same state rosu-pp's own `calculate` derives. Regenerating from stored judgements can differ, as observed with catch droplets.

Each result is compared with `base`, rosu-pp's own result for the same input. The largest relative difference is about 7e-16, within a few floating-point ulps (the module's `pow`/`exp` come from Rust's libm, not the platform C library); the test fails above 1e-12. An opt-in test does the same over a local Songs folder. On the development machine it covered 18,932 maps (531 osu!, 4,441 taiko, 32 catch, 13,928 mania): 7 mod combinations × 2 scores × current/if-FC, 530,096 values, with a worst relative difference of 3.6e-15.

```sh
SERVER_PP_FIDELITY_DIR=~/path/to/Songs cargo test --release -p vosu-server-pp -- --ignored --nocapture real_maps
```

`examples/build.sh` rebuilds all three examples and refreshes the copies under `tests/fixtures/calculators` that the tests load.

## Limits and failure handling

- **Fuel.** Each `vosu_pp_calculate` call (and the start function) gets `calculators.fuel` million units (wasmi's instruction-based metering). Exhausting it stops the call with `exceeded its fuel budget …`. Fuel is deterministic, so the same input always uses the same amount; `fuel` in the response shows actual use (the reference osu! formula uses about 0.1 million). The default budget stops a module that never returns after about 6 ms (see the benchmark below).
- **Memory.** Initial and grown memory are capped at `calculators.memory_mib`. A module whose initial memory is larger fails to load; `memory.grow` past the cap returns -1 to the module. Tables are capped at 65,536 elements.
- **Size.** Modules larger than 16 MiB are refused.
- **Traps** (unreachable, out-of-bounds access, fuel) discard the instance. The next call starts fresh.
- **Bad output.** A non-finite or negative pp is an error, never a number.

## Runtime choice

The interpreter is [wasmi](https://github.com/wasmi-labs/wasmi) 2.0 (MIT/Apache-2.0, pure Rust), built without its `wat` and `memory64` features. It was measured against wasmtime 49 (Cranelift JIT) with the reference module, release builds, on the development machine (Linux x86-64):

| | wasmi 2.0 | wasmtime 49 |
| --- | --- | --- |
| Module compile | 0.10–0.18 ms | 13–32 ms |
| Instantiate | 0.26–2.4 ms | 0.05–0.07 ms |
| Call, osu! reference formula | ≈ 5.1 µs | ≈ 1.2 µs |
| Call, Rust example | ≈ 1.9 µs | ≈ 0.8 µs |
| Release binary growth | +2.1 MB | +9.2 MB |
| Clean release build | 15 s | 81 s |

These numbers come from a standalone harness with a synthetic input. A request also computes rosu-pp difficulty attributes for a map unless they are cached (see below). That costs far more than either runtime's call, so the JIT's few-µs advantage barely shows in request latency. wasmi wins everything else:

- a 4× smaller binary;
- 100× faster module loading, which matters for hot reload;
- no generated machine code, so a smaller attack surface and no W^X/JIT restrictions on locked-down Windows machines;
- deterministic fuel metering;
- the same pure-Rust build on Linux and Windows.

Both are permissively licensed. Every crate in wasmi's tree offers MIT or Apache-2.0 without an exception clause.

Measured through server-pp (`cargo test --release -p vosu-server-pp -- --ignored --nocapture per_call`) on the same machine (Ryzen 9 9950X3D, Linux), with the generated 360-object test maps and HDDT:

| Module | Load (compile + validate + instantiate) | Module call | Request, map already cached | Request, new map | Live partial play |
| --- | --- | --- | --- | --- | --- |
| rosu-pp reference (osu) | 0.27 ms | 2.3 µs | 8.4 µs | 0.62 ms | 0.19 ms |
| Rust example (osu) | 0.23 ms | 0.58 µs | 4.2 µs | 0.53 ms | 0.17 ms |
| AssemblyScript example (mania) | 0.14 ms | 0.29 µs | 2.0 µs | 0.31 ms | 0.06 ms |

A request makes two module calls (current score and if-FC projection).

- **Cached map.** The rosu-pp difficulty for the full map at those mods and ruleset is computed once per parsed map (up to 64 combinations, kept with server-pp's map cache) and reused, including by the if-FC projection.
- **New map.** Includes parsing the .osu file.
- **Live partial play.** Recomputes the difficulty of the passed part on every update, as rosu-pp's own partial calculation does.

A module that never returns is stopped by the default 10-million fuel budget after about 6 ms.
