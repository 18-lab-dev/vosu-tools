# Release packages and catalogs

vosu installs tools and overlays from **catalog sources**; it embeds no tools. This page is the contract between `scripts/package.py` here and vosu's catalog client (`docs/tools/protocol.md` in the vosu repository).

## Sources

A source is either:

- a GitHub repository written `owner/repo` (optionally `owner/repo@tag`), resolved to `https://github.com/owner/repo/releases/latest/download/catalog.json` (or `/releases/download/<tag>/catalog.json`), or
- any HTTPS URL of a `catalog.json`.

vosu ships two default sources, enabled by default and removable or disableable like any other: `18-lab-dev/vosu-tools` and `18-lab-dev/vosulay`. Users add, remove, disable, and reorder sources in the dashboard settings. Every catalog entry is shown with its source. When two sources offer the same id, the earlier source wins and the later entry is marked as shadowed. Overlays remain available through the existing tosu community catalog on the Available page; the private vosu-overlays repository is not a default catalog source or an installation source.

Trust: tools from the exact default `18-lab-dev/vosu-tools` or `18-lab-dev/vosulay` source install as source `official` and are trusted, including if that identical source string is removed and re-added. Tagged, differently cased, or HTTPS-URL variants, and all other sources, install tools as `user`, untrusted until approved. Overlays have no trust gate (installed overlays are third-party JavaScript on the overlay origin; see vosu ADR 0013/0016), and the dashboard keeps its existing third-party disclosure.

## Packages

One ZIP per tool per target triple, named `vosu-tool-<id>-<version>-<target>.zip`; one ZIP per overlay, named `vosu-overlay-<id>-<version>.zip`. Members sit at the archive root:

```
tool.toml | settings.json | web/dist/... | bin/vosu-<id>[.exe] | licenses/...      (tool)
index.html | settings.json | metadata.txt | assets/... | licenses/...              (overlay)
```

Rules vosu enforces before installing: regular files and directories only (no symlinks), no absolute or `..` paths, at most 10 000 entries and 512 MiB expanded, tools have `tool.toml` at the root with manifest `id` and `version` equal to the catalog entry, overlays have `index.html` at the root. vosu extracts into a temporary sibling of the destination (`<vosu data directory>/tools/<id>/` or `<static folder>/<id>/`), sets the executable bit on `bin/*` on Unix, and swaps it in atomically. Overlay settings values live outside the overlay folder, so updates keep them.

Supported tool targets: `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`. A tool without native code may publish one package with target `any`.

Official tool manifests must declare `icon` and `banner`, relative paths within the tool directory. Icons are square SVG or PNG, at least 256×256. Banners accept PNG, JPEG, WebP or SVG and must be 3:1 (±2%; recommended 1200×400). Each file must be nonempty and at most 1 MiB; extensions must match image headers. Symlinks and escaping paths are rejected. Artwork is copied into the ZIP at its manifest path, and published separately as `vosu-tool-<id>-icon.<ext>` and `vosu-tool-<id>-banner.<ext>`. First-party art follows the [tool art rules](art.md).

Catalog tool and overlay entries may include HTTPS `icon_url` and `banner_url` fields for artwork before installation. Overlay metadata may declare `icon` and `banner` with the same constraints; otherwise packaging discovers a single `icon.*` / `banner.*` in the overlay directory. Overlay art is optional, stays in the ZIP, and is published as `vosu-overlay-<id>-icon.<ext>` / `vosu-overlay-<id>-banner.<ext>`. Multiple matching files require explicit metadata. Art assets are versioned by release URL rather than filename.

### Renamed tools

Native tools may declare `replaces = ["old-id"]` under
`[package.metadata.vosu-tools]` in their Cargo.toml. Packaging validates these
IDs and writes the array to the catalog entry only. It never adds this field to
the shipped tool.toml, whose schema remains compatible with vosu 1.2.0/1.2.1.
A supporting vosu migrates an installed old ID only from the same trusted catalog
source. Existing dependency IDs can be satisfied by the installed replacement;
first-party dependencies here name the new ID directly.

