import { expect, test } from 'bun:test';
import { SUBSCRIPTION, readFrame } from '../src/follow';
import { validSubscription } from './subscription';

// Frames as vosu encodes them (src/server/v2_subscription.rs and its tests).
test('the request is what vosu accepts: an array of JSON Pointer strings', () => {
  expect(validSubscription(JSON.stringify(SUBSCRIPTION))).toBe(true);
  // The round-3 request: a tosu-style field filter, which vosu rejects.
  expect(validSubscription(JSON.stringify([{ field: 'beatmap', keys: ['checksum'] }]))).toBe(false);
  expect(validSubscription('["beatmap/checksum"]')).toBe(false);
  expect(validSubscription('[]')).toBe(false);
  expect(validSubscription('["/a~2b"]')).toBe(false);
  expect(validSubscription('["/a~1b/~0c"]')).toBe(true);
});

test('initial and update frames carry the selected checksum', () => {
  expect(readFrame([0, 7, [[0, 'abc']]])).toEqual({ kind: 'checksum', checksum: 'abc' });
  expect(readFrame([0, 7, []])).toEqual({ kind: 'checksum', checksum: null });
  expect(readFrame([1, 8, [[0, 'def']], []])).toEqual({ kind: 'checksum', checksum: 'def' });
  expect(readFrame([1, 9, [], [0]])).toEqual({ kind: 'checksum', checksum: null });
  expect(readFrame([1, 10, [], []])).toBeNull();
  expect(readFrame([0, 7, [[0, '']]])).toEqual({ kind: 'checksum', checksum: null });
});

test('an error frame is a rejected subscription, not data', () => {
  expect(readFrame([2, 1, 'invalid subscription request'])).toEqual({ kind: 'error', message: 'invalid subscription request' });
  expect(readFrame({ beatmap: { checksum: 'abc' } })).toBeNull();
  expect(readFrame('nonsense')).toBeNull();
});
