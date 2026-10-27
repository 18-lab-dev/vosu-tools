// Regenerates the key-count fixtures from @vosu-tools/demo-maps (project code,
// MIT OR Apache-2.0): each mania demo phrase repeated four times.
// Run from the repository root: bun tools/map-analysis/tests/fixtures/demo/generate.ts
import { MANIA_KEYS, demo, maniaDemo, repeatOsu } from "../../../../../packages/demo-maps/src/index.ts";

for (const mode of ['osu','taiko','fruits'] as const) {
  const {osu,period}=demo(mode);
  for(const copies of [1,2,4])await Bun.write(new URL(`${mode}-${copies}.osu`,import.meta.url),repeatOsu(osu,period,copies));
}
for (const keys of MANIA_KEYS) {
  const id = maniaDemo(keys);
  if (!id) continue;
  const { osu, period } = demo(id);
  await Bun.write(new URL(`mania-${keys}k.osu`, import.meta.url), repeatOsu(osu, period, 4));
}
