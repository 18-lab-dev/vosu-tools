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
 *
 *   bun test/gameplayGolden.ts --osu ~/ppy-osu --skin <dir> [--width w] [--height h]
 *     plays the taiko cases with a real skin folder (read only) and prints
 *     every input drum sprite render-core places differently from lazer;
 *     writes no fixture. The size is lazer's game space (768 high, or 1024
 *     wide below 4:3), e.g. 1024 x 1327.4 for a 540 x 700 output cell.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { png, readSkinFolder } from "./goldenFiles";
import { placeLayout, withClassic, type LayoutResult } from "./layoutCompare";
import { goldenSkin } from "./maniaCompare";
import { compareGameplay, GAMEPLAY_CASES, GAMEPLAY_MAPS, GAMEPLAY_SKINS, lazerGameplayItems } from "./gameplayCompare";

const here = import.meta.dir;
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const osu = argument("--osu"),
  dotnet = argument("--dotnet") ?? "dotnet",
  folder = argument("--skin");
if (!osu) {
  console.error(
    "usage: bun test/gameplayGolden.ts --osu <ppy/osu checkout> [--dotnet path] ([--raw out.json] | --skin <dir> [--width w] [--height h])",
  );
  process.exit(2);
}
const cases = folder
  ? GAMEPLAY_CASES.filter((c) => c.ruleset === "taiko" && c.skin === "gameplay").map((c) => ({
      ...c,
      name: `real-${c.name}`,
      width: Number(argument("--width") ?? c.width),
      height: Number(argument("--height") ?? c.height),
    }))
  : GAMEPLAY_CASES;
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
    cases: cases.map((c) => ({
      ...c,
      skin: folder ? resolve(folder) : skinDirs.get(c.skin),
      map: maps.get(c.map),
      frames: true,
    })),
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
if (folder) {
  // The drum flashes from lazer's own autoplay replay of each case.
  const { skin, regions } = goldenSkin(readSkinFolder(folder, "real"));
  let failures = 0;
  for (const [i, c] of cases.entries()) {
    const ours = placeLayout(c, GAMEPLAY_MAPS.taiko, skin, withClassic(regions), {
      input: results[i].frames,
    }).filter((p) => p.motion === 35 && /^taiko-drum-/.test(p.asset));
    const mismatches = compareGameplay(lazerGameplayItems("taiko", results[i].items), ours);
    failures += mismatches.length;
    for (const m of mismatches)
      console.log(`${c.name} ${m.reason} ${m.asset} lazer ${JSON.stringify(m.lazer)} ours ${JSON.stringify(m.ours)}`);
    console.log(`${c.name}: lazer ${lazerGameplayItems("taiko", results[i].items).length} drum sprite(s), ours ${ours.length}`);
  }
  console.log(failures ? `${failures} drum sprite(s) differ` : "every drum sprite matches lazer");
  process.exit(failures ? 1 : 0);
}
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
