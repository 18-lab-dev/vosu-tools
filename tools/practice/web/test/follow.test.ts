import { expect, test } from 'bun:test';
import { MANIA_SETTINGS_POINTER, SKIN_POINTERS, readManiaSettings } from '@vosu-tools/client-skin';
import { Follow, SUBSCRIPTION } from '../src/follow';
import { validSubscription } from './subscription';

const unknown = readManiaSettings(null);
const game = (checksum: string | null, client: string | null, skinFolder: string | null, mania = unknown) => ({
  checksum, client, skinFolder, mania,
});

// Frames as vosu encodes them (src/server/v2_subscription.rs and its tests).
test('the request is what vosu accepts: an array of JSON Pointer strings', () => {
  expect(validSubscription(JSON.stringify(SUBSCRIPTION))).toBe(true);
  expect(SUBSCRIPTION).toEqual(['/beatmap/checksum', ...SKIN_POINTERS, MANIA_SETTINGS_POINTER]);
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
    kind: 'state', game: game('abc', 'lazer', 'GAME OVER'), map: true, skin: true, scroll: true,
  });
  expect(new Follow().read([0, 7, []])).toEqual({
    kind: 'state', game: game(null, null, null), map: true, skin: true, scroll: true,
  });
});

test('updates carry only what changed; values persist between frames', () => {
  const f = new Follow();
  f.read([0, 7, [[0, 'abc'], [1, 'stable'], [2, 'Ralsei']]]);
  expect(f.read([1, 8, [[0, 'def']], []])).toEqual({
    kind: 'state', game: game('def', 'stable', 'Ralsei'), map: true, skin: false, scroll: false,
  });
  expect(f.read([1, 9, [[2, 'Other']], []])).toEqual({
    kind: 'state', game: game('def', 'stable', 'Other'), map: false, skin: true, scroll: false,
  });
  expect(f.read([1, 10, [], [0]])).toEqual({
    kind: 'state', game: game(null, 'stable', 'Other'), map: true, skin: false, scroll: false,
  });
  expect(f.read([1, 11, [], []])).toBeNull();
  // A new initial frame (after a reconnect) restates everything.
  expect(f.read([0, 1, [[0, 'def']]])).toEqual({
    kind: 'state', game: game('def', null, null), map: true, skin: true, scroll: true,
  });
});

test("the client's mania scroll speed follows live", () => {
  const f = new Follow();
  const mania = { scrollSpeed: 15, scrollDirection: { number: 1, name: 'down' } };
  expect(f.read([0, 1, [[1, 'lazer'], [3, { ...mania, scrollSpeedValue: 15 }]]])).toMatchObject({
    game: { client: 'lazer', mania: { scrollSpeed: 15, scrollUp: false } }, scroll: true,
  });
  // The user changes the speed in the client: only the settings change.
  expect(f.read([1, 2, [[3, { ...mania, scrollSpeedValue: 30 }]], []])).toMatchObject({
    game: { mania: { scrollSpeed: 30 } }, map: false, skin: false, scroll: true,
  });
  // A client switch matters too: whether its speed applies at all.
  expect(f.read([1, 3, [], [1]])).toMatchObject({ game: { client: null }, scroll: true });
  // Settings vosu cannot read leave the speed unknown.
  expect(f.read([1, 4, [], [3]])).toMatchObject({ game: { mania: { scrollSpeed: null } }, scroll: true });
});

test('an error frame is a rejected subscription, not data', () => {
  const f = new Follow();
  expect(f.read([2, 1, 'invalid subscription request'])).toEqual({ kind: 'error', message: 'invalid subscription request' });
  expect(f.read({ beatmap: { checksum: 'abc' } })).toBeNull();
  expect(f.read('nonsense')).toBeNull();
});
