# Tool art

Every first-party tool has an icon and a banner drawn as one family, so the dashboard's Tools page reads as one product. The same rules cover vosulay's catalog art (`assets/branding/vosu-tool-*.svg` in that repository). Packaging limits are in the [package contract](catalog.md); this page is the look.

First-party artwork in `tools/*/art/` and `assets/` is © 2026 sxlvia, licensed under MIT OR Apache-2.0.

## Files

Each tool keeps `art/icon.svg` and `art/banner.svg`, named by its `tool.toml`. Both are hand-written SVG: no text, fonts, rasters, scripts or external references. Keep them small (under 5 KB) and readable enough to edit by hand.

## Colour

The art uses the dashboard's tokens (vosu `assets/server/tokens.css`) and follows its mode. Presentation attributes carry the DRAFTING (light) colours; one `@media (prefers-color-scheme: dark)` block switches to WORKSTATION. Browsers apply the page's `color-scheme` to SVG images, so the art follows the dashboard's mode switch, not only the system setting; elsewhere it follows the system.

| Role | Light | Dark | Token |
| --- | --- | --- | --- |
| Icon ink | `#3b4858` | `#b8b5ad` | `--fg-dim` |
| Accent | `#175fad` | `#ff963f` | `--accent` |
| Banner ground | `#e7e6df` | `#0b0c0d` | `--bg-sunken` |
| Banner grid, 40-unit cells | `#175fad` at 8% | `#ebe8e1` at 6% | `--grid-major`, quieter |
| Banner structure | `#a7b2bd` | `#3b3f45` | `--rule-strong` |
| Banner motif | `#5b6775` | `#7e8288` | `--muted` |

Each picture has one accent element: the part that is the tool's job (the arrow that downloads, the selected set, the top skillset rating, the approach circle, the practice copy, the cursor, the needle, the chosen element, the overlay panel). Everything else is ink, structure or motif.

## Icons

- `viewBox="0 0 24 24"`, `width`/`height` 256. Geometry stays inside 2.5–21.5 (strokes overhang by 0.75); the card frame adds its own padding.
- 1.5-unit strokes, round caps and joins, no fills except dots of 0.7–1.75 units. Rectangles use `rx` 1–1.5.
- One pictogram per tool, no letters. It must read at 32 px, the size inside the 40 px card frame.
- osu! shapes are welcome (hit and approach circles, follow points, cursor trails, mania notes, the song-select carousel); ppy logos and marks are not.

| Tool | Pictogram |
| --- | --- |
| Beatmap downloader | Arrow into a tray |
| Lazer library | Carousel of sets, the selected one pulled forward |
| Map analysis | Falling 4K notes beside skillset rating bars, the top skill in accent |
| Map preview | Hit circle with its approach circle, follow point, next circle |
| Practice | A section held between handles on the map, and its shorter, faster copy (fast-forward chevrons) |
| Replay renderer | Cursor trail inside a video frame |
| Server pp calculator | Gauge and needle |
| Skin studio | Three overlapping circles: mixed combo colours |
| vosulay | Overlay panel in front of a hit circle |

## Banners

- `viewBox="0 0 1200 400"`, `width`/`height` 1200×400, filled with the banner ground and the grid.
- The dashboard shows the middle as a 72 px strip (`object-fit: cover`), so everything that matters sits between y 120 and 280. Anything outside that band is ground or structure that may be cut.
- The banner expands the icon's pictogram into a quiet scene: structure lines (4 units) may run full width, the motif (5 units; rating bars 12) carries the subject, the accent (6 units) sits at or right of centre. No tool name, tagline or text.
- A glance must say what the tool does: show the tool's input and its result (a chart and its ratings; a map and the practice copy cut from it), not an abstract pattern.
- Low contrast: structure and grid stay near the ground so the banner never competes with the card's name and buttons.

## Checking

Render a contact sheet with each icon at 40 (inside the card frame), 64 and 256 px and each banner full size and as the 72 px strip, on both dark and light card surfaces, and look at the real Tools page in both modes. `python -m unittest discover -s scripts -p 'test_*.py'` and `scripts/package.py --dry-run` validate sizes and ratios.
