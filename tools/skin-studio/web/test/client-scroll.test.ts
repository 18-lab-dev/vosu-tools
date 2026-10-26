import { expect, test } from "bun:test";
import type { ManiaScroll } from "@vosu-tools/client-skin/scroll";
import { ClientScroll } from "../src/client-scroll";

// `/settings/mania` as vosu 1.2 reports it (src/api/v2/wire.rs).
const stable = (scrollSpeed: number, direction = 1) => ({
  speedBPMScale: false,
  usePerBeatmapSpeedScale: false,
  scrollSpeed,
  scrollDirection: { number: direction, name: direction ? "down" : "up" },
});

function setup() {
  const shown: ManiaScroll[] = [];
  const drawn: [number, boolean][] = [];
  const scroll = new ClientScroll((s) => shown.push(s));
  const target = { setScroll: (speed: number, up: boolean) => void drawn.push([speed, up]) };
  return { scroll, target, shown, drawn };
}

test("the speed source: the Scroll field, then the client, then lazer's default", () => {
  const { scroll, target, shown, drawn } = setup();
  // No client yet: lazer's default, and the hint says why.
  scroll.add(target);
  expect(drawn.at(-1)).toEqual([8, false]);
  scroll.setClient(null, stable(24));
  expect(shown.at(-1)).toMatchObject({ setting: 8, source: "default" });
  expect(shown.at(-1)!.note).toBe("No osu! client is connected; lazer's default (8) is used.");
  // The client's own speed and direction.
  scroll.setClient("stable", stable(24, 0));
  expect(drawn.at(-1)).toEqual([24, true]);
  expect(shown.at(-1)!.note).toBe("Your osu! scroll speed (24).");
  // lazer reports a double.
  scroll.setClient("lazer", { scrollSpeed: 25, scrollSpeedValue: 24.7, scrollDirection: { number: 1 } });
  expect(drawn.at(-1)).toEqual([24.7, false]);
  // The field wins; blank (0 / NaN from an empty number input) follows the client again.
  scroll.setOverride(30);
  expect(drawn.at(-1)).toEqual([30, false]);
  expect(shown.at(-1)).toMatchObject({ source: "override", note: "Set here; clear it to follow osu!." });
  for (const blank of [null, 0, Number.NaN]) {
    scroll.setOverride(blank);
    expect(shown.at(-1)).toMatchObject({ source: "client", setting: 24.7 });
  }
  // A client vosu cannot read the setting of.
  scroll.setClient("stable", { scrollSpeed: 0 });
  expect(shown.at(-1)).toMatchObject({ setting: 8, source: "default" });
  expect(shown.at(-1)!.note).toContain("does not report its scroll speed");
});

test("live changes reach every preview; the demo maps play at rate 1", () => {
  const { scroll, target, drawn } = setup();
  const keymodes: [number, boolean][] = [];
  scroll.add(target);
  scroll.add({ setScroll: (speed, up) => void keymodes.push([speed, up]) });
  for (const speed of [15, 30]) {
    scroll.setClient("stable", stable(speed));
    // The setting itself: at rate 1 render-core's scrollSpeed is the client's.
    expect(drawn.at(-1)).toEqual([speed, false]);
    expect(keymodes.at(-1)).toEqual([speed, false]);
  }
  // A preview opened later starts at the current speed.
  const late: [number, boolean][] = [];
  scroll.add({ setScroll: (speed, up) => void late.push([speed, up]) });
  expect(late).toEqual([[30, false]]);
});