Map analysis replaces `mania-ratings`. Older vosu ignores the catalog field:
install Map analysis manually as a new tool (the old tool remains usable but no
longer updates), or upgrade vosu to preserve data and settings automatically.



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
      "version": "0.1.2",
      "description": "…",
      "author": "18-LAB",
      "homepage": "https://github.com/18-lab-dev/vosu-tools/tree/main/tools/practice",
      "icon_url": "https://github.com/…/vosu-tool-practice-icon.svg",
      "banner_url": "https://github.com/…/vosu-tool-practice-banner.svg",
      "protocol": 1,
      "interfaces": ["ui", "cli"],
      "requires": [{"id": "map-analysis", "version": ">=0.1.0"}],
      "packages": {
        "x86_64-pc-windows-msvc": {"url": "https://github.com/…/vosu-tool-practice-0.1.2-x86_64-pc-windows-msvc.zip", "sha256": "<64 hex>", "size": 1234567},
        "x86_64-unknown-linux-gnu": {"url": "…", "sha256": "…", "size": 1234567}
      }
    }
  ],
  "overlays": [
    {
      "id": "ratings-timeline",
      "name": "Map analysis timeline",
      "version": "0.1.0",
      "description": "…",
      "author": "18-LAB",
      "homepage": "https://example.org/overlays/ratings-timeline",
      "resolution": [640, 120],
      "preview": "https://…/ratings-timeline.png",
      "icon_url": "https://…/vosu-overlay-ratings-timeline-icon.png",
      "banner_url": "https://…/vosu-overlay-ratings-timeline-banner.png",
      "requires_tools": [{"id": "map-analysis", "version": ">=0.1.0"}],
      "package": {"url": "https://github.com/…/vosu-overlay-ratings-timeline-0.1.0.zip", "sha256": "<64 hex>", "size": 123456}
    }
  ]
}
```

`tools` and `overlays` are both optional. Every `url` must be HTTPS. `sha256` is of the ZIP bytes. Tool `requires` mirrors the manifest so vosu can offer dependencies in one install; overlay `requires_tools` lets vosu offer the tools an overlay needs (resolved across all enabled sources).

## Building and merging catalogs

`python scripts/package.py --target <triple> --base-url https://…/releases/download/<tag>` builds every native tool with `cargo build --release --locked --target <triple> -p <package>` and every UI with `bun run build --sourcemap hidden`. Run `bun install --frozen-lockfile` first. The source manifest's UI root must be `web/dist`; Windows packages rewrite service/CLI executable names to `.exe`. UI-only tools use the `any` target. Each archive is validated before replacement, with sorted regular-file entries, 1980 timestamps and explicit Unix modes (0755 for `bin/*`, 0644 otherwise).

`--out` selects the output directory, `--name` and `--published` set catalog metadata, and `SOURCE_DATE_EPOCH` supplies the default publication timestamp for reproducible runs. `--dry-run` validates manifests and prints commands without building/writing. `--skip-build` consumes already-built release binaries and hidden-sourcemap UI output. `--native-only` omits universal UI-only packages so release CI publishes those once, from Linux.

Tool and overlay ZIP serialization also mirrors vosu 1.2.0's whole-file end-record preflight, including ZIP64 locators and its 10,000-entry limit. A false end-record signature in compressed data triggers a deterministic retry with DEFLATE levels 9 through 0, then stored entries; member contents, ordering and modes do not change. If no encoding passes, packaging fails before replacing the archive, naming its offset. Recheck existing archives with `python scripts/package.py --base-url https://example.invalid/x --check-archives dist/*.zip`.

Catalog `interfaces` describes user-facing interfaces: `service` is present only for `[service] role = "background"` (also the default when omitted). `role = "backend"` is a native implementation detail for UI/CLI tools and requires `startup = "on-demand"`; its package still includes the service executable and uses a native target, not `any`. Skin studio and downloader are UI-only with backends, practice and replay renderer are UI + CLI with backends, map preview is UI-only without a backend, server pp and mania ratings are UI + service + CLI, and lazer library is service-only. Background services support the user's **Start with vosu** override; `startup` remains the author's default.

Merge platform catalogs with:

```sh
python scripts/package.py --merge-catalogs linux/catalog.json windows/catalog.json \
  --base-url https://github.com/18-lab-dev/vosu-tools/releases/download/v0.3.0
```

Conflicting tool metadata or different packages for an already-present target fail the merge. No target package is silently replaced.

The official release workflow publishes `catalog.json` at `https://github.com/18-lab-dev/vosu-tools/releases/download/<tag>/catalog.json`, alongside the ZIPs and artwork whose URLs use that same versioned release directory. The default source `18-lab-dev/vosu-tools` resolves to `https://github.com/18-lab-dev/vosu-tools/releases/latest/download/catalog.json`; tagged sources resolve to the versioned catalog URL.

Every package includes project license texts, the retained notices, tool-specific `licenses/`, and generated `licenses/dependencies.json`. Rust notices use `cargo metadata` license expressions/files and only package identities present in `cargo tree -e normal --target <triple> -p <package>`; build/dev-only crates are not included. Bundled JavaScript packages are identified from hidden source maps, checked against `bun.lock`, and retain their installed package license texts (for example Monaco and vgpu). Hidden source maps are not shipped. Unknown/disallowed license alternatives or missing license texts fail packaging, rather than emitting an incomplete notice inventory. The release workflows use pinned action commits and native Linux/Windows runners; they publish ZIPs and the merged catalog on a `v*` tag.

The registry tarballs for the pinned dasp family and vorbis_rs omit their upstream monorepo-root license files. Packaging uses source-verified retained texts for those exact versions, checks their published VCS revisions (and dasp's upstream license blob), and records the upstream license URL in the generated inventory. See [the retained-license notice](../THIRD_PARTY_NOTICES.md#packaging-license-retention).
