// Following the game over vosu's selected-field `/websocket/v2/subscribe`.
// The request is a JSON array of JSON Pointers into the v2 document; frames are
//   [0, revision, [[id, value], …]]               initial values (absent ids omitted)
//   [1, revision, [[id, value], …], [id, …]]      changed ids: present values, then absent ids
//   [2, code, message]                            error; vosu closes the socket after it
// where `id` is the pointer's index in the request.
import { MANIA_SETTINGS_POINTER, SKIN_POINTERS, readManiaSettings, type ClientManiaSettings } from '@vosu-tools/client-skin';

/**
 * The selected map, the pointers whose change means the client's skin may
 * have changed, and the client's mania settings (scroll speed).
 */
export const SUBSCRIPTION: readonly `/${string}`[] = ['/beatmap/checksum', ...SKIN_POINTERS, MANIA_SETTINGS_POINTER];
const CHECKSUM = 0;
const CLIENT = 1;
const SKIN_FOLDER = 2;
const MANIA = 3;

export type Game = {
  checksum: string | null;
  client: string | null;
  skinFolder: string | null;
  mania: ClientManiaSettings;
};
export type FollowEvent =
  | { kind: 'state'; game: Game; map: boolean; skin: boolean; scroll: boolean }
  | { kind: 'error'; message: string }
  | null;

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/**
 * Keeps the followed values of one subscription. `read` returns the current
 * values and which of them a frame changed (an initial frame changes all), an
 * error, or null when the frame says nothing.
 */
export class Follow {
  #values: unknown[] = [];

  read(frame: unknown): FollowEvent {
    if (!Array.isArray(frame)) return null;
    const [kind] = frame;
    if (kind === 2) return { kind: 'error', message: typeof frame[2] === 'string' ? frame[2] : 'subscription error' };
    if (kind !== 0 && kind !== 1) return null;
    const changed = new Set<number>();
    // An initial frame states every value; ids it omits are absent.
    if (kind === 0) {
      this.#values = [];
      for (let id = 0; id < SUBSCRIPTION.length; id++) changed.add(id);
    }
    const present: unknown = frame[2];
    const absent: unknown = frame[3];
    if (Array.isArray(present)) {
      for (const entry of present) {
        if (Array.isArray(entry) && typeof entry[0] === 'number') {
          this.#values[entry[0]] = entry[1];
          changed.add(entry[0]);
        }
      }
    }
    if (Array.isArray(absent)) {
      for (const id of absent) {
        if (typeof id === 'number') {
          this.#values[id] = undefined;
          changed.add(id);
        }
      }
    }
    if (!changed.size) return null;
    return {
      kind: 'state',
      game: {
        checksum: text(this.#values[CHECKSUM]),
        client: this.#values[CLIENT] === 'stable' || this.#values[CLIENT] === 'lazer' ? String(this.#values[CLIENT]) : null,
        skinFolder: text(this.#values[SKIN_FOLDER]),
        mania: readManiaSettings(this.#values[MANIA]),
      },
      map: changed.has(CHECKSUM),
      skin: changed.has(CLIENT) || changed.has(SKIN_FOLDER),
      // Which client it is decides whether its speed applies at all.
      scroll: changed.has(MANIA) || changed.has(CLIENT),
    };
  }
}
