import { expect, test } from "bun:test";
import { displayName, filterOverlays, searchIndex, type InstalledOverlay } from "../src/overlay-layout";

const overlay = (id: string, name: string, nickname: string | null = null, author: string | null = null): InstalledOverlay => ({
  id,
  name,
  nickname,
  author,
  folder: `/static/${id}`,
  width: 300,
  height: 100,
});
const listing = [
  overlay("accuracy by sxlvia", "accuracy", null, "sxlvia"),
  overlay("ez2on-judge-rate", "EZ2ON Judge Rate"),
  overlay("iq-display", "IQ Display", "Brain"),
  overlay("pp-counter", "Pérformance counter", null, "Pinossaur"),
  overlay("nested/hit-error", "Hit error bar", "Unstable rate"),
];
const index = searchIndex(listing);
const ids = (query: string) => filterOverlays(index, query).matches.map((o) => o.id);

test("an empty query lists everything in listing order", () => {
  expect(ids("")).toEqual(listing.map((o) => o.id));
});

test("search covers nickname, name, author and folder; case and accents ignored", () => {
  expect(ids("brain")).toEqual(["iq-display"]);
  expect(ids("iq display")).toEqual(["iq-display"]);
  expect(ids("SXLVIA")).toEqual(["accuracy by sxlvia"]);
  expect(ids("performance")).toEqual(["pp-counter"]);
  expect(ids("hit-error")).toEqual(["nested/hit-error"]);
  expect(ids("judge ez2")).toEqual(["ez2on-judge-rate"]);
  expect(ids("nothing like this")).toEqual([]);
});

test("names starting with the query rank first, then word starts", () => {
  // "rate": "Unstable rate" (nickname, a word start) and "EZ2ON Judge Rate" (a word start);
  // "r" also matches inside other names, which come last.
  expect(ids("rate")).toEqual(["ez2on-judge-rate", "nested/hit-error"]);
  // "Unstable rate" starts with "un"; "counter" only contains it.
  expect(ids("un")).toEqual(["nested/hit-error", "pp-counter"]);
  expect(displayName(listing[2])).toBe("Brain");
});

test("hundreds of overlays: results are capped and counted", () => {
  const many = searchIndex(
    Array.from({ length: 600 }, (_, i) => overlay(`counter-${i}`, `Counter ${i}`, null, i % 2 ? "odd" : "even")),
  );
  const all = filterOverlays(many, "counter");
  expect(all.total).toBe(600);
  expect(all.matches.length).toBe(80);
  const odd = filterOverlays(many, "odd 59");
  // Every word must match: odd authors whose name contains 59.
  expect(odd.total).toBe(11);
  expect(odd.matches[0].id).toBe("counter-59");
  const started = performance.now();
  for (let i = 0; i < 100; i++) filterOverlays(many, "count 4");
  expect(performance.now() - started).toBeLessThan(500);
});
