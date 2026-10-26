#!/usr/bin/env bun
/**
 * Golden osu! slider bodies against osu!lazer itself. Never ships and never
 * runs in `bun test`: it needs the .NET 10 SDK and a ppy/osu checkout at
 * 2026.1005.0-lazer (restored once with `dotnet restore` in osu.Game.Tests).
 *
 *   bun test/sliderBodyGolden.ts --osu ~/ppy-osu [--dotnet path] --write-fixtures
 *     runs lazer (test/reference/VosuLayout.cs with `Paths`) on the synthetic
 *     sliders below (tight S curves, loops tighter than the body, a repeat)
 *     at CS 4 and 6, with a legacy skin's slider colours and with the classic
 *     skin, and stores its slider paths as test/fixtures/slider-bodies.json
 *     for test/sliderBody.test.ts.
 *   bun test/sliderBodyGolden.ts --osu ~/ppy-osu --skin <dir> --map <map.osu>
 *       --time 30000[,31000]
 *     compares a real skin and map (both read only), printing the error per
 *     time.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkinFolder } from "./goldenFiles";
import { runLazer } from "./layoutGolden";
import type { LayoutCase } from "./layoutCompare";
import { goldenSkin } from "./maniaCompare";
import { compareBodies, type SliderBodyCase } from "./sliderBodyCompare";

const here = import.meta.dir;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

/** Synthetic sliders, 3 s apart so each is drawn alone (AR 9). */
export const SLIDERS: [string, string][] = [
  ["s-zigzag", "64,192,1000,2,0,B|128:96|192:288|256:96|320:288|384:192,1,520"],
  // A tight S: two curves of a radius below the body's (inner cusps).
  [
    "s-tight",
    "200,100,4000,2,0,B|260:100|260:160|200:160|200:160|140:160|140:220|200:220,1,300",
  ],
  // A perfect-circle loop of radius 24 (the body's is 36.5 at CS 4).
  ["loop-perfect", "256,216,7000,2,0,P|232:192|273:209,1,130"],
  ["loop-teardrop", "150,330,10000,2,0,B|380:120|-80:120|150:330,1,600"],
  ["repeat", "150,300,13000,2,0,L|350:300,2,200"],
  // A long S with a closed loop and a crossing.
  [
    "s-long",
    "300,330,16000,2,0,B|100:330|100:200|300:200|300:200|430:200|430:60|260:60|260:60|170:60|170:130|240:130,1,1100",
  ],
];

export function sliderMap(cs: number): string {
  return `osu file format v14

[General]
AudioFilename: none
Mode: 0
StackLeniency: 0.7

[Metadata]
Title:slider bodies
Artist:vosu-tools
Creator:vosu-tools
Version:CS${cs}

[Difficulty]
HPDrainRate:5
CircleSize:${cs}
OverallDifficulty:5
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,60,1,0

[Colours]
Combo1 : 255,128,64

[HitObjects]
${SLIDERS.map(([, line]) => line).join("\n")}
`;
}

/** Slider colours of a legacy skin (「sigma」- GAME OVER's); classic: none. */
export const SKINS: Record<string, string | undefined> = {
  "track-override":
    "[General]\nVersion: 2.7\n\n[Colours]\nSliderBorder: 130,114,178\nSliderTrackOverride: 39,35,76\n",
  classic: undefined,
};

interface Dumped {
  name: string;
  size: [number, number];
  playfield: number[];
  paths: SliderBodyCase["paths"];
}

function writeFixtures(osu: string, dotnet: string): void {
  const work = mkdtempSync(join(tmpdir(), "vosu-slider-golden-")),
    cases: (LayoutCase & { paths: true })[] = [],
    times: Record<string, number> = {};
  for (const [name, ini] of Object.entries(SKINS)) {
    mkdirSync(join(work, name));
    if (ini) writeFileSync(join(work, name, "skin.ini"), ini);
  }
  for (const cs of [4, 6]) {
    writeFileSync(join(work, `cs${cs}.osu`), sliderMap(cs));
    for (const skin of Object.keys(SKINS))
      for (const [slider, line] of SLIDERS) {
        const name = `${slider}-cs${cs}-${skin}`;
        // Fully snaked in, before the head is hit.
        times[name] = Number(line.split(",")[2]) - 100;
        cases.push({
          name,
          ruleset: "osu",
          skin: join(work, skin),
          map: join(work, `cs${cs}.osu`),
          width: 1365.3334,
          height: 768,
          time: times[name],
          mapColours: true,
          paths: true,
        });
      }
  }
  const results = runLazer(osu, dotnet, cases) as unknown as Dumped[];
  rmSync(work, { recursive: true, force: true });
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const fixture = {
    maps: { cs4: sliderMap(4), cs6: sliderMap(6) },
    skins: SKINS,
    cases: results.map((r): SliderBodyCase => ({
      name: r.name,
      map: `cs${r.name.match(/-cs(\d)-/)![1]}`,
      skin: Object.keys(SKINS).find((s) => r.name.endsWith(`-${s}`))!,
      time: times[r.name],
      size: r.size,
      playfield: r.playfield.map(round),
      paths: r.paths.map((p) => ({
        ...p,
        alpha: round(p.alpha),
        radius: round(p.radius),
        vertices: p.vertices.map(round),
      })),
    })),
  };
  writeFileSync(
    join(here, "fixtures/slider-bodies.json"),
    JSON.stringify(fixture) + "\n",
  );
  console.log(
    `wrote ${fixture.cases.length} lazer slider bodies to test/fixtures/slider-bodies.json`,
  );
}

if (import.meta.main) {
  const osu = argument("--osu"),
    dotnet = argument("--dotnet") ?? "dotnet",
    folder = argument("--skin"),
    mapPath = argument("--map"),
    times = argument("--time");
  if (
    !osu ||
    (!process.argv.includes("--write-fixtures") &&
      !(folder && mapPath && times))
  ) {
    console.error(
      "usage: bun test/sliderBodyGolden.ts --osu <ppy/osu checkout> [--dotnet path] (--write-fixtures | --skin <dir> --map <map.osu> --time ms[,ms])",
    );
    process.exit(2);
  }
  if (process.argv.includes("--write-fixtures")) writeFixtures(osu, dotnet);
  else {
    const results = runLazer(
      osu,
      dotnet,
      times!.split(",").map((t) => ({
        name: `real-${t}`,
        ruleset: "osu" as const,
        skin: folder!,
        map: mapPath!,
        width: 1365.3334,
        height: 768,
        time: Number(t),
        mapColours: true,
        paths: true,
      })),
    ) as unknown as Dumped[];
    const { skin } = goldenSkin(readSkinFolder(folder!, "real"));
    const text = readFileSync(mapPath!, "utf8");
    for (const r of results) {
      const time = Number(r.name.slice(5));
      const result = compareBodies(
        { ...r, map: "", skin: "", time },
        text,
        skin,
      );
      console.log(
        `${r.name}: ${r.paths.length} paths, ${result.pixels} pixels, mean ${result.mean.toFixed(2)}, max ${result.max.toFixed(0)}, ${(result.over8 * 100).toFixed(2)}% off by more than 8`,
      );
    }
  }
}
