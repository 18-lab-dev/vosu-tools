#!/usr/bin/env bun
/**
 * Golden judgements against osu!lazer itself. Never ships and never runs in
 * `bun test`: it needs the .NET 10 SDK and a ppy/osu checkout at
 * 2026.1005.0-lazer (restored once with `dotnet restore` in osu.Game.Tests).
 *
 *   bun test/judgementGolden.ts --osu ~/ppy-osu [--dotnet path]
 *     plays test/judgementCompare.ts's tiny maps with lazer's autoplay and
 *     the synthetic JUDGEMENT_SKINS (written as PNGs of the listed sizes),
 *     dumps lazer's drawables at JUDGEMENT_TIMES and stores the judgement
 *     sprites as test/fixtures/judgement-golden.json for `bun test`
 *     (`--raw out.json` also keeps lazer's whole dump).
 *
 * test/reference/VosuLayout.cs is copied into the checkout's osu.Game.Tests
 * project (Visual/) and run headless with `dotnet test`, as for layoutGolden.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { png } from "./goldenFiles";
import type { LayoutResult } from "./layoutCompare";
import { isJudgementTexture, JUDGEMENT_MAPS, JUDGEMENT_SKINS, JUDGEMENT_TIMES, type JudgementCase } from "./judgementCompare";

const here = import.meta.dir;
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const osu = argument("--osu"),
  dotnet = argument("--dotnet") ?? "dotnet";
if (!osu) {
  console.error("usage: bun test/judgementGolden.ts --osu <ppy/osu checkout> [--dotnet path]");
  process.exit(2);
}
const project = join(osu, "osu.Game.Tests");
if (!existsSync(project)) throw new Error(`no osu.Game.Tests project in ${osu}`);
copyFileSync(join(here, "reference/VosuLayout.cs"), join(project, "Visual/VosuLayout.cs"));
const work = mkdtempSync(join(tmpdir(), "vosu-judgement-golden-"));
const cases: JudgementCase[] = [],
  skinNames: string[] = [];
for (const ruleset of Object.keys(JUDGEMENT_MAPS) as JudgementCase["ruleset"][])
  writeFileSync(join(work, `${ruleset}.osu`), JUDGEMENT_MAPS[ruleset]);
for (const { skin, prefix, rulesets } of JUDGEMENT_SKINS) {
  const skinDir = join(work, skin.name);
  mkdirSync(skinDir);
  writeFileSync(join(skinDir, "skin.ini"), skin.ini);
  for (const [file, [w, h]] of Object.entries(skin.files)) {
    mkdirSync(dirname(join(skinDir, file)), { recursive: true });
    writeFileSync(join(skinDir, file), png(w, h));
  }
  for (const ruleset of rulesets)
    for (const time of JUDGEMENT_TIMES[ruleset]) {
      cases.push({ name: `${prefix}${ruleset}-${time}`, ruleset, skin: skinDir, map: join(work, `${ruleset}.osu`), width: 1365.3334, height: 768, time });
      skinNames.push(skin.name);
    }
}
const output = join(work, "out.json"),
  spec = join(work, "spec.json");
writeFileSync(spec, JSON.stringify({ output, cases }));
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
const results = JSON.parse(readFileSync(output, "utf8")) as LayoutResult[];
// --raw <file>: keep lazer's whole dump (every drawable), for investigation.
const raw = argument("--raw");
if (raw) writeFileSync(raw, JSON.stringify(results, null, 1));
rmSync(work, { recursive: true, force: true });
const round = (v: number, digits: number) => Number(v.toFixed(digits));
const golden = results.map((r, i) => ({
  ...cases[i],
  skin: skinNames[i],
  map: cases[i].ruleset,
  result: {
    name: r.name,
    size: r.size,
    items: r.items
      .filter((item) => item.texture && isJudgementTexture(item.texture.name))
      .map((item) => ({
        type: item.type,
        path: item.path.slice(-4),
        texture: { name: item.texture!.name, display: item.texture!.display },
        alpha: round(item.alpha, 4),
        colour: item.colour.map((c) => round(c, 4)),
        additive: item.additive,
        quad: item.quad.map((v) => round(v, 3)),
        clip: null,
      })),
  },
}));
writeFileSync(join(here, "fixtures/judgement-golden.json"), JSON.stringify(golden, null, 1) + "\n");
console.log(`wrote ${golden.length} cases, ${golden.reduce((n, g) => n + g.result.items.length, 0)} judgement sprites`);
