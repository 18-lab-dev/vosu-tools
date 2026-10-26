// Regenerates the key-count fixtures from @vosu-tools/demo-maps (project code,
// MIT OR Apache-2.0): each mania demo phrase repeated four times.
// Run from the repository root: bun tools/mania-ratings/tests/fixtures/demo/generate.ts
import { MANIA_KEYS, demo, maniaDemo, repeatOsu } from "../../../../../packages/demo-maps/src/index.ts";

for (const keys of MANIA_KEYS) {
  const id = maniaDemo(keys);
  if (!id) continue;
  const { osu, period } = demo(id);
  await Bun.write(new URL(`mania-${keys}k.osu`, import.meta.url), repeatOsu(osu, period, 4));
}
