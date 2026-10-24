#!/usr/bin/env bun
/**
 * Gameplay goldens against osu!lazer itself. Never ships and never runs in
 * `bun test`: it needs the .NET 10 SDK and a ppy/osu checkout at
 * 2026.1005.0-lazer (restored once with `dotnet restore` in osu.Game.Tests).
 *
 *   bun test/gameplayGolden.ts --osu ~/ppy-osu [--dotnet path] [--raw out.json]
 *     plays test/gameplayCompare.ts's maps with lazer's autoplay and the
 *     synthetic GAMEPLAY_SKINS (written as PNGs of the listed sizes), frame
 *     by frame from 0, dumps lazer's drawables at GAMEPLAY_TIMES with the
 *     autoplay replay, and stores what the comparison reads as
 *     test/fixtures/gameplay-golden.json (`--raw` keeps the whole dump).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png } from "./goldenFiles";
import type { LayoutResult } from "./layoutCompare";
import { GAMEPLAY_CASES, GAMEPLAY_MAPS, GAMEPLAY_SKINS, lazerGameplayItems } from "./gameplayCompare";

const here = import.meta.dir;
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const osu = argument("--osu"),
  dotnet = argument("--dotnet") ?? "dotnet";
if (!osu) {
  console.error("usage: bun test/gameplayGolden.ts --osu <ppy/osu checkout> [--dotnet path] [--raw out.json]");
  process.exit(2);
}
const project = join(osu, "osu.Game.Tests");
if (!existsSync(project)) throw new Error(`no osu.Game.Tests project in ${osu}`);
copyFileSync(join(here, "reference/VosuLayout.cs"), join(project, "Visual/VosuLayout.cs"));
const work = mkdtempSync(join(tmpdir(), "vosu-gameplay-golden-"));
const skinDirs = new Map<string, string>();
for (const skin of GAMEPLAY_SKINS) {
  const dir = join(work, skin.name);
  mkdirSync(dir);
  writeFileSync(join(dir, "skin.ini"), skin.ini);
  for (const [file, [w, h]] of Object.entries(skin.files)) writeFileSync(join(dir, file), png(w, h));
  skinDirs.set(skin.name, dir);
}
const maps = new Map<string, string>();
for (const [ruleset, text] of Object.entries(GAMEPLAY_MAPS)) {
  const file = join(work, `${ruleset}.osu`);
  writeFileSync(file, text);
  maps.set(ruleset, file);
}
const output = join(work, "out.json"),
  spec = join(work, "spec.json");
writeFileSync(
  spec,
  JSON.stringify({
    output,
    cases: GAMEPLAY_CASES.map((c) => ({ ...c, skin: skinDirs.get(c.skin), map: maps.get(c.map), frames: true })),
  }),
);
const run = spawnSync(dotnet, ["test", "-c", "Release", "--filter", "VosuLayout"], {
  cwd: project,
  env: { ...process.env, VOSU_LAYOUT_SPEC: spec },
  encoding: "utf8",
  maxBuffer: 1 << 26,
});
if (run.status !== 0 || !existsSync(output)) {
  console.error(run.stdout.slice(-4000), run.stderr.slice(-4000));
  throw new Error("lazer run failed");
}
const results = JSON.parse(readFileSync(output, "utf8")) as (LayoutResult & {
  frames: { time: number; x: number; y: number; keys: number }[];
})[];
const raw = argument("--raw");
if (raw) writeFileSync(raw, JSON.stringify(results, null, 1));
rmSync(work, { recursive: true, force: true });
const r = (v: number, digits: number) => Number(v.toFixed(digits));
const golden = results.map((result, i) => {
  const c = GAMEPLAY_CASES[i];
  return {
    ...c,
    // One copy of each ruleset's replay is enough (the same autoplay every case).
    frames: GAMEPLAY_CASES.findIndex((o) => o.ruleset === c.ruleset) === i
      ? result.frames.map((f) => ({ time: r(f.time, 3), x: r(f.x, 3), y: r(f.y, 3), keys: f.keys }))
      : undefined,
    result: {
      name: result.name,
      size: result.size,
      items: lazerGameplayItems(c.ruleset, result.items).map((item) => ({
        type: item.type,
        path: item.path.slice(0, 4),
        texture: { name: item.texture!.name, display: item.texture!.display },
        alpha: r(item.alpha, 4),
        colour: item.colour.map((v) => r(v, 4)),
        additive: item.additive,
        quad: item.quad.map((v) => r(v, 3)),
        clip: null,
      })),
    },
  };
});
writeFileSync(join(here, "fixtures/gameplay-golden.json"), JSON.stringify(golden, null, 1) + "\n");
console.log(`wrote ${golden.length} cases, ${golden.reduce((n, g) => n + g.result.items.length, 0)} sprites`);
