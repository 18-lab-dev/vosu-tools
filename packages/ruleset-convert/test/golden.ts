#!/usr/bin/env bun
/**
 * Golden comparison against osu!lazer itself, for real beatmaps on this
 * machine. Never ships and never runs in `bun test`: it needs the .NET 10 SDK,
 * a ppy/osu checkout at 2026.1005.0-lazer and the oracle in test/reference.
 *
 *   dotnet build -c Release -o /tmp/oracle-bin test/reference   (once)
 *   bun test/golden.ts --oracle /tmp/oracle-bin/oracle.dll [--report out.json] map.osu…
 *   bun test/golden.ts --oracle … --write-fixtures test/fixtures/*.osu
 *
 * Every map is copied to a temporary folder first; the originals are only read.
 * `--write-fixtures` stores the oracle's output next to each (synthetic,
 * project-authored) fixture as `<name>.<target>[.<mods>].json` for `bun test`.
 */
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { compare, portOutput, type OracleOutput, type Target } from "./compare";

export const cases: { target: Target; mods: string[] }[] = [
  { target: "taiko", mods: [] },
  { target: "mania", mods: [] },
  { target: "mania", mods: ["4K"] },
  { target: "mania", mods: ["7K"] },
  { target: "mania", mods: ["DS"] },
  { target: "fruits", mods: [] },
  { target: "fruits", mods: ["HR"] },
];

export const fixtureName = (
  map: string,
  target: Target,
  mods: readonly string[],
) =>
  `${map.replace(/\.osu$/, "")}.${target}${mods.length ? "." + mods.join("-") : ""}.json`;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const [value] = process.argv.splice(index, 2).slice(1);
  return value;
}

if (import.meta.main) {
  const oracle = argument("--oracle"),
    dotnet = argument("--dotnet") ?? "dotnet",
    reportPath = argument("--report"),
    writeFixtures = process.argv.includes("--write-fixtures");
  const maps = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!oracle || !maps.length) {
    console.error(
      "usage: bun test/golden.ts --oracle oracle.dll [--dotnet path] [--report out.json] [--write-fixtures] map.osu…",
    );
    process.exit(2);
  }
  const temp = mkdtempSync(join(tmpdir(), "ruleset-convert-golden-"));
  const report: Record<string, unknown>[] = [];
  let failures = 0;
  try {
    for (const [index, path] of maps.entries()) {
      const copy = join(temp, `${index}.osu`);
      copyFileSync(path, copy);
      const text = readFileSync(copy, "utf8");
      if (!/^\s*Mode\s*:\s*0\s*$/m.test(text) && /^\s*Mode\s*:/m.test(text)) {
        console.log(`skip (not an osu! map): ${basename(path)}`);
        continue;
      }
      for (const { target, mods } of cases) {
        const run = Bun.spawnSync(
          [dotnet, oracle, target, copy, mods.join(",")],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        if (run.exitCode !== 0) {
          failures++;
          report.push({
            map: basename(path),
            target,
            mods,
            error: run.stderr.toString().trim(),
          });
          console.log(
            `ERROR ${basename(path)} ${target} ${mods.join(",")}: ${run.stderr.toString().trim().split("\n")[0]}`,
          );
          continue;
        }
        const expected = JSON.parse(run.stdout.toString()) as OracleOutput;
        if (writeFixtures) {
          writeFileSync(
            fixtureName(path, target, mods),
            JSON.stringify(expected) + "\n",
          );
          continue;
        }
        const started = performance.now();
        const actual = portOutput(text, target, mods);
        const ms = performance.now() - started;
        const result = compare(target, expected, actual);
        if (result.mismatches.length) failures++;
        report.push({
          map: basename(path),
          target,
          mods,
          objects: result.objects,
          ...("columns" in expected ? { columns: expected.columns } : {}),
          ...(result.maxDx !== undefined ? { maxDx: result.maxDx } : {}),
          portMs: Math.round(ms * 10) / 10,
          mismatches: result.mismatches,
        });
        console.log(
          `${result.mismatches.length ? "FAIL" : "ok  "} ${basename(path).slice(0, 70)} ${target}${mods.length ? " +" + mods.join(",") : ""}: ${result.objects[0]} objects${"columns" in expected ? `, ${expected.columns}K` : ""}${result.maxDx !== undefined ? `, max |Δx| ${result.maxDx.toFixed(3)}` : ""}${result.mismatches.length ? "\n      " + result.mismatches.slice(0, 5).join("\n      ") : ""}`,
        );
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (reportPath)
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!writeFixtures)
    console.log(
      failures ? `${failures} case(s) differ` : "all cases match lazer",
    );
  process.exit(failures ? 1 : 0);
}
