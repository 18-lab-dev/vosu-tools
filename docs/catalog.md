# Release packages and catalogs

vosu installs tools and overlays from **catalog sources**; it embeds no tools. This page is the contract between `scripts/package.py` here (and the equivalent in vosu-overlays) and vosu's catalog client (`docs/tools/protocol.md` in the vosu repository).

## Sources

A source is either:

- a GitHub repository written `owner/repo` (optionally `owner/repo@tag`), resolved to `https://github.com/owner/repo/releases/latest/download/catalog.json` (or `/releases/download/<tag>/catalog.json`), or
- any HTTPS URL of a `catalog.json`.

vosu ships two default sources, enabled by default and removable or disableable like any other: `shiruviaa/vosu-tools` and `shiruviaa/vosu-overlays` (the organisation moves to `18-lab-dev` with vosu 1.2.0; GitHub redirects renamed repositories). Users add, remove, disable, and reorder sources in the dashboard settings. Every catalog entry is shown with its source. When two sources offer the same id, the earlier source wins and the later entry is marked as shadowed.

Trust: tools from the default official source install as source `official` and are trusted. Tools from any other source install as source `user` and stay untrusted until approved on the dashboard, exactly like manually installed tools. Overlays have no trust gate (installed overlays are third-party JavaScript on the overlay origin; see vosu ADR 0013/0016), and the dashboard keeps its existing third-party disclosure.

## Packages

One ZIP per tool per target triple, named `vosu-tool-<id>-<version>-<target>.zip`; one ZIP per overlay, named `vosu-overlay-<id>-<version>.zip`. Members sit at the archive root:

```
tool.toml | settings.json | web/dist/... | bin/vosu-<id>[.exe] | licenses/...      (tool)
index.html | settings.json | metadata.txt | assets/... | licenses/...              (overlay)
```

Rules vosu enforces before installing: regular files and directories only (no symlinks), no absolute or `..` paths, at most 10 000 entries and 512 MiB expanded, tools have `tool.toml` at the root with manifest `id` and `version` equal to the catalog entry, overlays have `index.html` at the root. vosu extracts into a temporary sibling of the destination (`<vosu data directory>/tools/<id>/` or `<static folder>/<id>/`), sets the executable bit on `bin/*` on Unix, and swaps it in atomically. Overlay settings values live outside the overlay folder, so updates keep them.

Supported tool targets: `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`. A tool without native code may publish one package with target `any`.

## catalog.json

```json
{
  "catalog_version": 1,
  "name": "18-LAB official tools",
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
  ],
  "overlays": [
    {
      "id": "ratings-timeline",
      "name": "Ratings timeline",
      "version": "0.1.0",
      "description": "…",
      "author": "18-LAB",
      "homepage": "https://github.com/shiruviaa/vosu-overlays/tree/main/overlays/ratings-timeline",
      "resolution": [640, 120],
      "preview": "https://…/ratings-timeline.png",
      "requires_tools": [{"id": "ratings", "version": ">=0.1.0"}],
      "package": {"url": "https://github.com/…/vosu-overlay-ratings-timeline-0.1.0.zip", "sha256": "<64 hex>", "size": 123456}
    }
  ]
}
```

`tools` and `overlays` are both optional. Every `url` must be HTTPS. `sha256` is of the ZIP bytes. Tool `requires` mirrors the manifest so vosu can offer dependencies in one install; overlay `requires_tools` lets vosu offer the tools an overlay needs (resolved across all enabled sources).
