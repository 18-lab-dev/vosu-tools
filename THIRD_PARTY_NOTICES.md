# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## Map preview and shared render-core

- vgpu 0.6.0 and its bundled @vgpu runtime modules: MIT, Copyright (c) 2025 Vercel, Inc.; https://github.com/vercel-labs/vgpu. License shipped in `tools/map-preview/licenses/vgpu-MIT.txt`. Used for WebGPU device initialization and lifecycle; rendering uses an original WGSL instance pipeline.
- No third-party skin images, audio, beatmaps, or fonts are distributed by this tool. User-selected skin and map data remain user-owned.

## Replay renderer, replay and render-export

- LZMA-JS (`lzma` 2.3.2): MIT, Copyright (c) 2015 Nathan Rugg; https://github.com/nmrugg/LZMA-JS. Unmodified decompression dependency.
- webm-muxer 5.1.4: MIT, Copyright (c) Vanilagy; https://github.com/Vanilagy/webm-muxer. WebCodecs chunk muxing; no encoders or codecs are bundled.
- Native dependencies: clap (MIT OR Apache-2.0), uuid (MIT OR Apache-2.0), md-5 (MIT OR Apache-2.0), walkdir (Unlicense OR MIT; choose MIT), plus the shared vosu-tool-sdk. Release packaging includes the selected permissive dependency license texts.
- Chromium and FFmpeg are external user-installed executables, never bundled or linked. Set `VOSU_RENDER_CHROMIUM` / `VOSU_RENDER_FFMPEG` to their executable paths when not on PATH. Native MP4 uses VP9 (libvpx) and AAC, not libx264. Choose an LGPL-only FFmpeg build when distributing a runtime separately; its exact build configuration and licensing are the distributor's responsibility.
- No beatmaps, replays, skins, audio or third-party overlay content are distributed. Tests use synthetic inputs or explicit temporary copies of locally installed user files.
