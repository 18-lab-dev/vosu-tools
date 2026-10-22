# Release packages and the official catalog

vosu installs official tools from this repository's GitHub releases; it embeds none. This page is the contract between `scripts/package.py` here and vosu's tool catalog (`docs/tools/protocol.md` in the vosu repository).

## Package

One ZIP per tool per target triple, named `vosu-tool-<id>-<version>-<target>.zip`. Members are the tool directory's contents at the archive root:

```
tool.toml
settings.json        (optional)
web/dist/...         (optional; the manifest's [ui].root is "web/dist")
bin/vosu-<id>[.exe]  (optional; service and/or CLI executable)
licenses/...         (third-party notices for everything the package contains)
```

Rules vosu enforces before installing: regular files and directories only (no symlinks), no absolute or `..` paths, at most 10 000 entries and 512 MiB expanded, `tool.toml` present at the root, manifest `id` and `version` equal to the catalog entry. vosu extracts into a temporary sibling of `<vosu data directory>/tools/<id>/`, sets the executable bit on `bin/*` on Unix, and swaps it in atomically.

Supported targets: `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`. A tool without native code may publish one package with target `any`.

## Catalog

Every release publishes `catalog.json`, fetched by vosu from `https://github.com/shiruviaa/vosu-tools/releases/latest/download/catalog.json` (the organisation moves to `18-lab-dev` with vosu 1.2.0; GitHub redirects renamed repositories).

```json
{
  "catalog_version": 1,
  "published": "2026-10-21T00:00:00Z",
  "tools": [
    {
      "id": "practice",
      "name": "osu! practice tool",
      "version": "0.1.0",
      "description": "…",
      "author": "18-LAB",
      "homepage": "https://github.com/shiruviaa/vosu-tools/tree/main/tools/practice",
      "protocol": 1,
      "interfaces": ["ui", "service", "cli"],
      "requires": [{"id": "ratings", "version": ">=0.1.0"}],
      "packages": {
        "x86_64-pc-windows-msvc": {"url": "https://github.com/…/vosu-tool-practice-0.1.0-x86_64-pc-windows-msvc.zip", "sha256": "<64 hex>", "size": 1234567},
        "x86_64-unknown-linux-gnu": {"url": "…", "sha256": "…", "size": 1234567}
      }
    }
  ]
}
```

`url` must be HTTPS. `sha256` is of the ZIP bytes. `requires` mirrors the manifest so vosu can offer dependencies in one install.
