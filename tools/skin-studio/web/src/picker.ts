// How the Keymodes picker names and orders images: names are cut in the
// middle (the end tells `mania-note1H` from `mania-note2T`), and for column
// roles osu!mania's own names come before osu!-standard circles.

/**
 * A picker name as a head that may be cut and a tail that always shows: the
 * file name's last part after `-` or `_` (`note2T`, `key1D`), else its last
 * six characters (`circle`). Joined, the parts are the name.
 */
export function nameParts(name: string): [head: string, tail: string] {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const part = /[-_]([^-_]{1,10})$/.exec(base)?.[1];
  const length = part ? part.length : Math.min(6, base.length);
  return [name.slice(0, name.length - length), name.slice(name.length - length)];
}

/** osu!'s default image names of a column role (`NoteImage#H` → `mania-note1H`, `mania-note2H`, `mania-noteSH`). */
const DEFAULT_NAMES: Record<string, RegExp> = {
  "KeyImage#": /^mania-key[12s]$/i,
  "KeyImage#D": /^mania-key[12s]d$/i,
  "NoteImage#": /^mania-note[12s]$/i,
  "NoteImage#H": /^mania-note[12s]h$/i,
  "NoteImage#L": /^mania-note[12s]l$/i,
  "NoteImage#T": /^mania-note[12s]t$/i,
};
/** Names written for osu!mania: a `mania-` file, or a key/note word (folders count) for that kind of role. */
const MANIA_STYLE: Record<string, RegExp> = {
  KeyImage: /(^|\/)mania-|key|receptor/i,
  NoteImage: /(^|\/)mania-|note/i,
};

/**
 * Order of an image among the picker's matches for a column role (`pattern`
 * like `NoteImage#H`): 0 an osu! default name of that role, 1 a name written
 * for osu!mania, 2 any other (osu!-standard `hitcircle`, `approachcircle`).
 * Other roles keep the name order (0).
 */
export function roleOrder(pattern: string, name: string): number {
  const exact = DEFAULT_NAMES[pattern];
  if (!exact) return 0;
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (exact.test(base)) return 0;
  return MANIA_STYLE[pattern.replace(/#.*$/, "")].test(name) ? 1 : 2;
}
