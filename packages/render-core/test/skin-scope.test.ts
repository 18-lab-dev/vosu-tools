import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import fixture from "./fixtures/sylvia-skin.json";
import { compileScene, sceneScope, type InputFrame } from "../src/scene";
import type { JudgementEvent } from "../src/judgements";
import {
  assetNames,
  frameOwner,
  loadScope,
  loadSkin,
  type AtlasRegion,
  type Skin,
} from "../src/skin";

// Bun has no createImageBitmap: blobs become fake 64×64 bitmaps.
globalThis.createImageBitmap = (async () => ({
  width: 64,
  height: 64,
  close() {},
})) as unknown as typeof createImageBitmap;

/** A Map that records every key asked for. */
class Asked<V> extends Map<string, V> {
  readonly asked = new Set<string>();
  override get(key: string): V | undefined {
    this.asked.add(key);
    return super.get(key);
  }
  override has(key: string): boolean {
    this.asked.add(key);
    return super.has(key);
  }
}

const map = (mode: number, objects: string, cs = 4) =>
  parseOsu(
    `osu file format v14\n[General]\nMode: ${mode}\n[Difficulty]\nHPDrainRate:5\nCircleSize:${cs}\nOverallDifficulty:5\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:2\n[TimingPoints]\n0,500,4,1,0,100,1,0\n2000,500,4,1,0,100,1,1\n[HitObjects]\n${objects}\n`,
  );
/** Every object type of each ruleset (taiko/catch read sliders and spinners as rolls, juice and bananas). */
const maps = {
  0: map(0, "100,100,500,1,0\n200,200,1000,6,0,B|300:200|300:300,2,140\n256,192,3000,12,0,4000\n300,100,4500,5,0"),
  1: map(1, "256,192,500,1,0\n256,192,700,1,8\n256,192,900,1,4\n256,192,1100,1,12\n256,192,1500,2,0,L|400:192,1,280\n256,192,3000,12,0,4000"),
  2: map(2, "100,192,500,1,0\n200,192,1000,6,0,L|400:192,2,200\n256,192,3000,12,0,4000\n400,192,4500,5,0"),
  3: map(3, Array.from({ length: 7 }, (_, c) => `${Math.floor(((c + 0.5) * 512) / 7)},192,${500 + c * 200},1,0\n${Math.floor(((c + 0.5) * 512) / 7)},192,${3000 + c * 300},128,0,${3200 + c * 300}:0:0:0:0:`).join("\n"), 7),
} as const;
const results = ["great", "ok", "meh", "miss", "perfect", "good", "large_tick_hit", "large_tick_miss", "small_tick_miss", "slider_tail_hit", "ignore_miss", "spinner_bonus"];
const objects: Record<number, string[]> = {
  0: ["circle", "slider", "slider_head", "slider_tick", "slider_repeat", "slider_tail", "spinner", "spinner_tick"],
  1: ["hit", "strong", "drumroll", "swell", "tick"],
  2: ["fruit", "droplet", "tiny_droplet", "banana"],
  3: ["note", "head", "tail", "body", "hold"],
};
const judgements = (mode: number): JudgementEvent[] =>
  objects[mode].flatMap((object, i) =>
    results.map((result, j) => ({ time: 500 + i * 200 + j * 10, result, note: 0, object, x: mode === 3 ? j % 7 : 256, y: 192, combo: j })),
  );
const input: InputFrame[] = Array.from({ length: 400 }, (_, i) => ({ time: i * 16, x: 100 + (i % 50) * 6, y: 192, keys: i % 7 === 0 ? 0 : 1 << i % 4 }));

/** Every skin image a compiled scene of `mode` asks for, as element names. */
function asked(mode: 0 | 1 | 2 | 3, skin: Skin): Set<string> {
  const regions = new Asked<AtlasRegion>();
  const region: AtlasRegion = { u: 0, v: 0, w: 0.1, h: 0.1, width: 64, height: 64 };
  for (const name of skin.assets.keys()) regions.set(name, region);
  const assets = new Asked(skin.assets);
  const recorded = { ...skin, assets };
  for (const options of [{}, { judgements: judgements(mode), input, hitLighting: true }])
    compileScene(maps[mode], options, regions, recorded);
  return new Set([...regions.asked, ...assets.asked].map(frameOwner));
}

/** The user's lazer skin as files (sylvia-skin.json): every listed image exists. */
const files = new Set(Object.keys(fixture.files).map((path) => path.toLowerCase()));
const requests: string[] = [];
const resolve = async (name: string) => {
  requests.push(name);
  if (name === "skin.ini") return new Blob([fixture.ini]);
  return files.has(name.replace(/\\/g, "/").toLowerCase()) ? new Blob(["png"]) : null;
};

/** A skin with every element, animations with two frames: anything a scene could draw. */
const everything = new Set([...assetNames, ...Array.from({ length: 10 }, (_, i) => `score-${i}`)]);
const resolveEverything = async (file: string) => {
  const name = file.replace(/(@2x)?\.png$/, "");
  const frame = /^(.*?)-?([01])$/.exec(name);
  return file !== "skin.ini" && (everything.has(name) || (frame && everything.has(frame[1]))) ? new Blob(["png"]) : null;
};

test("a scene's ruleset scope holds every general image the scene asks for", async () => {
  const full = await loadSkin(resolveEverything, "all");
  for (const mode of [0, 1, 2, 3] as const) {
    const scoped = await loadScope(full, sceneScope(maps[mode]));
    const missing = [...asked(mode, full)].filter((name) => full.assets.has(name) && !scoped.assets.has(name));
    expect({ mode, missing }).toEqual({ mode, missing: [] });
  }
});

test("a mania scene of the user's skin asks for a fraction of the files", async () => {
  requests.length = 0;
  await loadSkin(resolve, fixture.name, {});
  const all = requests.length;
  requests.length = 0;
  const skin = await loadSkin(resolve, fixture.name, sceneScope(maps[3]));
  const scoped = requests.length;
  expect(scoped).toBeLessThan(all / 3);
  expect(skin.assets.has("hitcircle")).toBe(false);
  // Images found missing are not asked for again when the scope widens.
  requests.length = 0;
  const wider = await loadScope(skin, { rulesets: [0, 3], maniaKeys: [7] });
  expect(wider.assets.has("hitcircle") || files.has("hitcircle.png") === false).toBe(true);
  const again = new Set(requests);
  expect(requests.length).toBe(again.size);
  requests.length = 0;
  await loadScope(wider, { rulesets: [3], maniaKeys: [7] });
  expect(requests).toEqual([]);
});
