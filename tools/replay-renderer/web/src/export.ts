import {
  Composition,
  loadTrack,
  checked,
  type Preset,
  type Track,
} from "./studio";
import { parseReplay } from "@vosu-tools/replay";
import type { Layout } from "@vosu-tools/render-export";
const request = async (path: string, init?: RequestInit) =>
  checked(await fetch(new URL(path, location.href), init));
let composition: Composition | undefined;
try {
  const spec = (await (await request("spec")).json()) as {
    replays: ({ id: string } & Preset)[];
    fps: number;
    resolution: string;
    layout: Layout;
    presets: Record<string, Preset>;
    default_settings: Record<string, number>;
  };
  const tracks: Track[] = [];
  for (const entry of spec.replays) {
    const bytes = new Uint8Array(
      await (await request(`replay/${entry.id}`)).arrayBuffer(),
    );
    const header = await parseReplay(bytes);
    const saved = spec.presets[header.player];
    const preset = {
      skin: entry.skin ?? saved?.skin,
      settings: {
        ...spec.default_settings,
        ...saved?.settings,
        ...entry.settings,
      },
    };
    tracks.push(await loadTrack(entry.id, bytes, preset, request, "assets"));
  }
  const [width, height] = spec.resolution.split("x").map(Number);
  composition = new Composition(tracks, width, height, spec.layout);
  composition.validate();
  const rate = tracks[0].replay.rate,
    frames = Math.ceil((composition.duration / rate / 1000) * spec.fps);
  await request("begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash: tracks[0].replay.beatmapHash, rate, frames }),
  });
  for (let i = 0; i < frames; i++) {
    await composition.renderOffline(((i * 1000) / spec.fps) * rate);
    const pixels = composition.context.getImageData(0, 0, width, height);
    await request("frame", { method: "POST", body: pixels.data });
    document.querySelector("#status")!.textContent = `Frame ${i + 1}/${frames}`;
  }
  await request("finish", { method: "POST" });
  document.querySelector("#status")!.textContent = "Export complete";
} catch (error) {
  await request("fail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: String(error) }),
  });
  document.querySelector("#status")!.textContent = String(error);
} finally {
  composition?.destroy();
}
