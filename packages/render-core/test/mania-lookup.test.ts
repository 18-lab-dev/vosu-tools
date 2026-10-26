import { afterAll, beforeAll, expect, test } from "bun:test";
import { spec } from "@vosu-tools/skin-spec";
import { builtinSkin } from "../src/builtin";
import {
  CLASSIC_MANIA_IMAGES,
  maniaConfig,
  maniaImageKeys,
  maniaLayout,
  resolveManiaImages,
  type HasImage,
} from "../src/mania";
import { maniaImageNames, loadSkin } from "../src/skin";
import { readSkinIni } from "../src/skin-ini";

test("maniaImageKeys lists exactly the images a stage looks up", async () => {
  const empty = await loadSkin(async () => null, "empty", { maniaKeys: [] });
  for (let keys = 1; keys <= 10; keys++) {
    const lookups = maniaImageKeys(keys);
    expect(new Set(lookups.map((l) => l.fallback))).toEqual(
      maniaImageNames(empty, keys),
    );
    expect(new Set(lookups.map((l) => l.key)).size).toBe(lookups.length);
  }
  expect(maniaImageKeys(7).slice(0, 6)).toEqual([
    { key: "KeyImage0", column: 0, fallback: "mania-key1", animated: false, instead: [] },
    { key: "KeyImage0D", column: 0, fallback: "mania-key1D", animated: false, instead: [] },
    { key: "NoteImage0", column: 0, fallback: "mania-note1", animated: true, instead: [] },
    { key: "NoteImage0H", column: 0, fallback: "mania-note1H", animated: true, instead: ["NoteImage0"] },
    { key: "NoteImage0L", column: 0, fallback: "mania-note1L", animated: true, instead: [] },
    {
      key: "NoteImage0T",
      column: 0,
      fallback: "mania-note1T",
      animated: true,
      instead: ["NoteImage0H", "NoteImage0"],
    },
  ]);
});

test("column kinds follow lazer's FallbackColumnIndex", () => {
  const kinds = (keys: number, stage?: number) =>
    maniaImageKeys(keys, stage)
      .filter((l) => /^KeyImage\d+$/.test(l.key))
      .map((l) => l.fallback.slice("mania-key".length))
      .join("");
  expect(kinds(4)).toBe("1221");
  expect(kinds(7)).toBe("121S121");
  expect(kinds(10)).toBe("1212112121");
  // Dual stages repeat the pattern per stage (LegacyManiaColumnElement).
  expect(kinds(14, 7)).toBe("121S121121S121");
});

test("every wiki image key is looked up, except the unused WarningArrow", () => {
  const looked = new Set(
    maniaImageKeys(1).map((l) =>
      l.column === undefined ? l.key : l.key.replace(String(l.column), "#"),
    ),
  );
  const wiki = spec
    .filter((s) => s.section === "Mania" && s.type === "image")
    .map((s) => s.key);
  expect(wiki.filter((k) => !looked.has(k))).toEqual(["WarningArrow"]);
});

const ini = [
  "[General]",
  "Version: 2.7",
  "[Mania]",
  "Keys: 4",
  "KeyImage0: keys/up",
  "NoteImage0: notes/dot",
  "NoteImage1H: notes/gone",
  "NoteImage2T: notes/tail",
  "StageLeft: stage/left",
  "Hit300: judgement/300",
].join("\n");
/** Skin files by lookup name; frames as `name-0`. */
const files = new Set([
  "keys/up",
  "notes/dot-0",
  "notes/tail",
  "mania-key2",
  "mania-note2H",
  "stage/left",
  "mania-stage-right",
  "lightingN-0",
]);
const has: HasImage = (name, animated) =>
  files.has(name) || (animated && files.has(`${name}-0`));

