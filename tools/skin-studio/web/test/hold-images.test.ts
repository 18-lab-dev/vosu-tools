import { expect, test } from "bun:test";
import type { Offsets } from "../src/calibrate";
import { holdPairKey } from "../src/hold-images";
import type { SlotImage } from "../src/keymodes";

const release: Offsets = { count: 80, mean: 10, spread: 2, velocity: 1, distance: 10 };
const tail: SlotImage = { skin: "uploads:", name: "tail", files: [{ from: "derive/a.png", suffix: ".png" }] };
const body: SlotImage = { skin: "uploads:", name: "body", files: [{ from: "derive/body-a.png", suffix: ".png" }] };

test("release calibration never aliases distinct same-name derived files", () => {
  const first = holdPairKey(release, tail, body, 112, 0, true);
  const otherTail = { ...tail, files: [{ from: "derive/b.png", suffix: ".png" }] };
  const otherBody = { ...body, files: [{ from: "derive/body-b.png", suffix: ".png" }] };
  expect(holdPairKey(release, otherTail, body, 112, 0, true)).not.toBe(first);
  expect(holdPairKey(release, tail, otherBody, 112, 0, true)).not.toBe(first);
  expect(holdPairKey(release, structuredClone(tail), structuredClone(body), 112, 0, true)).toBe(first);
});

test("calibration memo includes geometry, timing, orientation and every frame/resolution", () => {
  const first = holdPairKey(release, tail, body, 112, 0, true);
  for (const actual of [
    holdPairKey({ ...release, distance: -10 }, tail, body, 112, 0, true),
    holdPairKey(release, tail, body, 113, 0, true),
    holdPairKey(release, tail, body, 112, 1, true),
    holdPairKey(release, tail, body, 112, 0, false),
    holdPairKey(release, { ...tail, skin: "another" }, body, 112, 0, true),
    holdPairKey(release, tail, { ...body, files: [...body.files, { from: "body-0@2x.png", suffix: "-0@2x.png" }] }, 112, 0, true),
  ]) expect(actual).not.toBe(first);
});
