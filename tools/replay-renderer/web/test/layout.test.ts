import { expect, test } from "bun:test";
import settingSchema from "../../render-settings.json";
import {
  DEFAULT_TRANSFORM,
  HUD_KEYS,
  VIEW,
  drawnWidth,
  gridFor,
  hudBox,
  hudTransformFor,
  layoutCells,
  contentBounds,
  fitBounds,
  freeSpot,
  fitScale,
  guidesFor,
  place,
  resizeBox,
  snapMove,
  transformFor,
  uiUnit,
  type HudKey,
  type Rect,
  type Size,
} from "../src/layout";

const close = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);
// A 4-key mania stage: full 480-unit height, narrow and centred on x = 256.
const stage = { x: 256 - 90, y: -48, width: 180, height: 480 };
// Side-by-side cells of a 1920×1080 frame with an 8 px gap.
const cell = { x: 0, y: 0, width: 956, height: 1080 };

test("a mania stage fills the cell height in a narrow cell", () => {
  const { box, target, draw } = place(cell, stage, { x: 0, y: 0, scale: 1 });
  close(box.height, 1080);
  close(box.y, 0);
  close(box.x + box.width / 2, 478);
  // The renderer fits 640×480 by height, so the target is 4:3 at that scale.
  expect(target).toEqual({ width: 1440, height: 1080 });
  // World x = 256 (stage centre) lands on the cell centre.
  close(draw.x + draw.width / 2, 478);
  close(draw.height, 1080);
});

test("osu! fills the height of a wide cell and the width of a narrow one", () => {
  const wide = place({ x: 0, y: 0, width: 1920, height: 1080 }, VIEW, { x: 0, y: 0, scale: 1 });
  close(wide.box.height, 1080);
  close(wide.box.width, 1440);
  close(wide.box.x, 240);
  const narrow = place(cell, VIEW, { x: 0, y: 0, scale: 1 });
  close(narrow.box.width, 956);
  close(narrow.box.height, 717);
  close(narrow.box.y, (1080 - 717) / 2);
});

test("a taiko strip is width-limited", () => {
  const strip = { x: -64, y: 69, width: 640, height: 132 };
  close(fitScale({ x: 0, y: 0, width: 1920, height: 540 }, strip), 3);
});

test("transforms offset by cell fractions and scale about the centre", () => {
  const { box } = place(cell, stage, { x: 0.25, y: -0.1, scale: 0.5 });
  close(box.height, 540);
  close(box.x + box.width / 2, 478 + 239);
  close(box.y + box.height / 2, 540 - 108);
});

test("transformFor inverts place", () => {
  for (const t of [
    { x: 0, y: 0, scale: 1 },
    { x: -0.3, y: 0.42, scale: 1.37 },
    { x: 1.5, y: -2, scale: 0.25 },
  ]) {
    const back = transformFor(cell, stage, place(cell, stage, t).box);
    close(back.x, t.x);
    close(back.y, t.y);
    close(back.scale, t.scale);
  }
});

test("a target rendered for another scale is drawn resampled onto the same box", () => {
  const live = place(cell, stage, { x: 0.1, y: 0, scale: 1.5 }, { width: 1440, height: 1080 });
  const exact = place(cell, stage, { x: 0.1, y: 0, scale: 1.5 });
  close(live.draw.x, exact.draw.x, 4);
  close(live.draw.width, exact.draw.width, 4);
  expect(live.box).toEqual(exact.box);
});

test("render targets never exceed the texture limit", () => {
  const { target } = place({ x: 0, y: 0, width: 7680, height: 7680 }, stage, { x: 0, y: 0, scale: 2 });
  expect(Math.max(target.width, target.height)).toBeLessThanOrEqual(8192);
});

test("contentBounds measures drawn pixels in world units", () => {
  const width = 640,
    height = 480,
    pixels = new Uint8Array(width * height * 4);
  for (let y = 10; y < 470; y++) for (let x = 230; x < 410; x++) pixels[(y * width + x) * 4 + 3] = 255;
  expect(contentBounds(pixels, width, height)).toEqual({ x: 166, y: -38, width: 180, height: 460 });
  expect(contentBounds(new Uint8Array(width * height * 4), width, height)).toEqual(VIEW);
});