test("lookup sources: skin.ini value, default name, built-in look, missing", () => {
  const config = maniaConfig(readSkinIni(ini), 4);
  const by = new Map(resolveManiaImages(config, has).map((r) => [r.key, r]));
  const pick = (key: string) => {
    const r = by.get(key)!;
    return [r.source, r.value, r.name, r.drawn?.name, r.drawn?.builtin];
  };
  expect(pick("KeyImage0")).toEqual(["skin.ini", "keys/up", "keys/up", "keys/up", false]);
  expect(pick("KeyImage1")).toEqual(["default", undefined, "mania-key2", "mania-key2", false]);
  expect(pick("KeyImage3")).toEqual(["built-in", undefined, "mania-key1", "mania-key1", true]);
  // A frame satisfies an animated lookup.
  expect(pick("NoteImage0")).toEqual(["skin.ini", "notes/dot", "notes/dot", "notes/dot", false]);
  // A named head that exists nowhere: the column's note is drawn instead.
  expect(pick("NoteImage1H")).toEqual(["missing", "notes/gone", "notes/gone", "mania-note2", true]);
  expect(by.get("NoteImage1H")!.drawn!.key).toBe("NoteImage1");
  expect(pick("NoteImage2T")).toEqual(["skin.ini", "notes/tail", "notes/tail", "notes/tail", false]);
  expect(pick("StageRight")).toEqual(["default", undefined, "mania-stage-right", "mania-stage-right", false]);
  // render-core's classic look has no stage sides or hint.
  expect(pick("StageHint")).toEqual(["missing", undefined, "mania-stage-hint", undefined, undefined]);
  expect(pick("Hit300")).toEqual(["missing", "judgement/300", "judgement/300", undefined, undefined]);
  expect(pick("Hit100")).toEqual(["built-in", undefined, "mania-hit100", "mania-hit100", true]);
  expect(pick("LightingN")).toEqual(["default", undefined, "lightingN", "lightingN", false]);
});

test("the drawn images are the ones maniaLayout draws", () => {
  for (const keys of [1, 4, 5, 7, 10]) {
    const config = maniaConfig(readSkinIni(ini), keys);
    const resolved = new Map(
      resolveManiaImages(config, has).map((r) => [r.key, r.drawn?.name]),
    );
    const layout = maniaLayout(config, (name, animated) =>
      has(name, animated) || CLASSIC_MANIA_IMAGES.has(name)
        ? { width: 30, height: 20 }
        : undefined,
    );
    layout.columns.forEach((column, i) => {
      expect(column.key?.asset).toBe(resolved.get(`KeyImage${i}`));
      expect(column.keyDown?.asset).toBe(resolved.get(`KeyImage${i}D`));
      expect(column.note?.asset).toBe(resolved.get(`NoteImage${i}`));
      expect(column.head?.asset).toBe(resolved.get(`NoteImage${i}H`));
      expect(column.tail?.asset).toBe(resolved.get(`NoteImage${i}T`));
      expect(column.body).toBe(resolved.get(`NoteImage${i}L`));
      expect(column.light?.asset).toBe(resolved.get("StageLight"));
      expect(column.explosion?.asset).toBe(resolved.get("LightingN"));
      expect(column.holdLight?.asset).toBe(resolved.get("LightingL"));
    });
    expect(layout.stageLeft?.asset).toBe(resolved.get("StageLeft"));
    expect(layout.stageRight?.asset).toBe(resolved.get("StageRight"));
    expect(layout.hint?.asset).toBe(resolved.get("StageHint"));
    expect(layout.stageBottom?.asset).toBe(resolved.get("StageBottom"));
  }
});

// builtinSkin draws on canvases: every call is a no-op stand-in here.
const saved = { canvas: globalThis.OffscreenCanvas };
beforeAll(() => {
  const anything: unknown = new Proxy(() => anything, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => 1 : anything),
    apply: () => anything,
    set: () => true,
  });
  globalThis.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return anything;
    }
    transferToImageBitmap() {
      return { width: this.width, height: this.height, close() {} };
    }
  } as unknown as typeof OffscreenCanvas;
});
afterAll(() => {
  globalThis.OffscreenCanvas = saved.canvas;
});

test("CLASSIC_MANIA_IMAGES are the classic look's mania images", () => {
  const classic = builtinSkin("legacy");
  const mania = [...classic.assets.keys()].filter((name) =>
    /^(mania-|lighting[NL])/.test(name),
  );
  expect(new Set(mania)).toEqual(new Set(CLASSIC_MANIA_IMAGES));
});
