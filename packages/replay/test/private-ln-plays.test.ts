import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import { parseReplay, simulateMania, simulateStableMania } from "../src";

// Optional local-only audit: no user replay, chart or personal path is committed.
// LN_AUDIT_COPIES names the scratch directory containing scores.json/stable.json
// manifests and their read-only copies. See Skin studio's ln-release-audit.md.
const root = process.env.LN_AUDIT_COPIES;
const expected = {
  scores: [
    [1701,1682,1649,18,15,153], [1701,1682,1648,16,18,150],
    [2200,2186,2078,38,70,296], [0,0,0,0,0,183], [35,34,34,0,0,60],
    [24,26,24,2,0,45], [628,618,608,9,1,71], [174,174,172,2,0,37],
    [24,25,24,1,0,10], [323,324,313,8,3,80],
  ],
  stable: [
    [1096,1101,1096,5,0,6], [98,97,97,0,0,25], [4,4,4,0,0,0],
    [148,149,148,1,0,75], [34,34,34,0,0,23], [34,34,34,0,0,26],
    [256,256,256,0,0,11], [0,0,0,0,0,36], [510,514,509,5,0,38], [0,0,0,0,0,33],
  ],
};
for (const client of ["scores", "stable"] as const) {
  test.skipIf(!root)(`private ${client} copied LN acceptance summaries`, async () => {
    const plays: { replay: string; map: string }[] = await Bun.file(`${root}/${client}.json`).json();
    expect(plays).toHaveLength(expected[client].length);
    for (const [i, play] of plays.entries()) {
      const replay = await parseReplay(new Uint8Array(await Bun.file(play.replay).arrayBuffer()));
      const map = parseOsu(await Bun.file(play.map).text());
      const simulation = (client === "scores" ? simulateMania : simulateStableMania)(replay, map);
      const releases = simulation.releases!;
      expect([
        map.objects.filter((o) => o.type & 128).length, releases.length,
        releases.filter((r) => r.hit).length,
        releases.filter((r) => !r.hit && r.offset < 0).length,
        releases.filter((r) => !r.hit && r.offset >= 0).length,
        replay.lazer?.statistics.miss ?? replay.counts.miss,
      ]).toEqual(expected[client][i]);
      if (replay.lazer) expect(simulation.statistics.miss).toBe(replay.lazer.statistics.miss);
    }
  });
}