test("moves snap edges and centres to the canvas and cells", () => {
  const guides = guidesFor({ x: 0, y: 0, width: 1920, height: 1080 }, [cell]);
  const moved = snapMove({ x: 473, y: 5, width: 10, height: 100 }, guides, 8);
  // The centre (478) meets the cell centre; the top meets the canvas edge.
  expect(moved.box.x).toBe(473);
  expect(moved.box.y).toBe(0);
  expect(moved.lines).toEqual({ x: 478, y: 0 });
  const free = snapMove({ x: 300, y: 300, width: 10, height: 10 }, guides, 8);
  expect(free.lines).toEqual({ x: null, y: null });
});

test("corner resizes keep the opposite corner and the aspect ratio", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  const { box } = resizeBox(start, "se", { x: 500, y: 150 }, { aspect: 2 });
  expect(box).toEqual({ x: 100, y: 100, width: 400, height: 200 });
  const nw = resizeBox(start, "nw", { x: 250, y: 50 }, {}).box;
  expect(nw).toEqual({ x: 250, y: 50, width: 50, height: 150 });
});

test("layouts follow the output aspect", () => {
  // One track always gets the whole frame.
  expect(gridFor(1, 1080, 1920, "grid")).toEqual({ columns: 1, rows: 1 });
  // Side by side is a row on landscape and a column on portrait.
  expect(gridFor(2, 1920, 1080, "side-by-side")).toEqual({ columns: 2, rows: 1 });
  expect(gridFor(2, 1080, 1920, "side-by-side")).toEqual({ columns: 1, rows: 2 });
  expect(gridFor(3, 3840, 1080, "stacked")).toEqual({ columns: 1, rows: 3 });
  // Grid keeps cells as large as possible on their short side.
  expect(gridFor(4, 1920, 1080, "grid")).toEqual({ columns: 2, rows: 2 });
  expect(gridFor(4, 5120, 1440, "grid")).toEqual({ columns: 4, rows: 1 });
  expect(gridFor(3, 1080, 1920, "grid")).toEqual({ columns: 1, rows: 3 });
  expect(gridFor(6, 1080, 1350, "grid")).toEqual({ columns: 2, rows: 3 });
  // Auto: side by side for two, a grid for more.
  expect(gridFor(2, 1080, 1920, "auto")).toEqual({ columns: 1, rows: 2 });
  expect(gridFor(2, 2560, 1080, "auto")).toEqual({ columns: 2, rows: 1 });
  expect(gridFor(4, 1080, 1080, "auto")).toEqual({ columns: 2, rows: 2 });
});

test("cells tile the frame with gaps and whole pixels", () => {
  const cells = layoutCells(2, 1080, 1920, "auto");
  expect(cells).toEqual([
    { x: 0, y: 0, width: 1080, height: 956 },
    { x: 0, y: 964, width: 1080, height: 956 },
  ]);
  const grid = layoutCells(3, 1920, 1080, "grid");
  expect(grid.length).toBe(3);
  for (const cell of grid) {
    expect(cell.x + cell.width).toBeLessThanOrEqual(1920);
    expect(cell.y + cell.height).toBeLessThanOrEqual(1080);
  }
  expect(() => layoutCells(0, 1920, 1080, "auto")).toThrow();
});

test("a mania stage's side images widen its target up to the cell, the stage staying put", () => {
  const frame = { x: 0, y: 0, width: 1920, height: 1080 };
  const plain = place(frame, stage, DEFAULT_TRANSFORM);
  const decorated = place(frame, stage, DEFAULT_TRANSFORM, undefined, 2560);
  // The same scale and stage box; the target spans the cell (853 world units at 2.25 px each).
  expect(decorated.target.height).toBe(plain.target.height);
  expect(decorated.box).toEqual(plain.box);
  expect(decorated.target.width).toBe(1920);
  close(decorated.draw.x, 0);
  close(decorated.draw.width, 1920);
  // Narrower decorations widen it only as far as they reach.
  expect(place(frame, stage, DEFAULT_TRANSFORM, undefined, 700).target.width).toBe(1575);
  // The measured width is symmetric about the stage centre and never below the view.
  const row = new Uint8Array(2560 * 4);
  row[2000 * 4 + 3] = 255;
  expect(drawnWidth(row, 2560, 1)).toBe(2 * (2001 - 1280));
  expect(drawnWidth(new Uint8Array(2560 * 4), 2560, 1)).toBe(VIEW.width);
});

