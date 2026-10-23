import { expect, test } from 'bun:test';
import { DRAG_THRESHOLD_PX, Gesture, MIN_RANGE_MS, modeFor, nudge } from '../src/gesture';
import { nearestOutputTime } from '../src/time';

const ranges = [{ start_ms: 10_000, end_ms: 20_000 }, { start_ms: 40_000, end_ms: 50_000 }];
const duration = 60_000;
const at = (target: ConstructorParameters<typeof Gesture>[0], shift: boolean, time: number) =>
  new Gesture(target, shift, 100, time, ranges, duration);

test('a press picks its gesture from the target and Shift', () => {
  expect(modeFor({ kind: 'empty' }, false)).toBe('scrub');
  expect(modeFor({ kind: 'range', index: 0 }, false)).toBe('scrub');
  expect(modeFor({ kind: 'empty' }, true)).toBe('create');
  expect(modeFor({ kind: 'range', index: 1 }, true)).toBe('move');
  expect(modeFor({ kind: 'edge', index: 0, edge: 'end' }, false)).toBe('resize');
  expect(modeFor({ kind: 'edge', index: 0, edge: 'end' }, true)).toBe('resize');
});

test('dragging without Shift scrubs live and never creates a section', () => {
  const g = at({ kind: 'empty' }, false, 5000);
  expect(g.move(100 + DRAG_THRESHOLD_PX - 1, 5100)).toEqual({ kind: 'none' });
  expect(g.move(160, 30_000)).toEqual({ kind: 'scrub', time: 30_000 });
  expect(g.move(220, 35_000)).toEqual({ kind: 'scrub', time: 35_000 });
  expect(g.end(35_000)).toEqual({ kind: 'seek', time: 35_000 });
  // Inside an existing section too: the section is not moved.
  const inside = at({ kind: 'range', index: 0 }, false, 12_000);
  expect(inside.move(180, 15_000)).toEqual({ kind: 'scrub', time: 15_000 });
  expect(inside.end(15_000)).toEqual({ kind: 'seek', time: 15_000 });
});

test('a click seeks, except on a section edge', () => {
  expect(at({ kind: 'empty' }, false, 7000).end(7000)).toEqual({ kind: 'seek', time: 7000 });
  expect(at({ kind: 'empty' }, true, 7000).end(7000)).toEqual({ kind: 'seek', time: 7000 });
  expect(at({ kind: 'range', index: 0 }, true, 12_000).end(12_000)).toEqual({ kind: 'seek', time: 12_000 });
  expect(at({ kind: 'edge', index: 0, edge: 'start' }, false, 10_000).end(10_000)).toEqual({ kind: 'none' });
});

test('Shift+drag creates a section in either direction, at least the minimum length', () => {
  const g = at({ kind: 'empty' }, true, 30_000);
  expect(g.move(60, 25_000)).toEqual({ kind: 'ranges', ranges: [ranges[0], { start_ms: 25_000, end_ms: 30_000 }, ranges[1]] });
  expect(g.end(25_000)).toEqual({ kind: 'commit', ranges: [ranges[0], { start_ms: 25_000, end_ms: 30_000 }, ranges[1]] });
  const tiny = at({ kind: 'empty' }, true, 30_000);
  tiny.move(110, 30_050);
  expect(tiny.end(30_050)).toEqual({ kind: 'commit', ranges: [ranges[0], { start_ms: 30_000, end_ms: 30_000 + MIN_RANGE_MS }, ranges[1]] });
});

test('Shift+drag on a section moves it within the map', () => {
  const g = at({ kind: 'range', index: 1 }, true, 45_000);
  expect(g.move(200, 55_000)).toEqual({ kind: 'ranges', ranges: [ranges[0], { start_ms: 50_000, end_ms: 60_000 }] });
  expect(g.end(70_000)).toEqual({ kind: 'commit', ranges: [ranges[0], { start_ms: 50_000, end_ms: 60_000 }] });
});

test('edges resize, clamped to the map and the minimum length', () => {
  const start = at({ kind: 'edge', index: 0, edge: 'start' }, false, 10_000);
  start.move(0, 4000);
  expect(start.end(4000)).toEqual({ kind: 'commit', ranges: [{ start_ms: 4000, end_ms: 20_000 }, ranges[1]] });
  const end = at({ kind: 'edge', index: 0, edge: 'end' }, false, 20_000);
  end.move(0, 9000);
  expect(end.end(9000)).toEqual({ kind: 'commit', ranges: [{ start_ms: 10_000, end_ms: 10_000 + MIN_RANGE_MS }, ranges[1]] });
  const out = at({ kind: 'edge', index: 1, edge: 'end' }, false, 50_000);
  out.move(400, 90_000);
  expect(out.end(90_000)).toEqual({ kind: 'commit', ranges: [ranges[0], { start_ms: 40_000, end_ms: duration }] });
});

test('keyboard nudges the playhead', () => {
  expect(nudge('ArrowRight', false, 5000, duration)).toBe(6000);
  expect(nudge('ArrowLeft', false, 500, duration)).toBe(0);
  expect(nudge('ArrowRight', true, 58_000, duration)).toBe(duration);
  expect(nudge('Home', false, 30_000, duration)).toBe(0);
  expect(nudge('End', false, 30_000, duration)).toBe(duration);
  expect(nudge('a', false, 30_000, duration)).toBeNull();
});

test('seeking into a trimmed-away part goes to the nearest kept edge', () => {
  const windows = [
    { source_start: 500, source_end: 3800, output_start: 0 },
    { source_start: 9500, source_end: 11_100, output_start: 5300 },
  ];
  expect(nearestOutputTime(1000, 1, windows)).toBe(500);
  expect(nearestOutputTime(5000, 1, windows)).toBe(3300); // nearer the first window's end
  expect(nearestOutputTime(9000, 1.25, windows)).toBe(5300 / 1.25);
  expect(nearestOutputTime(0, 1, windows)).toBe(0);
  expect(nearestOutputTime(3000, 1.5, [])).toBe(2000);
});
