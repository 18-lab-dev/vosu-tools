import { expect, test } from "bun:test";
import { imageUnit } from "../src/keymodes";
import { imageIndex } from "../src/mania";
import { compose } from "../src/plan";

test("expanding picker units reads the shared inventory once, with linear scaling", () => {
  const expand = (count: number) => {
    let reads = 0;
    const files = new Proxy(Array.from({ length: count }, (_, i) => `note-${i}.png`), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const index = imageIndex(files);
    for (let i = 0; i < count; i++)
      expect(imageUnit(files, `note-${i}`, index)).toEqual([{ from: `note-${i}.png`, suffix: ".png" }]);
    return reads;
  };
  const small = expand(160);
  const large = expand(320);
  expect(small).toBe(160);
  expect(large).toBe(320);
  expect(large).toBeLessThanOrEqual(small * 2);
});

test("shared picker indexing preserves casing, plain animation fallbacks and densities", () => {
  const files = ["Notes/Blue.png", "Notes/Blue-0.png", "Notes/Blue-0@2x.png", "Notes/Blue-1@2x.png"];
  const index = imageIndex(files);
  expect(imageUnit(files, "Notes/Blue", index)).toEqual(imageUnit(files, "Notes/Blue"));
});

test("composition normalizes a source inventory once for all retained ini image references", () => {
  const count = 32;
  const readCount = (references: number) => {
    let reads = 0;
    const files = new Proxy(Array.from({ length: count }, (_, i) => `padding-${i}.png`), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const text = "[Mania]\nKeys: 10\n" + Array.from({ length: references }, (_, i) => `NoteImage${i}: missing-${i}\n`).join("");
    compose({ name: "Mix", base: "base", picks: {} }, new Map([["base", { key: "base", name: "Base", text, files }]]));
    return reads;
  };
  expect(readCount(10)).toBeLessThanOrEqual(readCount(0) + count);
});
