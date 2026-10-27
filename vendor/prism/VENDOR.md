# Prism (vendored)

Prism 0.25, mania-tracker's MSD-scale calculator for osu!mania 6K–8K, from
[aleju03/mania-hub](https://github.com/aleju03/mania-hub/tree/9ab23951357831a0dbbc48da20dd2140f22bd850/algorithms/prism)
at `9ab23951357831a0dbbc48da20dd2140f22bd850` (`algorithms/prism`), retrieved
2026-10-26. License: MIT, copyright (c) 2026 aleju03 (`LICENSE`, copied from the
repository root; a copy sits in each crate so packaging retains it).

Files are byte-identical to upstream (`vendor-files.txt` lists their SHA-256).
Only the crates Prism links are kept: `jsmath`, `chart-parser`, `dan-core`,
`prism`; upstream's `ln-skill` crate and `.gitignore` are omitted. The root
workspace manifest excludes this directory, so these crates build as plain path
dependencies of `tools/map-analysis`.

`tools/map-analysis/tests/reference/prism/generate.py` re-downloads the pinned
files, checks the vendored copies against them, builds the pristine crates and
writes the differential reference used by `tests/prism.rs`.

`rustfmt.toml` here (ours) disables formatting so `cargo fmt --all` leaves the
vendored sources byte-identical.

On Windows, `jsmath`'s declared POSIX `clock_gettime` (used only by the
uncalled `js::thread_cpu_seconds`) is supplied by
`tools/map-analysis/src/windows_clock.rs`; nothing here is patched.
`.gitattributes` marks these files `-text`, so Git for Windows keeps them
byte-identical too (LF, as upstream).

Dev builds disable overflow checks for `jsmath` (root `Cargo.toml`): its
TimSort port relies on release-mode wrapping, and upstream ships release builds.