test("HUD layers hang from their corner in lazer UI units; accuracy hangs under the score", () => {
  const cell = { x: 100, y: 0, width: 1080, height: 1920 };
  const unit = uiUnit(cell);
  close(unit, 1080 / 1024);
  const size = { width: 200, height: 40 };
  // Score hangs from the top right: 20 units in from the right edge, 30 down.
  const score = hudBox(cell, "score", { x: 20, y: 30, scale: 1 }, size);
  close(score.x + score.width, 100 + 1080 - 20 * unit);
  close(score.y, 30 * unit);
  close(score.height, 40 * unit);
  // Accuracy's vertical margin is from the score's bottom edge.
  const accuracy = hudBox(cell, "accuracy", { x: 17, y: 9, scale: 1 }, size, score);
  close(accuracy.y, score.y + score.height + 9 * unit);
  // Combo hangs from the bottom left.
  const combo = hudBox(cell, "combo", { x: 20, y: 20, scale: 2 }, size);
  close(combo.x, 100 + 20 * unit);
  close(combo.y + combo.height, 1920 - 20 * unit);
  close(combo.height, size.height * 2 * unit);
  for (const key of HUD_KEYS) {
    const t = { x: 31, y: 77, scale: 1.4 },
      below = key === "accuracy" ? score : undefined;
    const back = hudTransformFor(cell, key, hudBox(cell, key, t, size, below), size, below);
    close(back.x, t.x);
    close(back.y, t.y);
    close(back.scale, t.scale);
  }
});

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** The classic skin's HUD at scale 1: 8 score digits and "100.00%" at the
 *  counters' scales, "0000x" at the combo counter's 1.28, and the 695×44
 *  health bar. */
const CLASSIC: Record<HudKey, Size> = {
  score: { width: 8 * 31 * 0.96, height: 46 * 0.96 },
  accuracy: { width: (5 * 31 + 15 + 54) * 0.576, height: 46 * 0.576 },
  combo: { width: (4 * 31 + 28) * 1.28, height: 46 * 1.28 },
  health: { width: 695, height: 44 },
};
const defaultHud = (cell: Rect) => {
  const value = (key: string) => settingSchema.find((rule) => rule.key === key)!.default;
  const box = (key: HudKey, below?: Rect) =>
    hudBox(
      cell,
      key,
      { x: value(`hud.${key}.margin_x`), y: value(`hud.${key}.margin_y`), scale: value(`hud.${key}.scale`) },
      CLASSIC[key],
      below,
    );
  const score = box("score");
  return { score, accuracy: box("accuracy", score), combo: box("combo"), health: box("health") };
};

test("the default HUD follows lazer's arrangement and never overlaps, in any cell", () => {
  const frames = [
    [1920, 1080], [2560, 1440], [1080, 1920], [1080, 1350], [1080, 1080], [3440, 1440], [5120, 1440], [854, 480], [720, 1280],
  ];
  for (const [width, height] of frames)
    for (const layout of ["auto", "side-by-side", "stacked", "grid"] as const)
      for (const count of [1, 2, 3, 4, 6])
        for (const cell of layoutCells(count, width, height, layout)) {
          const hud = defaultHud(cell);
          const unit = uiUnit(cell);
          for (const box of Object.values(hud)) {
            expect(box.x).toBeGreaterThanOrEqual(cell.x - 1e-9);
            expect(box.y).toBeGreaterThanOrEqual(cell.y - 1e-9);
            expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width + 1e-9);
            expect(box.y + box.height).toBeLessThanOrEqual(cell.y + cell.height + 1e-9);
          }
          for (const [i, a] of HUD_KEYS.entries())
            for (const b of HUD_KEYS.slice(i + 1)) expect(overlap(hud[a], hud[b])).toBe(false);
          // lazer's legacy HUD: health flush top left, score 10 in from the
          // right, accuracy 17 in and 9 under it, combo 10 in from the bottom left.
          expect([hud.health.x, hud.health.y]).toEqual([cell.x, cell.y]);
          close(hud.score.x + hud.score.width, cell.x + cell.width - 10 * unit);
          close(hud.accuracy.x + hud.accuracy.width, cell.x + cell.width - 17 * unit);
          close(hud.accuracy.y, hud.score.y + hud.score.height + 9 * unit);
          close(hud.combo.x, cell.x + 10 * unit);
          close(hud.combo.y + hud.combo.height, cell.y + cell.height - 10 * unit);
        }
});

