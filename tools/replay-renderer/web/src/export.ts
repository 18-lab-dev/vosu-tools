import {
  Composition,
  loadTrack,
  checked,
  type Preset,
  type Track,
} from "./studio";
import { parseReplay } from "@vosu-tools/replay";
import type { Layout } from "@vosu-tools/render-export";
import { telemetry } from "./telemetry";
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
    overlays: {
      folder: string;
      width: number;
      height: number;
      x: number;
      y: number;
      scale: number;
      opacity: number;
    }[];
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
    body: JSON.stringify({
      hash: tracks[0].replay.beatmapHash,
      rate,
      frames,
      mods: tracks[0].replay.mods,
      initial: telemetry(tracks[0], 0),
    }),
  });
  for (let i = 0; i < frames; i++) {
    await composition.renderOffline(((i * 1000) / spec.fps) * rate);
    if (spec.overlays.length) {
      const images = (await (
        await request("frame-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            telemetry(tracks[0], ((i * 1000) / spec.fps) * rate),
          ),
        })
      ).json()) as {
        png: string;
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
        opacity: number;
      }[];
      for (const image of images) {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${image.png}`)).blob(),
        );
        composition.context.save();
        composition.context.globalAlpha = image.opacity;
        composition.context.drawImage(
          bitmap,
          image.x,
          image.y,
          image.width * image.scale,
          image.height * image.scale,
        );
        composition.context.restore();
        bitmap.close();
      }
    }
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
