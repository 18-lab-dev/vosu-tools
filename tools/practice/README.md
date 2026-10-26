# osu! practice tool

Practice copies of the map selected in osu!: change its rate, difficulty and ruleset transforms, trim it to the sections you want to grind, and preview the result before generating it.

Interfaces: **UI + CLI**. The native backend starts on demand and stops when idle; it is not a standalone background service.

![osu! practice tool](../../docs/screenshots/practice.webp)

## What it does

- **Offline rates**: any rate from 0.5× to 2.0×, keeping the pitch or changing it (like Nightcore/Daycore); HT, DT, NC and DC follow osu!lazer's defaults. Audio is rendered offline into the copy.
- **Ruleset-specific transforms**: Constant Speed (mania, taiko), seeded Random, Mirror, mania Invert and Hold Off, taiko Swap. Seeded transforms use osu!lazer's random generator, so a seed gives lazer's result.
- **Difficulty**: HP, CS, AR and OD. By default AR and OD are recalculated so the copy plays with the original timing windows and approach time at the new rate; **Keep AR** and **Keep OD** keep the original values instead.
- **Trims**: Shift+drag on the timeline to keep only chosen sections. The cut audio gets a lead-in, a lead-out, gaps between sections and optional fades. For mania maps the timeline shows local MSD from the [Mania ratings](../mania-ratings/README.md) tool when it is installed; otherwise it shows notes per second.
- **Preview**: a render-core playfield ([`packages/render-core`](../../packages/render-core/README.md)) previews the result before anything is written.
- **Profiles**: named sets of options, saved and loaded from the top bar.

Stable copies are written next to the original difficulty (host permission `songs:write`). Lazer copies are exported as `.osz` archives to the configured export folder, or kept in the tool's data folder. Nothing is imported automatically. Generated copies can be listed and safely deleted from the page or the CLI.

[Scope and provenance](PROVENANCE.md) records the inspected osu!lazer sources, the transforms' exact behaviour and the combination order.

## CLI

```sh
vosux practice --rate 1.2 --mods MR --json        # practice copy of the selected map
vosux practice --mods RD --seed 1                 # see --help for every option
vosux practice list --json
vosux practice delete <id>
```

## Settings

Edited on the vosu dashboard (Tools → osu! practice tool → Settings): the trim lead-in, lead-out, gap and audio fade defaults, whether rate changes shift pitch by default, the lazer export folder, and whether mania trims use the Mania ratings timeline.
