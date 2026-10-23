#!/usr/bin/env bun
/**
 * Golden layout comparison for legacy mania skins against osu!lazer itself.
 * Never ships and never runs in `bun test`: it needs the .NET 10 SDK and a
 * ppy/osu checkout at 2026.1005.0-lazer (restored once with `dotnet restore`
 * in osu.Game.Rulesets.Mania.Tests).
 *
 *   bun test/maniaGolden.ts --osu ~/ppy-osu --write-fixtures
 *     renders the synthetic skins in test/fixtures/mania-skins.json (written
 *     as PNGs of the listed sizes to a temporary folder), runs lazer, and
 *     stores its layout as test/fixtures/mania-golden.json for `bun test`.
 *   bun test/maniaGolden.ts --osu ~/ppy-osu --skin <dir> --keys 4 [--report out.json]
 *     compares a real skin folder (read only; up- and downscroll), printing
 *     every element lazer draws that render-core places differently.
 *
 * test/reference/VosuManiaLayout.cs is copied into the checkout's
 * osu.Game.Rulesets.Mania.Tests project and run headless with `dotnet test`.
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
import { dirname, join } from "node:path";
import { png, readSkinFolder } from "./goldenFiles";
import {
  compareCase,
  goldenSkin,
  type GoldenCase,
  type GoldenResult,
  type GoldenSkin,
} from "./maniaCompare";

const here = import.meta.dir;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Runs lazer on `cases`, each skin being a folder; returns its dumped layouts. */
function runLazer(
  osu: string,
  dotnet: string,
  folders: Map<string, string>,
  cases: GoldenCase[],
): GoldenResult[] {
  const project = join(osu, "osu.Game.Rulesets.Mania.Tests");
  if (!existsSync(project)) throw new Error(`no Mania.Tests project in ${osu}`);
  copyFileSync(
    join(here, "reference/VosuManiaLayout.cs"),
    join(project, "VosuManiaLayout.cs"),
  );
  const work = mkdtempSync(join(tmpdir(), "vosu-mania-golden-")),
    output = join(work, "out.json"),
    spec = join(work, "spec.json");
  writeFileSync(
    spec,
    JSON.stringify({
      output,
      cases: cases.map((c) => ({ ...c, skin: folders.get(c.skin) })),
    }),
  );
  const run = spawnSync(
    dotnet,
    ["test", "-c", "Release", "--filter", "VosuManiaLayout"],
    {
      cwd: project,
      env: { ...process.env, VOSU_MANIA_SPEC: spec },
      encoding: "utf8",
      maxBuffer: 1 << 26,
    },
  );
  if (run.status !== 0 || !existsSync(output)) {
    console.error(run.stdout.slice(-4000), run.stderr.slice(-4000));
    throw new Error("lazer layout run failed");
  }
  const results = JSON.parse(readFileSync(output, "utf8")) as GoldenResult[];
  rmSync(work, { recursive: true, force: true });
  return results;
}

if (import.meta.main) {
  const osu = argument("--osu"),
    dotnet = argument("--dotnet") ?? "dotnet",
    folder = argument("--skin"),
    report = argument("--report");
  if (!osu || (!folder && !process.argv.includes("--write-fixtures"))) {
    console.error(
      "usage: bun test/maniaGolden.ts --osu <ppy/osu checkout> [--dotnet path] (--write-fixtures | --skin <dir> --keys <n> [--time ms] [--report out.json])",
    );
    process.exit(2);
  }
  if (folder) {
    // Real skins: lazer reads the folder in place; the comparison only uses sizes.
    const keys = Number(argument("--keys") ?? 4),
      time = Number(argument("--time") ?? 2000),
      skin = readSkinFolder(folder, "real");
    const objects = Array.from({ length: keys }, (_, column) => [
      {
        column,
        start: time - 300 + column * 40,
        end: time + 500 + column * 60,
      },
      { column, start: time + 900 + column * 70 },
    ]).flat();
    const cases: GoldenCase[] = (["down", "up"] as const).map((direction) => ({
      name: `real-${direction}`,
      skin: "real",
      keys,
      direction,
      scrollSpeed: 20,
      time,
      objects,
    }));
    const results = runLazer(osu, dotnet, new Map([["real", folder]]), cases);
    const { skin: parsed, regions } = goldenSkin(skin);
    let failures = 0;
    // Elements lazer took from its classic fallback skin are not in the folder.
    const own = new Set(
      Object.keys(skin.files).map((f) =>
        f
          .replace(/\\/g, "/")
          .replace(/\.png$/i, "")
          .replace(/@2x$/i, "")
          .toLowerCase(),
      ),
    );
    const out = cases.map((c, i) => {
      const mismatches = compareCase(c, results[i], parsed, regions, (asset) =>
        own.has(asset),
      );
      failures += mismatches.length;
      for (const m of mismatches)
        console.log(
          `${c.name} ${m.reason}: ${m.item ? `${m.item.kind} ${m.item.asset ?? m.item.type} col ${m.item.column}` : (m.nearest?.asset ?? "box")}`,
          JSON.stringify(m.expected),
          m.nearest ? JSON.stringify(m.nearest.rect) : "none",
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
    readFileSync(join(here, "fixtures/mania-skins.json"), "utf8"),
  ) as { skins: GoldenSkin[]; cases: GoldenCase[] };
  const root = mkdtempSync(join(tmpdir(), "vosu-mania-skins-")),
    folders = new Map<string, string>();
  for (const skin of fixture.skins) {
    const dir = join(root, skin.name);
    mkdirSync(dir, { recursive: true });
    if (skin.ini) writeFileSync(join(dir, "skin.ini"), skin.ini);
    for (const [file, [w, h]] of Object.entries(skin.files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), png(w, h));
    }
    folders.set(skin.name, dir);
  }
  const results = runLazer(osu, dotnet, folders, fixture.cases);
  rmSync(root, { recursive: true, force: true });
  writeFileSync(
    join(here, "fixtures/mania-golden.json"),
    JSON.stringify(results) + "\n",
  );
  console.log(
    `wrote ${results.length} lazer layouts to test/fixtures/mania-golden.json`,
  );
}
