import { expect, test } from "bun:test";
import {
  comboChanges,
  formatAccuracy,
  healthFrame,
  hudOf,
  hudText,
  legacyComboFrame,
  maniaComboFrame,
  rolling,
  rollingAt,
  type HealthSource,
} from "../src/hud";
import { maniaConfig } from "../src/mania";
import type { Skin } from "../src/skin";

/** A skin of blank images with these SD sizes (bitmaps at `density`×). */
function skin(sizes: Record<string, [number, number]>, ini: Record<string, string> = {}, density = 1): Skin {
  const assets = new Map<string, ImageBitmap>(),
    pixelScale = new Map<string, number>();
  for (const [name, [w, h]] of Object.entries(sizes)) {
    assets.set(name, { width: w * density, height: h * density, close() {} } as ImageBitmap);
    pixelScale.set(name, density);
  }
  return { name: "test", assets, pixelScale, sections: new Map([["Fonts", [ini]]]) };
}
const classic = skin({ "score-5": [30, 46], "score-1": [16, 46], "score-dot": [14, 46], "scorebar-bg": [695, 44] });

test("score text: fixed-width digits centred in the width of '5', own-width dot, ScoreOverlap between characters", () => {
  const own = skin(
    { "fonts/s-5": [20, 40], "fonts/s-1": [10, 40], "fonts/s-dot": [8, 44], "fonts/s-percent": [24, 40] },
    { ScorePrefix: "fonts/s", ScoreOverlap: "2" },
    2,
  );
  const text = hudText(hudOf(own, classic).score, "15.5%");
  expect(text.glyphs.map((g) => g.x)).toEqual([5, 18, 36, 42, 60]);
  expect(text.width).toBe(84);
  expect(text.height).toBe(44);
  // A custom prefix never borrows the classic font: missing characters are skipped.
  expect(hudText(hudOf(own, classic).score, "1x").glyphs).toHaveLength(1);
  // The default prefix falls back glyph by glyph.
  expect(hudText(hudOf(skin({ "score-5": [20, 40] }), classic).score, "15").glyphs.map((g) => g.image.width)).toEqual([16, 20]);
});

test("combo text uses ComboPrefix and ComboOverlap, proportionally spaced", () => {
  const own = skin({ "c/n-1": [10, 40], "c/n-5": [20, 40], "c/n-x": [12, 30] }, { ComboPrefix: "c/n", ComboOverlap: "3" });
  const combo = hudOf(own, classic).combo;
  expect(hudText(combo, "15x", false).glyphs.map((g) => g.x)).toEqual([0, 7, 24]);
  // Without a ComboPrefix the combo font is the score font's default name, "score".
  expect(hudText(hudOf(skin({}), classic).combo, "1", false).glyphs[0].image.width).toBe(16);
});

test("the default combo counter pops the new count out and shows it 160 ms later; breaks roll down", () => {
  const changes = comboChanges([
    { time: 0, combo: 1 },
    { time: 50, combo: 1 },
    { time: 1000, combo: 2 },
    { time: 2000, combo: 0 },
  ]);
  expect(changes).toEqual([{ time: 0, combo: 1 }, { time: 1000, combo: 2 }, { time: 2000, combo: 0 }]);
  expect(legacyComboFrame(changes, -1).alpha).toBe(0);
  // lazer shows "0x" until the small pop catches up with the pop-out.
  const early = legacyComboFrame(changes, 1100);
  expect([early.count, early.popOut?.count]).toEqual([1, 2]);
  expect(early.popOut!.scale).toBeCloseTo(1.56 - 0.56 / 3, 9);
  const caught = legacyComboFrame(changes, 1185);
  expect([caught.count, caught.stretch[0]]).toEqual([2, 1 + 0.1 * 0.25]);
  expect(legacyComboFrame(changes, 1400).popOut).toBeNull();
  // The break rolls 2 → 0 at 20 ms a count, then fades out over 100 ms.
  expect(legacyComboFrame(changes, 2015).count).toBe(1);
  const gone = legacyComboFrame(changes, 2080);
  expect([gone.count, gone.alpha]).toEqual([0, 0.5]);
});

