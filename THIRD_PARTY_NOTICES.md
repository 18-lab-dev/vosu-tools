# Third-party notices

Each section records third-party code, data, or assets included in this repository or its release packages, with its license and source. Rust and JavaScript package dependencies are resolved by `Cargo.lock` and `bun.lock`; their license texts ship in each release package's `licenses/` directory.

## skin.ini editor

- Monaco Editor 0.52.2, Microsoft Corporation, MIT: https://github.com/microsoft/monaco-editor. License: `tools/skin-editor/licenses/monaco-editor-MIT.txt`. Editor and worker are bundled offline.
- `packages/skin-spec/spec.json` contains interoperability facts extracted from the osu! wiki skin.ini reference at revision `c9fa3ff277dba4c620d4731fd2c3fbb74770c20b`: https://github.com/ppy/osu-wiki/blob/c9fa3ff277dba4c620d4731fd2c3fbb74770c20b/wiki/Skinning/skin.ini/en.md. Wiki prose and images (CC-BY-NC-4.0) are not redistributed; hover wording is independently authored. Regenerate factual fields with `bun packages/skin-spec/generate.ts`.
