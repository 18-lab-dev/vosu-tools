#!/usr/bin/env bun
/**
 * Golden layout comparison for osu!taiko and osu!catch with legacy skins
 * against osu!lazer itself. Never ships and never runs in `bun test`: it needs
 * the .NET 10 SDK and a ppy/osu checkout at 2026.1005.0-lazer (restored once
 * with `dotnet restore` in osu.Game.Tests).
 *
 *   bun test/layoutGolden.ts --osu ~/ppy-osu --write-fixtures
 *     renders the synthetic skins and maps in test/fixtures/layout-cases.json
 *     (images written as PNGs of the listed sizes to a temporary folder),
 *     runs lazer, and stores its drawables as test/fixtures/layout-golden.json
 *     for `bun test`.
 *   bun test/layoutGolden.ts --osu ~/ppy-osu --skin <dir> --map <map.osu>
 *       --ruleset taiko|catch|osu --time 30000[,31000] [--width 1365.33]
 *       [--map-colours] [--report out.json]
 *     compares a real skin and map (both read only), printing every element
 *     lazer draws that render-core places differently.
 *
 * test/reference/VosuLayout.cs is copied into the checkout's osu.Game.Tests
 * project (Visual/) and run headless with `dotnet test`.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { png, readSkinFolder } from "./goldenFiles";
import {
  compareLayout,
  placeLayout,
  withClassic,
  type LayoutCase,
  type LayoutResult,
} from "./layoutCompare";
import { goldenSkin, type GoldenSkin } from "./maniaCompare";

const here = import.meta.dir;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Runs lazer on `cases` (skin and map as paths); returns its dumped layouts. */
export function runLazer(
  osu: string,
  dotnet: string,
  cases: LayoutCase[],
): LayoutResult[] {
  const project = join(osu, "osu.Game.Tests");
  if (!existsSync(project))
    throw new Error(`no osu.Game.Tests project in ${osu}`);
  copyFileSync(
    join(here, "reference/VosuLayout.cs"),
    join(project, "Visual/VosuLayout.cs"),
  );
  const work = mkdtempSync(join(tmpdir(), "vosu-layout-golden-")),
    output = join(work, "out.json"),
    spec = join(work, "spec.json");
  writeFileSync(spec, JSON.stringify({ output, cases }));
  const run = spawnSync(
    dotnet,
    ["test", "-c", "Release", "--filter", "VosuLayout"],
    {
      cwd: project,
      env: { ...process.env, VOSU_LAYOUT_SPEC: spec },
      encoding: "utf8",
      maxBuffer: 1 << 26,
    },
  );
  if (run.status !== 0 || !existsSync(output)) {
    console.error(run.stdout.slice(-4000), run.stderr.slice(-4000));
    throw new Error("lazer layout run failed");
  }
  const results = JSON.parse(readFileSync(output, "utf8")) as LayoutResult[];
  rmSync(work, { recursive: true, force: true });
  return results;
}

/** Images the folder provides, as render-core asset names. */
function ownAssets(skin: GoldenSkin): (asset: string) => boolean {
  const own = new Set(
    Object.keys(skin.files).map((f) =>
      f
        .replace(/\\/g, "/")
        .replace(/\.png$/i, "")
        .replace(/@2x$/i, "")
        .replace(/-0$/, "")
        .toLowerCase(),
    ),
  );
  return (asset) => own.has(asset.toLowerCase());
}