test("the mania combo counter stretches each increment and pops a break out in ColourBreak", () => {
  const changes = comboChanges([
    { time: 0, combo: 1 },
    { time: 500, combo: 2 },
    { time: 1000, combo: 0 },
  ]);
  const hit = maniaComboFrame(changes, 500);
  expect([hit.count, hit.stretch]).toEqual([2, [1, 1.4]]);
  expect(maniaComboFrame(changes, 900).stretch).toEqual([1, 1]);
  const broken = maniaComboFrame(changes, 1100);
  expect(broken.popOut).toEqual({ count: 2, alpha: 0.4, scale: 2.5 });
  expect([broken.count, broken.alpha]).toEqual([0, 0]);
  // ComboPosition (default 111) in the stage's 1.6× units, per key count.
  const sections = new Map([["Mania", [{ Keys: "7", ComboPosition: "200", ColourBreak: "0,0,255" }]]]);
  expect(maniaConfig({ sections }, 7).comboPosition).toBe(320);
  expect(maniaConfig({ sections }, 4).comboPosition).toBeCloseTo(177.6, 9);
  expect(maniaConfig({ sections }, 7).colours.get("ColourBreak")?.slice(0, 3)).toEqual([0, 0, 1]);
});

test("the health bar takes every piece from the first skin with a background", () => {
  const own = skin({ "scorebar-colour": [400, 20], "scorebar-ki": [10, 10] });
  expect(hudOf(own, classic).health.bg?.width).toBe(695);
  expect(hudOf(own, classic).health.fill).toHaveLength(0);
  const withBg = skin({ "scorebar-bg": [1, 1], "scorebar-colour": [400, 20], "scorebar-ki": [10, 10] });
  const health = hudOf(withBg, classic).health;
  expect([health.bg?.width, health.fill[0]?.width, health.newStyle, health.ki?.width]).toEqual([1, 400, false, 10]);
});

test("rolling counters ease from the value shown when each change began", () => {
  const curve = rolling([0, 500], [100, 200], 0, 1000);
  expect(rollingAt(curve, -1)).toBe(0);
  expect(rollingAt(curve, 500)).toBe(75);
  // Half way through the second roll: 75 → 200 with Easing.Out.
  expect(rollingAt(curve, 1000)).toBeCloseTo(75 + 125 * 0.75, 9);
  expect(rollingAt(curve, 5000)).toBe(200);
  expect(formatAccuracy(0.99999)).toBe("99.99%");
  expect(formatAccuracy(1)).toBe("100.00%");
});

test("health fills 0.05 per 150 ms from the HUD's appearance until the health first changes", () => {
  const source: HealthSource = {
    value: (time) => (time < 5000 ? 1 : 0.6),
    start: 0,
    settled: 5000,
    hits: [6000],
  };
  expect(healthFrame(source, 100).current).toBe(0);
  expect(healthFrame(source, 225).current).toBeCloseTo(0.025, 9);
  expect(healthFrame(source, 1500).current).toBeCloseTo(0.45, 9);
  // Each step flashes the marker.
  expect(healthFrame(source, 1510).flash?.age).toBe(10);
  expect(healthFrame(source, 3500).current).toBe(1);
  expect(healthFrame(source, 4000).fill).toBeCloseTo(1, 6);
  // A change of health ends the fill; hits flash, epic from half health up.
  const after = healthFrame(source, 6050);
  expect(after.current).toBe(0.6);
  expect(after.flash).toEqual({ age: 50, epic: true });
  expect(after.bulge).toBeCloseTo(1.2 - (0.4 * 50) / 150, 9);
  expect(healthFrame(source, 7000).bulge).toBe(0.8);
  // Interrupted early, the fill jumps to the health.
  expect(healthFrame({ ...source, settled: 400 }, 450).current).toBe(1);
});
