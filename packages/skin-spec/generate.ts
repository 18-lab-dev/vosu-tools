// Extract interoperability facts only. Never distribute wiki prose or images.
import { writeFile } from "node:fs/promises";
export const revision = "c9fa3ff277dba4c620d4731fd2c3fbb74770c20b";
const source = `https://raw.githubusercontent.com/ppy/osu-wiki/${revision}/wiki/Skinning/skin.ini/en.md`;
const text = await (await fetch(source)).text();
let section = "";
const entries: Record<string, unknown>[] = [];
for (const chunk of text.split(/(?=^## |^- `)/m)) {
  const heading = chunk.match(/^## \\\[(\w+)\\\]/);
  if (heading) section = heading[1];
  if (!section) continue;
  const key = chunk.match(/^- `([^`:]+):?`/)?.[1];
  if (!key) continue;
  const value = chunk.match(/  - Values?:([^]*?)(?=\n  - |$)/)?.[1] ?? "";
  const def = chunk.match(/  - Default: `([^`]+)`/)?.[1];
  let type = "string";
  if (/RGB\(a\)/.test(value)) type = "rgba";
  else if (/RGB/.test(value)) type = "rgb";
  else if (/comma-split/.test(value))
    type = /integer/.test(value) ? "integers" : "numbers";
  else if (/path to image/.test(value)) type = "image";
  else if (/filename prefix/.test(value)) type = "prefix";
  else if (/integer/.test(value)) type = "integer";
  else if (/number/.test(value)) type = "number";
  const enums = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const item: Record<string, unknown> = { section, key, type };
  if (enums.length && key !== "Version" && key !== "AnimationFramerate") {
    item.type = "enum";
    item.enum = enums;
  }
  if (key === "Version") {
    item.type = "enum";
    item.enum = [
      "1.0",
      "2.0",
      "2.1",
      "2.2",
      "2.3",
      "2.4",
      "2.5",
      "2.6",
      "2.7",
      "latest",
    ];
  }
  if (key === "ComboBurstStyle")
    item.enum = ["0", "1", "2", "Left", "Right", "Both"];
  if (def !== undefined) item.default = def;
  if (/positive/.test(value)) item.min = 1;
  if (
    /Requires skin version `2.5`|^(Lighting[N L]Width)$/.test(chunk) ||
    ["LightingNWidth", "LightingLWidth"].includes(key)
  )
    item.since = 2.5;
  if (["ColumnWidth", "LightingNWidth", "LightingLWidth"].includes(key))
    item.columns = 0;
  if (key === "ColumnSpacing") item.columns = -1;
  if (key === "ColumnLineWidth") item.columns = 1;
  if (key.includes("#")) item.indexBase = key.startsWith("Colour") ? 1 : 0;
  entries.push(item);
}
// Accepted legacy spelling is a protocol identifier, not a compatibility export.
entries.push({
  section: "General",
  key: "HitCircleOverlayAboveNumer",
  type: "enum",
  enum: ["0", "1"],
});
await writeFile(
  new URL("./spec.json", import.meta.url),
  JSON.stringify({ revision, source, entries }, null, 2) + "\n",
);
console.log(`Extracted ${entries.length} command patterns`);
