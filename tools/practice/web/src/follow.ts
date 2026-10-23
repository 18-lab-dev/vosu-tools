// Following the selected map over vosu's selected-field `/websocket/v2/subscribe`.
// The request is a JSON array of JSON Pointers into the v2 document; frames are
//   [0, revision, [[id, value], …]]               initial values (absent ids omitted)
//   [1, revision, [[id, value], …], [id, …]]      changed ids: present values, then absent ids
//   [2, code, message]                            error; vosu closes the socket after it
// where `id` is the pointer's index in the request.
export const SUBSCRIPTION: readonly `/${string}`[] = ['/beatmap/checksum'];
const CHECKSUM = 0;

export type FollowEvent =
  | { kind: 'checksum'; checksum: string | null }
  | { kind: 'error'; message: string }
  | null;

/** The map change a frame carries, an error, or null when it says nothing new. */
export function readFrame(frame: unknown): FollowEvent {
  if (!Array.isArray(frame)) return null;
  const [kind] = frame;
  if (kind === 2) return { kind: 'error', message: typeof frame[2] === 'string' ? frame[2] : 'subscription error' };
  if (kind !== 0 && kind !== 1) return null;
  const present: unknown = frame[2];
  const absent: unknown = frame[3];
  if (Array.isArray(present)) {
    for (const entry of present) {
      if (Array.isArray(entry) && entry[0] === CHECKSUM) {
        return { kind: 'checksum', checksum: typeof entry[1] === 'string' && entry[1] ? entry[1] : null };
      }
    }
  }
  // An initial frame without the pointer means vosu has no selected map.
  if (kind === 0 || (Array.isArray(absent) && absent.includes(CHECKSUM))) return { kind: 'checksum', checksum: null };
  return null;
}
