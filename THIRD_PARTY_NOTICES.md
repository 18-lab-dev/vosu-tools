# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## Map preview and shared render-core

- vgpu 0.6.0 and its bundled @vgpu runtime modules: MIT, Copyright (c) 2025 Vercel, Inc.; https://github.com/vercel-labs/vgpu. License shipped in `tools/map-preview/licenses/vgpu-MIT.txt`. Used for WebGPU device initialization and lifecycle; rendering uses an original WGSL instance pipeline.
- No third-party skin images, audio, beatmaps, or fonts are distributed by this tool. User-selected skin and map data remain user-owned.