test("a new overlay goes where it covers nothing, in every player's cell", () => {
  const cells = layoutCells(2, 1920, 1080, "side-by-side");
  const stage = (cell: Rect) => ({ x: cell.x + cell.width / 2 - 200, y: cell.y, width: 400, height: cell.height });
  const scene = cells.map((cell) => ({ cell, obstacles: [stage(cell), ...Object.values(defaultHud(cell))] }));
  const spot = freeSpot(scene, 180, 80, { margin: 16, step: 8 })!;
  expect(spot).not.toBeNull();
  for (const { cell, obstacles } of scene) {
    const box = { x: cell.x + spot.x, y: cell.y + spot.y, width: 180, height: 80 };
    expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width);
    for (const obstacle of obstacles) expect(overlap(box, obstacle)).toBe(false);
  }
  // Top-most first: right under the health bar on the left.
  const health = defaultHud(cells[0]).health;
  expect(spot.y).toBeGreaterThanOrEqual(health.y + health.height - cells[0].y + 16);
  expect(spot.y).toBeLessThan(health.y + health.height - cells[0].y + 16 + 8);
  // Nothing free: a page wider than the space beside the stage.
  expect(freeSpot(scene, 700, 80, { margin: 16 })).toBeNull();
  expect(freeSpot([], 10, 10)).toBeNull();
});

test("mania stages fit by their width only, so equal skins scale equally", () => {
  // Two probes of the same stage: one found transparent rows at the top.
  const a = fitBounds(3, { x: 166, y: -48, width: 180, height: 480 });
  const b = fitBounds(3, { x: 166, y: 10, width: 180, height: 400 });
  expect(a).toEqual(b);
  expect(place(cell, a, { x: 0, y: 0, scale: 1 })).toEqual(place(cell, b, { x: 0, y: 0, scale: 1 }));
  // Taiko keeps its measured strip.
  const strip = { x: -64, y: 69, width: 640, height: 132 };
  expect(fitBounds(1, strip)).toEqual(strip);
});

test("a mania stage stays centred like lazer's when its decorations are lopsided", () => {
  // A StageLeft image reaching the view's left edge, a narrow StageRight.
  const fitted = fitBounds(3, { x: -64, y: -48, width: 420, height: 480 });
  expect(fitted).toEqual({ x: -64, y: -48, width: 640, height: 480 });
  expect(fitted.x + fitted.width / 2).toBe(256);
  // The wider side decides, whichever it is.
  expect(fitBounds(3, { x: 200, y: -48, width: 200, height: 480 })).toEqual({ x: 112, y: -48, width: 288, height: 480 });
});

test("auto layout makes the smallest playfield as large as it can", () => {
  const taiko = { x: -64, y: 69, width: 640, height: 132 };
  const maniaStage = { x: 166, y: -48, width: 180, height: 480 };
  // Taiko strips stack on a wide frame; mania stages and osu! fields sit side by side.
  expect(gridFor(2, 1920, 1080, "auto", [taiko, taiko])).toEqual({ columns: 1, rows: 2 });
  expect(gridFor(2, 1920, 1080, "auto", [maniaStage, maniaStage])).toEqual({ columns: 2, rows: 1 });
  expect(gridFor(2, 1920, 1080, "auto", [VIEW, VIEW])).toEqual({ columns: 2, rows: 1 });
  // On a square frame two osu! fields stack (wider than tall), two stages do not.
  expect(gridFor(2, 1080, 1080, "auto", [VIEW, VIEW])).toEqual({ columns: 1, rows: 2 });
  expect(gridFor(2, 1080, 1080, "auto", [maniaStage, maniaStage])).toEqual({ columns: 2, rows: 1 });
  // Four mania stages on 16:9: one row; four taiko strips: one column.
  expect(gridFor(4, 1920, 1080, "auto", Array(4).fill(maniaStage))).toEqual({ columns: 4, rows: 1 });
  expect(gridFor(4, 1920, 1080, "auto", Array(4).fill(taiko))).toEqual({ columns: 1, rows: 4 });
  // Explicit layouts ignore the contents.
  expect(gridFor(2, 1920, 1080, "side-by-side", [taiko, taiko])).toEqual({ columns: 2, rows: 1 });
});
