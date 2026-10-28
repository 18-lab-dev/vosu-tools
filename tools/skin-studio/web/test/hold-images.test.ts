import { expect, test } from "bun:test";
import type { Offsets } from "../src/calibrate";
import { calibrateHoldImages, holdPairKey, holdResolution } from "../src/hold-images";
import type { SlotImage } from "../src/keymodes";
import type { DeriveOp } from "../src/hit-panel";
import { imageIndex, imageUnitFiles, lookupFiles } from "../src/mania";

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

function imageUnit(name: string, frames: number, densities = [1, 2]): SlotImage {
  return { skin: "real-copy", name, files: densities.flatMap((density) => Array.from({ length: frames || 1 }, (_, frame) => {
    const suffix = `${frames ? `-${frame}` : ""}${density === 2 ? "@2x" : ""}.png`;
    return { from: `${name}${suffix}`, suffix };
  })) };
}

function service(blank = false) {
  const calls: { skin: string; name: string; op: DeriveOp; cap?: string }[] = [];
  return {
    calls,
    async rows(_skin: string, name: string) {
      const density = name.includes("@2x") ? 2 : 1;
      return { width: 64 * density, height: 100 * density, top: (blank ? 100 : 4) * density, bottom: 0 };
    },
    async derive(skin: string, files: { name: string; op: DeriveOp; cap?: string }[]) {
      return files.map((file) => {
        calls.push({ skin, ...file });
        return { from: file.name, stored: `derived/${calls.length}.png`, lost: 0 };
      });
    },
  };
}

test("lengthening transforms every tail frame and resolution without stripping suffixes", async () => {
  const host = service();
  const tails = imageUnit("tail", 2);
  const result = await calibrateHoldImages(host, { ...release, distance: -10 }, tails, imageUnit("body", 2), 64, 0, true, []);
  expect(result.T.files.map((file) => file.suffix)).toEqual(tails.files.map((file) => file.suffix));
  expect(host.calls.map((call) => "tail" in call.op ? call.op.tail.gap : null)).toEqual([10, 10, 20, 20]);
});

test("HD-only percy bodies retain HD markers and every animation frame", async () => {
  const host = service(true);
  const bodies = imageUnit("body", 2, [2]);
  const result = await calibrateHoldImages(host, release, imageUnit("tail", 0, [2]), bodies, 64, 1, true, []);
  expect(result.L.files.map((file) => file.suffix)).toEqual(["-0@2x.png", "-1@2x.png"]);
  expect(host.calls.map((call) => call.name)).toEqual(bodies.files.map((file) => file.from));
});

test("conversion preserves different tail/body animation loops at both resolutions", async () => {
  const host = service();
  const result = await calibrateHoldImages(host, release, imageUnit("tail", 2), imageUnit("body", 3), 128, 0, true, []);
  const suffixes = [1, 2].flatMap((density) => Array.from({ length: 6 }, (_, i) => `-${i}${density === 2 ? "@2x" : ""}.png`));
  expect(result.T.files.map((file) => file.suffix)).toEqual(suffixes);
  expect(result.L.files.map((file) => file.suffix)).toEqual(suffixes);
  const converted = host.calls.filter((call) => "percy" in call.op);
  expect(converted.map((call) => call.name)).toEqual([1, 2].flatMap((density) => Array.from({ length: 6 }, (_, i) => `body-${i % 3}${density === 2 ? "@2x" : ""}.png`)));
  expect(converted.map((call) => call.cap)).toEqual([1, 2].flatMap((density) => Array.from({ length: 6 }, (_, i) => `tail-${i % 2}${density === 2 ? "@2x" : ""}.png`)));
});

test("conversion retains a plain fallback when only the other unit is animated", async () => {
  const result = await calibrateHoldImages(service(), release, imageUnit("tail", 0, [1]), imageUnit("body", 2, [1]), 64, 0, true, []);
  expect(result.T.files.map((file) => file.suffix)).toEqual([".png", "-0.png", "-1.png"]);
  expect(result.L.files.map((file) => file.suffix)).toEqual([".png", "-0.png", "-1.png"]);
});

test("editable image units retain plain fallbacks as well as drawn animation frames", () => {
  const names = [".png", "@2x.png", "-0.png", "-0@2x.png", "-1.png", "-1@2x.png"].map((suffix) => `body${suffix}`);
  const index = imageIndex(names);
  expect(lookupFiles(index, "body", true)).toHaveLength(4);
  expect(imageUnitFiles(index, "body")).toEqual(names);
});

test("oversized HD conversion explicitly uses SD while retaining animation", async () => {
  expect(holdResolution(release, [{ width: 128, capRows: 192, density: 2 }], 64, 0, true)).toEqual({ useSD: true, warning: "Hold tail: HD would be 65,600 px tall, using SD" });
  const host = service();
  const report: string[] = [];
  const result = await calibrateHoldImages(host, release, imageUnit("tail", 2, [2]), imageUnit("body", 3, [2]), 64, 0, true, report);
  expect(report).toContain("Hold tail: HD would be 65,600 px tall, using SD");
  expect(result.L.files.map((file) => file.suffix)).toEqual(Array.from({ length: 6 }, (_, i) => `-${i}.png`));
  expect(host.calls.filter((call) => "percy" in call.op).every((call) => "percy" in call.op && call.op.percy.height === 32800)).toBe(true);
  expect(host.calls.some((call) => "resize" in call.op && call.op.resize.scale_y === 0.5)).toBe(true);
});
