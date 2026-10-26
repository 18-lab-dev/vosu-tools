import { expect, test } from "bun:test";
import { parseOsu, type Point } from "@vosu-tools/osu-parse";
import { bodySegments } from "../src/scene";
import { sliderMap } from "./sliderBodyGolden";

/** Distance from `p` to the segment a-b. */
function distance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length2 = dx * dx + dy * dy,
    t =
      length2 > 0
        ? Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2),
          )
        : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

test("every pixel of a body lies in the quad of its nearest segment", () => {
  // The depth pass can only pick a pixel's nearest segment if that segment's
  // quad covers it: check a grid over each synthetic slider (S shapes, loops,
  // a teardrop, a reversal) and a few hand-made corners.
  const paths: Point[][] = parseOsu(sliderMap(4))
    .objects.filter((o) => o.type & 2)
    .map((o) => o.path);
  paths.push(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 60, y: 40 },
      { x: 0, y: 30 },
    ],
    [{ x: 5, y: 5 }],
  );
  for (const radius of [20, 58.4]) {
    for (const path of paths) {
      const segments = bodySegments(path, radius);
      expect(segments.length).toBe(Math.max(0, path.length - 1));
      if (!segments.length) continue;
      const xs = path.map((p) => p.x),
        ys = path.map((p) => p.y);
      let checked = 0;
      for (
        let x = Math.min(...xs) - radius;
        x <= Math.max(...xs) + radius;
        x += 1.7
      )
        for (
          let y = Math.min(...ys) - radius;
          y <= Math.max(...ys) + radius;
          y += 1.7
        ) {
          const p = { x, y };
          let nearest = 0,
            best = Infinity;
          for (const [i, s] of segments.entries()) {
            const d = distance(p, s.a, s.b);
            if (d < best) [best, nearest] = [d, i];
          }
          if (best >= radius) continue;
          // Every segment as near as the nearest may draw the pixel.
          const covered = segments.some((s) => {
            if (distance(p, s.a, s.b) > best + 1e-9) return false;
            const cx = (s.a.x + s.b.x) / 2,
              cy = (s.a.y + s.b.y) / 2,
              along =
                (p.x - cx) * Math.cos(s.angle) + (p.y - cy) * Math.sin(s.angle),
              across =
                -(p.x - cx) * Math.sin(s.angle) +
                (p.y - cy) * Math.cos(s.angle);
            return (
              along >= -s.length / 2 - s.before &&
              along <= s.length / 2 + s.after &&
              Math.abs(across) <= radius
            );
          });
          if (!covered) expect({ path, p, nearest, covered }).toBeNull();
          checked++;
        }
      expect(checked).toBeGreaterThan(100);
    }
  }
});

test("smooth paths overdraw far less than whole capsules", () => {
  const path = parseOsu(sliderMap(4)).objects.findLast((o) => o.type & 2)!.path,
    radius = 58.4,
    segments = bodySegments(path, radius),
    tight = segments.reduce(
      (n, s) => n + (s.length + s.before + s.after) * 2 * radius,
      0,
    ),
    capsules = segments.reduce(
      (n, s) => n + (s.length + 2 * radius) * 2 * radius,
      0,
    );
  expect(tight).toBeLessThan(capsules / 5);
});
