#!/usr/bin/env sh
# Builds every example calculator and refreshes the copies server-pp's tests
# load from tests/fixtures/calculators. Needs the wasm32-unknown-unknown Rust
# target (`rustup target add wasm32-unknown-unknown`) and bun.
set -eu
cd "$(dirname "$0")"
cargo build --release
(cd assemblyscript && bun install --frozen-lockfile && bun run build)
out=../tests/fixtures/calculators
mkdir -p "$out"
cp target/wasm32-unknown-unknown/release/rosu_reference.wasm "$out/"
cp target/wasm32-unknown-unknown/release/rust_example.wasm "$out/"
cp assemblyscript/build/assemblyscript_example.wasm "$out/"
ls -l "$out"