if (import.meta.main) {
  const osu = argument("--osu"),
    dotnet = argument("--dotnet") ?? "dotnet",
    folder = argument("--skin"),
    report = argument("--report");
  if (!osu || (!folder && !process.argv.includes("--write-fixtures"))) {
    console.error(
      "usage: bun test/layoutGolden.ts --osu <ppy/osu checkout> [--dotnet path] (--write-fixtures | --skin <dir> --map <map.osu> --ruleset taiko|catch|osu --time ms[,ms] [--width w] [--height h] [--map-colours] [--report out.json])",
    );
    process.exit(2);
  }
  if (folder) {
    const mapPath = resolve(argument("--map") ?? ""),
      ruleset =
        (["catch", "osu"] as const).find((r) => r === argument("--ruleset")) ??
        "taiko",
      width = Number(argument("--width") ?? 1365.3334),
      height = Number(argument("--height") ?? 768),
      mapColours = process.argv.includes("--map-colours"),
      times = (argument("--time") ?? "30000").split(",").map(Number);
    const cases: LayoutCase[] = times.map((time) => ({
      name: `real-${ruleset}-${time}`,
      ruleset,
      skin: resolve(folder),
      map: mapPath,
      width,
      height,
      time,
      mapColours,
    }));
    const results = runLazer(osu, dotnet, cases),
      golden = readSkinFolder(folder, "real"),
      { skin, regions } = goldenSkin(golden),
      own = ownAssets(golden),
      mapText = readFileSync(mapPath, "utf8");
    let failures = 0;
    const out = cases.map((c, i) => {
      const mismatches = compareLayout(
        c,
        results[i],
        placeLayout(c, mapText, skin, withClassic(regions)),
        own,
      );
      failures += mismatches.length;
      for (const m of mismatches)
        console.log(
          `${c.name} ${m.reason}: ${m.asset}`,
          JSON.stringify(m.expected),
          m.nearest ? JSON.stringify(m.nearest) : "none",
        );
      return { case: c.name, lazerItems: results[i].items.length, mismatches };
    });
    if (report) writeFileSync(report, JSON.stringify(out, null, 2) + "\n");
    console.log(
      failures ? `${failures} element(s) differ` : "all elements match lazer",
    );
    process.exit(failures ? 1 : 0);
  }
  const fixture = JSON.parse(
    readFileSync(join(here, "fixtures/layout-cases.json"), "utf8"),
  ) as {
    skins: GoldenSkin[];
    maps: Record<string, string>;
    cases: LayoutCase[];
  };
  const root = mkdtempSync(join(tmpdir(), "vosu-layout-skins-")),
    skins = new Map<string, string>(),
    maps = new Map<string, string>();
  for (const skin of fixture.skins) {
    const dir = join(root, skin.name);
    mkdirSync(dir, { recursive: true });
    if (skin.ini) writeFileSync(join(dir, "skin.ini"), skin.ini);
    for (const [file, [w, h]] of Object.entries(skin.files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), png(w, h));
    }
    skins.set(skin.name, dir);
  }
  for (const [name, text] of Object.entries(fixture.maps)) {
    const path = join(root, `${name}.osu`);
    writeFileSync(path, text);
    maps.set(name, path);
  }
  const results = runLazer(
    osu,
    dotnet,
    fixture.cases.map((c) => ({
      ...c,
      skin: skins.get(c.skin)!,
      map: maps.get(c.map)!,
    })),
  );
  rmSync(root, { recursive: true, force: true });
  // Only what the comparison reads, rounded to what it can resolve.
  const round = (v: number, digits: number) => Number(v.toFixed(digits));
  const compact = results.map((r) => ({
    name: r.name,
    size: r.size,
    items: r.items.map((item) => ({
      type: item.type,
      path: item.path,
      texture: item.texture && {
        name: item.texture.name,
        display: item.texture.display,
      },
      alpha: round(item.alpha, 3),
      colour: item.colour.map((c) => round(c, 4)),
      additive: item.additive,
      quad: item.quad.map((v) => round(v, 2)),
      clip: item.clip && item.clip.map((v) => round(v, 2)),
    })),
  }));
  writeFileSync(
    join(here, "fixtures/layout-golden.json"),
    JSON.stringify(compact) + "\n",
  );
  console.log(
    `wrote ${results.length} lazer layouts to test/fixtures/layout-golden.json`,
  );
}
