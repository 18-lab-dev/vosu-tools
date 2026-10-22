import { expect, test } from 'bun:test';
import { clock, outputTime, parseClock, sourceTime, type Window } from '../src/time';

// The two-section fixture of crates/osu-file/tests/trims.rs.
const windows: Window[] = [
  { source_start: 500, source_end: 3800, output_start: 0 },
  { source_start: 9500, source_end: 11_100, output_start: 5300 },
];

test('output ↔ source mapping follows the trim windows and the rate', () => {
  expect(outputTime(10_000, 1, windows)).toBe(5800);
  expect(outputTime(10_000, 1.25, windows)).toBe(5800 / 1.25);
  expect(sourceTime(5800 / 1.25, 1.25, windows)).toBeCloseTo(10_000, 9);
  expect(sourceTime(500, 1, windows)).toBe(1000);
  // Trimmed-away source time and the gap between sections have no counterpart.
  expect(outputTime(6000, 1, windows)).toBeNull();
  expect(sourceTime(4000, 1, windows)).toBeNull();
  // Untrimmed maps only scale by the rate.
  expect(outputTime(3000, 1.5, [])).toBe(2000);
  expect(sourceTime(2000, 1.5, [])).toBe(3000);
});

test('clock formatting and parsing round-trip', () => {
  expect(clock(65_430, true)).toBe('1:05.4');
  expect(clock(65_490)).toBe('1:05');
  expect(clock(59_990, true)).toBe('0:59.9');
  expect(parseClock('1:05.4')).toBe(65_400);
  expect(parseClock('42')).toBe(42_000);
  expect(parseClock('0:07.25')).toBe(7250);
  expect(parseClock('1:xx')).toBeNull();
  expect(parseClock(clock(123_400, true))).toBe(123_400);
});
