import { expect, test } from "bun:test";
import {
  LiveClock,
  applyField,
  emptyState,
  followGame,
  hiddenForGameplay,
  subscriptionPointers,
  type GameState,
  type LiveStatus,
} from "../src/live";
import { parseSettings, readSettings } from "../src/settings";

test("the playfield hides only during the user's own gameplay", () => {
  const state = emptyState();
  const at = (number: number, source: string | null | undefined) => {
    state.state = number;
    state.source = source;
    return hiddenForGameplay(state);
  };
  expect(at(5, null)).toBe(false); // song select
  expect(at(7, null)).toBe(false); // results
  expect(at(2, "player")).toBe(true); // own play, incl. multiplayer
  expect(at(2, undefined)).toBe(true); // older vosu: provenance unknown
  expect(at(2, null)).toBe(true); // gameplay without provenance
  expect(at(2, "bogus")).toBe(true);
  for (const source of ["replay", "spectator", "watching", "autoplay"])
    expect(at(2, source)).toBe(false);
});

test("an absent /play/source stays unknown; null means outside gameplay", () => {
  const state = emptyState();
  applyField(state, "/play/source", undefined);
  expect(state.source).toBeUndefined();
  applyField(state, "/play/source", null);
  expect(state.source).toBeNull();
  applyField(state, "/play/source", "replay");
  expect(state.source).toBe("replay");
});

test("fields map from the v2 document", () => {
  const state = emptyState();
  applyField(state, "/client", "lazer");
  applyField(state, "/beatmap/time", {
    live: 1234.5,
    rate: 1.5,
    running: true,
    firstObject: 0,
  });
  applyField(state, "/settings/mania", {
    scrollSpeed: 24,
    scrollSpeedValue: 24.7,
    // lazer's ManiaScrollingDirection: Up = 0, Down = 1 (vosu names them so).
    scrollDirection: { number: 0, name: "up" },
  });
  applyField(state, "/play/mods/array", [
    { acronym: "DT", settings: { speed_change: 1.3 } },
    { acronym: "HD" },
    { nope: 1 },
  ]);
  applyField(state, "/settings/skin/ignoreBeatmapSkins", true);
  applyField(state, "/settings/visual", {
    hitLighting: false,
    beatmapColours: null,
    snakingInSliders: false,
  });
  expect(state.client).toBe("lazer");
  expect([state.time, state.rate, state.running]).toEqual([1234.5, 1.5, true]);
  expect(state.mania).toEqual({ scrollSpeed: 24.7, scrollUp: true });
  expect(state.mods).toEqual([
    { acronym: "DT", settings: { speed_change: 1.3 } },
    { acronym: "HD", settings: {} },
  ]);
  // visual.beatmapColours null keeps the stable-style ignoreBeatmapSkins answer.
  expect(state.visual).toEqual({
    hitLighting: false,
    beatmapColours: false,
    snakingIn: false,
  });
});

test("stable per-beatmap scroll speed applies when enabled", () => {
  const state = emptyState();
  applyField(state, "/settings/mania", {
    scrollSpeed: 20,
    usePerBeatmapSpeedScale: true,
    perBeatmapScrollSpeed: 27,
    scrollDirection: { number: 1, name: "down" },
  });
  expect(state.mania.scrollSpeed).toBe(27);
  expect(state.mania.scrollUp).toBe(false);
  applyField(state, "/settings/mania", { scrollSpeed: 0 });
  expect(state.mania.scrollSpeed).toBeNull();
});

test("subscription pointers never overlap (vosu rejects parent/child pairs)", () => {
  for (const a of subscriptionPointers)
    for (const b of subscriptionPointers)
      if (a !== b) expect(b.startsWith(`${a}/`)).toBe(false);
});

test("the clock extrapolates reported rate and running state", () => {
  const clock = new LiveClock();
  expect(clock.read(0)).toBeNull();
  clock.update(1000, 1.5, true, 0);
  expect(clock.read(100)).toBeCloseTo(1150);
  // Extrapolation stops a second after the last frame instead of drifting.
  expect(clock.read(10_000)).toBeCloseTo(2500);
  clock.update(2000, 1, false, 200);
  expect(clock.read(400)).toBe(2000);
});

test("without reported rate the clock estimates it from frames", () => {
  const clock = new LiveClock();
  clock.update(0, null, null, 0);
  for (let i = 1; i <= 20; i++) clock.update(i * 150, null, null, i * 100);
  // 150 map ms per 100 wall ms: a 1.5× rate.
  expect(clock.read(2050)! - 3000).toBeCloseTo(75, 0);
  // One frame that did not advance is jitter; 300 ms without progress is a pause.
  clock.update(3000, null, null, 2100);
  expect(clock.read(2150)!).toBeGreaterThan(3000);
  clock.update(3000, null, null, 2350);
  expect(clock.read(2500)).toBe(3000);
});

/**
 * A synthetic vosu stream: the track runs at the client's actual rate (DT,
 * then a lazer custom speed change, a seek, HT), frames arrive every 15-150 ms
 * and carry a live time sampled 0-40 ms before they arrive. The preview is
 * read every display frame for ten minutes. `lazer` frames carry the track
 * clock (rate and running), `stable` frames only the selected mods' rate (DT,
 * whatever the track does), `older` frames neither.
 */
