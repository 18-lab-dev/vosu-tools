import { parseReplay } from "@vosu-tools/replay";
import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2];
for (const f of readdirSync(dir)) { const r = await parseReplay(new Uint8Array(readFileSync(`${dir}/${f}`))); console.log(f, JSON.stringify(r.counts), r.maxCombo, r.score, r.frames.length); }
