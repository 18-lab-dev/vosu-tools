// Line-preserving skin.ini model for composing mixes: sections keep their
// raw lines, so comments and untouched keys survive unchanged.

export interface Section {
  /** Section name without brackets; "" for lines before the first header. */
  name: string;
  lines: string[];
}
export type Ini = Section[];

const header = /^\s*\[([^\]]+)\]\s*$/;
const keyOf = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith(";"))
    return undefined;
  const colon = trimmed.indexOf(":");
  return colon > 0 ? trimmed.slice(0, colon).trim() : undefined;
};
const valueOf = (line: string) => line.slice(line.indexOf(":") + 1).trim();

export function parseIni(text: string): Ini {
  const sections: Ini = [{ name: "", lines: [] }];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = header.exec(line);
    if (match) sections.push({ name: match[1].trim(), lines: [line.trim()] });
    else sections.at(-1)!.lines.push(line);
  }
  // Drop the trailing empty line produced by a final newline.
  const last = sections.at(-1)!;
  if (last.lines.at(-1) === "") last.lines.pop();
  return sections;
}

export function serializeIni(ini: Ini): string {
  return (
    ini
      .flatMap((s) => s.lines)
      .join("\r\n")
      .replace(/^(\r\n)+/, "") + "\r\n"
  );
}

const keyMatches = (key: string, want: string | RegExp) =>
  typeof want === "string" ? key === want : want.test(key);

/** Every `key: value` pair in sections called `section` matching `key`. */
export function entries(
  ini: Ini,
  section: string,
  key: string | RegExp,
): { key: string; value: string; line: string }[] {
  return ini
    .filter((s) => s.name === section)
    .flatMap((s) =>
      s.lines.flatMap((line) => {
        const k = keyOf(line);
        return k !== undefined && keyMatches(k, key)
          ? [{ key: k, value: valueOf(line), line }]
          : [];
      }),
    );
}

export function removeKeys(ini: Ini, section: string, key: string | RegExp) {
  for (const s of ini)
    if (s.name === section)
      s.lines = s.lines.filter((line) => {
        const k = keyOf(line);
        return k === undefined || !keyMatches(k, key);
      });
}

/** Appends lines to the first `section` (created at the end if missing). */
export function appendLines(ini: Ini, section: string, lines: string[]) {
  if (!lines.length) return;
  let target = ini.find((s) => s.name === section && section !== "Mania");
  if (!target) {
    target = { name: section, lines: ["", `[${section}]`] };
    ini.push(target);
  }
  // Keep a trailing blank line after the section's last entry, and match the
  // indentation its keys already use.
  let at = target.lines.length;
  while (at > 1 && target.lines[at - 1].trim() === "") at--;
  const sample = target.lines.findLast((l) => keyOf(l) !== undefined);
  const indent = sample
    ? sample.slice(0, sample.length - sample.trimStart().length)
    : "";
  target.lines.splice(at, 0, ...lines.map((l) => indent + l.trimStart()));
}

/** Sets `key` where it first appears (dropping duplicates), else appends it. */
export function setValue(
  ini: Ini,
  section: string,
  key: string,
  value: string,
) {
  const line = `${key}: ${value}`;
  let done = false;
  for (const s of ini)
    if (s.name === section)
      s.lines = s.lines.flatMap((l) => {
        if (keyOf(l) !== key) return [l];
        if (done) return [];
        done = true;
        return [l.slice(0, l.length - l.trimStart().length) + line];
      });
  if (!done) appendLines(ini, section, [line]);
}

export function getValue(ini: Ini, section: string, key: string) {
  return entries(ini, section, key)[0]?.value;
}

/** `[Mania]` blocks by their `Keys:` value. */
export function maniaBlocks(ini: Ini): Map<number, Section> {
  const blocks = new Map<number, Section>();
  for (const s of ini)
    if (s.name === "Mania") {
      const keys = Number(
        entries([s], "Mania", "Keys")[0]?.value ?? Number.NaN,
      );
      if (Number.isInteger(keys) && !blocks.has(keys)) blocks.set(keys, s);
    }
  return blocks;
}

/** Replaces (or removes, with `block` undefined) the `[Mania]` block for `keys`. */
export function replaceMania(ini: Ini, keys: number, block?: Section) {
  const current = maniaBlocks(ini).get(keys);
  let copy: Section | undefined;
  if (block) {
    const lines = [...block.lines];
    while (lines.length > 1 && lines.at(-1)!.trim() === "") lines.pop();
    copy = { name: "Mania", lines: [...lines, ""] };
  }
  if (current) {
    const index = ini.indexOf(current);
    if (copy) ini.splice(index, 1, copy);
    else ini.splice(index, 1);
  } else if (copy) {
    ini.push(copy);
  }
}
