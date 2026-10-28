import { parse, resolve, type Line } from "@vosu-tools/skin-spec";
import { groupById, type Recipe } from "./plan";
import { imageValue, parseAssetId } from "./assets";

interface Field {
  section: string;
  keys?: number;
  key: string;
  value: string;
}
const value = (text: string) => text.split("//", 1)[0].trim();
const identity = (field: Field) => JSON.stringify([field.section, field.keys, field.key]);
function fields(text: string) {
  const doc = parse(text);
  const counts = new Map(doc.lines.filter((line) => line.section === "Mania" && line.key === "Keys").map((line) => [line.block, Number(value(line.value ?? ""))]));
  const entries = new Map<string, Field>();
  for (const line of doc.lines) {
    if (!line.key) continue;
    const field: Field = { section: line.section, keys: line.section === "Mania" ? counts.get(line.block) : undefined, key: line.key, value: value(line.value ?? "") };
    if (!entries.has(identity(field))) entries.set(identity(field), field);
  }
  return { doc, counts, entries };
}

/** Update only compositor-owned values; retain hand edits and raw untouched lines. */
export function mergeDraftIni(text: string, previous: string, next: string, before?: Recipe, after?: Recipe) {
  const old = fields(previous).entries, fresh = fields(next).entries;
  const picked = new Set(Object.keys({ ...before?.picks, ...after?.picks }).filter((id) => JSON.stringify(before?.picks[id]) !== JSON.stringify(after?.picks[id])));
  const removed = new Set([...old.values()].filter((field) => field.section === "Mania" && field.key === "Keys" && !fresh.has(identity(field))).map((field) => field.keys));
  if (removed.size) {
    const { doc, counts } = fields(text);
    text = doc.lines.filter((line) => line.section !== "Mania" || !removed.has(counts.get(line.block))).map((line) => line.raw + line.eol).join("");
  }
  const assets = Object.keys({ ...before?.overrides, ...after?.overrides })
    .filter((id) => JSON.stringify(before?.overrides?.[id]) !== JSON.stringify(after?.overrides?.[id]))
    .map((id) => ({ ref: parseAssetId(id), carry: after?.overrides?.[id]?.carry ?? [] }));
  const forced = (field: Field) => {
    if (assets.some(({ ref, carry }) => {
      if (!ref) return false;
      const type = resolve(field.section, field.key)?.type;
      if ((type === "image" && ref.kind === "image" || type === "prefix" && ref.kind === "font") && imageValue(field.value) === ref.name) return true;
      if (carry.includes("framerate") && field.section === "General" && field.key === "AnimationFramerate") return true;
      return carry.includes("overlap") && field.section === "Fonts" && /Overlap$/.test(field.key) && [...fresh.values()].some((candidate) => candidate.section === "Fonts" && candidate.key === field.key.replace(/Overlap$/, "Prefix") && imageValue(candidate.value) === ref.name);
    })) return true;
    return [...picked].some((id) => {
      const group = groupById(id);
      if (group?.maniaKeys !== undefined) return field.section === "Mania" && field.keys === group.maniaKeys;
      return group?.ini?.some((rule) => rule.section === field.section && (rule.pattern ? new RegExp(rule.key).test(field.key) : rule.key === field.key));
    });
  };
  for (const [id, field] of new Map([...old, ...fresh])) {
    if (field.section === "Mania" && removed.has(field.keys)) continue;
    const updated = fresh.get(id);
    if (old.get(id)?.value === updated?.value && !forced(field)) continue;
    const { doc, counts } = fields(text);
    const sameBlock = (line: Line) => line.section === field.section && (field.section !== "Mania" || counts.get(line.block) === field.keys);
    const matching = doc.lines.filter((line) => sameBlock(line) && line.key === field.key);
    const [first] = matching;
    if (first) {
      const comment = /\s*\/\/.*$/.exec(first.raw.slice((first.valueColumn ?? 1) - 1))?.[0] ?? "";
      const rows = doc.lines.filter((line) => !matching.includes(line) || (line === first && updated !== undefined));
      if (updated) first.raw = first.raw.slice(0, first.raw.indexOf(":") + 1) + " " + updated.value + comment;
      text = rows.map((line) => line.raw + line.eol).join("");
      continue;
    }
    if (!updated) continue;
    const eol = doc.lines.find((line) => line.eol)?.eol ?? "\r\n";
    const block = doc.lines.filter(sameBlock);
    const anchor = block.findLast((line) => line.key) ?? block[0];
    if (anchor) {
      const raw = `${/^\s*/.exec(anchor.raw)?.[0] ?? ""}${field.key}: ${updated.value}`;
      const at = doc.lines.indexOf(anchor);
      const tail = anchor.eol;
      anchor.eol ||= eol;
      text = doc.lines.slice(0, at + 1).map((line) => line.raw + line.eol).join("") + raw + tail + doc.lines.slice(at + 1).map((line) => line.raw + line.eol).join("");
    } else {
      if (text && !/[\r\n]$/.test(text)) text += eol;
      text += `${eol}[${field.section}]${eol}`;
      if (field.section === "Mania" && field.key !== "Keys") text += `Keys: ${field.keys}${eol}`;
      text += `${field.key}: ${updated.value}${eol}`;
    }
  }
  return text;
}
