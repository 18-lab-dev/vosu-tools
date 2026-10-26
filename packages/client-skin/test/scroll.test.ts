import { expect, test } from "bun:test";
import {
  LAZER_DEFAULT_SCROLL_SPEED,
  maniaScroll,
  readManiaSettings,
} from "../src/scroll";

// `/settings/mania` as vosu 1.2 reports it (src/api/v2/wire.rs).
const lazer = readManiaSettings({
  speedBPMScale: null,
  usePerBeatmapSpeedScale: null,
  scrollSpeed: 24,
  scrollDirection: { number: 1, name: "down" },
  scrollSpeedValue: 24.7,
  scrollTime: 11485 / 24.7,
});
const stable = readManiaSettings({
  speedBPMScale: false,
  usePerBeatmapSpeedScale: false,
  scrollSpeed: 27,
  scrollDirection: { number: 1, name: "down" },
});

test("each client's own setting is read", () => {
  // lazer: the double-precision value, not the rounded legacy integer.
  expect(lazer).toEqual({ scrollSpeed: 24.7, scrollUp: false, bpmScale: false });
  expect(stable).toEqual({ scrollSpeed: 27, scrollUp: false, bpmScale: false });
  // stable's per-beatmap speed wins when the client uses per-beatmap speeds.
  expect(
    readManiaSettings({
      scrollSpeed: 20,
      usePerBeatmapSpeedScale: true,
      perBeatmapScrollSpeed: 31,
      speedBPMScale: true,
    }),
  ).toEqual({ scrollSpeed: 31, scrollUp: false, bpmScale: true });
  // lazer's upward scrolling (vosu's names: 0 = up).
  expect(readManiaSettings({ scrollSpeed: 8, scrollDirection: { number: 0 } }).scrollUp).toBe(true);
  // Unavailable: absent, null or zero.
  for (const value of [undefined, null, {}, { scrollSpeed: 0 }, { scrollSpeed: null }])
    expect(readManiaSettings(value).scrollSpeed).toBeNull();
});

test("the speed source: override, then the tool's setting, then the client, then lazer's default", () => {
  expect(maniaScroll({ override: 15, setting: 22, client: lazer })).toMatchObject({
    setting: 15,
    source: "override",
    speed: 15,
  });
  expect(maniaScroll({ override: null, setting: 22, client: lazer })).toMatchObject({
    setting: 22,
    source: "setting",
  });
  expect(maniaScroll({ override: null, client: lazer })).toMatchObject({
    setting: 24.7,
    source: "client",
    speed: 24.7,
    note: "Your osu! scroll speed (24.7).",
  });
  expect(maniaScroll({ client: stable })).toMatchObject({ setting: 27, source: "client" });
  // A blank override (0 / NaN from an empty field) is no override.
  for (const override of [0, Number.NaN, null, undefined])
    expect(maniaScroll({ override, client: stable }).source).toBe("client");
  // Overrides keep to the clients' 1-40 scale.
  expect(maniaScroll({ override: 99, client: null }).setting).toBe(40);
  expect(maniaScroll({ override: 0.2, client: null }).setting).toBe(1);
});

test("without a client or its setting, lazer's default applies and the hint says so", () => {
  const none = maniaScroll({ client: null });
  expect(LAZER_DEFAULT_SCROLL_SPEED).toBe(8);
  expect(none).toMatchObject({ setting: 8, source: "default", speed: 8 });
  expect(none.note).toBe("No osu! client is connected; lazer's default (8) is used.");
  const unreported = maniaScroll({ client: readManiaSettings({ scrollSpeed: 0 }) });
  expect(unreported).toMatchObject({ setting: 8, source: "default" });
  expect(unreported.note).toBe("osu! does not report its scroll speed; lazer's default (8) is used.");
  // stable's BPM-scaled mode is named in the hint.
  const scaled = maniaScroll({ client: readManiaSettings({ scrollSpeed: 20, speedBPMScale: true }) });
  expect(scaled.note).toContain("with BPM");
});

test("rate: notes move as fast on screen at any clock rate", () => {
  // render-core: at scrollSpeed s notes travel the default scroll length in
  // 11485 / s map milliseconds. A clock at `rate` map ms per real ms covers
  // that in 11485 / (s * rate) real ms, so `speed / rate` keeps the client's
  // real-time scroll (lazer multiplies its time range by tempo × frequency).
  const realMsPerLength = (speed: number, rate: number) => 11485 / speed / rate;
  const atOne = maniaScroll({ client: lazer, rate: 1 });
  for (const rate of [0.75, 1.1, 1.5, 2]) {
    const scroll = maniaScroll({ client: lazer, rate });
    expect(scroll.setting).toBe(24.7);
    expect(scroll.speed).toBeCloseTo(24.7 / rate, 10);
    expect(realMsPerLength(scroll.speed, rate)).toBeCloseTo(realMsPerLength(atOne.speed, 1), 10);
  }
  // A generated 1.1x map plays at rate 1 in the client and in Practice's
  // preview: its speed is the setting itself.
  expect(maniaScroll({ client: stable, rate: 1 }).speed).toBe(27);
  // Nonsense rates fall back to 1.
  for (const rate of [0, -1, Number.NaN]) expect(maniaScroll({ client: stable, rate }).speed).toBe(27);
});