function drift(source: "lazer" | "stable" | "older") {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const segments = [
    { from: 0, start: 1000, rate: 1.5 },
    { from: 180_000, start: null, rate: 1.23 },
    { from: 300_000, start: 40_000, rate: 1.23 }, // seek
    { from: 420_000, start: null, rate: 0.75 },
  ];
  const track = (wall: number) => {
    let time = 0,
      rate = 1;
    for (const [i, s] of segments.entries()) {
      if (wall < s.from) break;
      const until = Math.min(wall, segments[i + 1]?.from ?? Infinity);
      if (s.start !== null) time = s.start;
      time += (until - s.from) * s.rate;
      rate = s.rate;
    }
    return { time, rate };
  };
  const clock = new LiveClock();
  let nextFrame = 0,
    previous = -Infinity,
    backwards = 0;
  const errors: number[] = [];
  for (let wall = 0; wall < 600_000; wall += 1000 / 60) {
    while (nextFrame <= wall) {
      const sampled = track(nextFrame - random() * 40);
      clock.update(
        sampled.time,
        source === "lazer" ? sampled.rate : source === "stable" ? 1.5 : null,
        source === "lazer" ? true : null,
        nextFrame,
      );
      nextFrame += 15 + random() * 135;
    }
    const shown = clock.read(wall)!,
      actual = track(wall).time;
    // Ignore the moments right after the seek and the rate changes.
    if (!segments.some((s) => wall >= s.from && wall < s.from + 2000)) {
      errors.push(shown - actual);
      if (shown < previous) backwards++;
    }
    previous = shown;
  }
  const worst = Math.max(...errors.map(Math.abs)),
    mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length,
    minute = errors.length / 10;
  return {
    worst,
    backwards,
    first: mean(errors.slice(0, minute)),
    last: mean(errors.slice(-minute)),
  };
}

test("the followed clock stays in sync over ten minutes of rate changes", () => {
  for (const source of ["lazer", "stable", "older"] as const) {
    const result = drift(source);
    // Bounded by the frames' sampling age (0-40 ms of track time at ≤1.5×).
    expect(result.worst).toBeLessThan(source === "lazer" ? 90 : 140);
    expect(result.backwards).toBe(0);
    // No drift: the average lag in the last minute matches the first one's.
    expect(Math.abs(result.last - result.first)).toBeLessThan(25);
  }
});

test("settings normalise and fall back to defaults", async () => {
  expect(
    parseSettings({ skin: "argon", mania_scroll_speed: 31, show_bar: false }),
  ).toMatchObject({
    skin: "argon",
    maniaScrollSpeed: 31,
    showBar: false,
    showProgress: true,
  });
  expect(
    parseSettings({ skin: "nope", mania_scroll_speed: 99, note_speed: "x" }),
  ).toMatchObject({
    skin: "client",
    maniaScrollSpeed: 0,
    noteSpeed: 1,
  });
  const bridge = { tool: { id: "map-preview" } };
  const viaRoute = await readSettings(bridge, (async (url: string) => {
    expect(url).toBe("/tools/map-preview/_settings");
    return Response.json({ values: { skin: "triangles" } });
  }) as unknown as typeof fetch);
  expect(viaRoute).toMatchObject({
    source: "vosu",
    settings: { skin: "triangles" },
  });
  const old = await readSettings(
    bridge,
    (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
  );
  expect(old).toMatchObject({
    source: "defaults",
    settings: { skin: "client" },
  });
  const viaBridge = await readSettings({
    ...bridge,
    settings: async () => ({ controls_open: true }),
  });
  expect(viaBridge.settings.controlsOpen).toBe(true);
});

test("followGame merges frames, treats absent fields as unknown and maps status", () => {
  let onFrame: (frame: unknown) => void = () => {},
    onStatus: (s: "connecting" | "open" | "closed") => void = () => {};
  const states: GameState[] = [],
    statuses: LiveStatus[] = [];
  const index = (p: string) => subscriptionPointers.indexOf(p as never);
  followGame(
    (fields, frame, status) => {
      expect(fields).toEqual(subscriptionPointers);
      onFrame = frame;
      onStatus = status!;
      return () => {};
    },
    (s) => states.push(structuredClone(s)),
    (s) => statuses.push(s),
  );
  onStatus("open");
  // An older host: no /play/source in the initial frame.
  onFrame([
    0,
    1,
    [
      [index("/client"), "stable"],
      [index("/state/number"), 2],
    ],
  ]);
  expect(states.at(-1)!.source).toBeUndefined();
  expect(hiddenForGameplay(states.at(-1)!)).toBe(true);
  onFrame([1, 2, [[index("/play/source"), "watching"]], []]);
  expect(hiddenForGameplay(states.at(-1)!)).toBe(false);
  onFrame([1, 3, [], [index("/play/source")]]);
  expect(states.at(-1)!.source).toBeUndefined();
  onStatus("closed");
  onStatus("connecting");
  // A reconnect starts from a fresh state.
  onFrame([0, 1, [[index("/client"), "lazer"]]]);
  expect(states.at(-1)).toMatchObject({ client: "lazer", state: null });
  expect(statuses).toEqual([
    "connecting",
    "waiting",
    "live",
    "live",
    "live",
    "lost",
    "connecting",
    "live",
  ]);
});
