import { expect, test } from 'bun:test';
import { SKIN_POINTERS } from '@vosu-tools/client-skin';
import { Follow, SUBSCRIPTION } from '../src/follow';
import { validSubscription } from './subscription';

// Frames as vosu encodes them (src/server/v2_subscription.rs and its tests).
test('the request is what vosu accepts: an array of JSON Pointer strings', () => {
  expect(validSubscription(JSON.stringify(SUBSCRIPTION))).toBe(true);
  expect(SUBSCRIPTION).toEqual(['/beatmap/checksum', ...SKIN_POINTERS]);
  // The round-3 request: a tosu-style field filter, which vosu rejects.
  expect(validSubscription(JSON.stringify([{ field: 'beatmap', keys: ['checksum'] }]))).toBe(false);
  expect(validSubscription('["beatmap/checksum"]')).toBe(false);
  expect(validSubscription('[]')).toBe(false);
  expect(validSubscription('["/a~2b"]')).toBe(false);
  expect(validSubscription('["/a~1b/~0c"]')).toBe(true);
});

test('an initial frame states every value; absent ones are null', () => {
  const f = new Follow();
  expect(f.read([0, 7, [[0, 'abc'], [1, 'lazer'], [2, 'GAME OVER']]])).toEqual({
    kind: 'state', game: { checksum: 'abc', client: 'lazer', skinFolder: 'GAME OVER' }, map: true, skin: true,
  });
  expect(new Follow().read([0, 7, []])).toEqual({
    kind: 'state', game: { checksum: null, client: null, skinFolder: null }, map: true, skin: true,
  });
});

test('updates carry only what changed; values persist between frames', () => {
  const f = new Follow();
  f.read([0, 7, [[0, 'abc'], [1, 'stable'], [2, 'Ralsei']]]);
  expect(f.read([1, 8, [[0, 'def']], []])).toEqual({
    kind: 'state', game: { checksum: 'def', client: 'stable', skinFolder: 'Ralsei' }, map: true, skin: false,
  });
  expect(f.read([1, 9, [[2, 'Other']], []])).toEqual({
    kind: 'state', game: { checksum: 'def', client: 'stable', skinFolder: 'Other' }, map: false, skin: true,
  });
  expect(f.read([1, 10, [], [0]])).toEqual({
    kind: 'state', game: { checksum: null, client: 'stable', skinFolder: 'Other' }, map: true, skin: false,
  });
  expect(f.read([1, 11, [], []])).toBeNull();
  // A new initial frame (after a reconnect) restates everything.
  expect(f.read([0, 1, [[0, 'def']]])).toEqual({
    kind: 'state', game: { checksum: 'def', client: null, skinFolder: null }, map: true, skin: true,
  });
});

test('an error frame is a rejected subscription, not data', () => {
  const f = new Follow();
  expect(f.read([2, 1, 'invalid subscription request'])).toEqual({ kind: 'error', message: 'invalid subscription request' });
  expect(f.read({ beatmap: { checksum: 'abc' } })).toBeNull();
  expect(f.read('nonsense')).toBeNull();
});
