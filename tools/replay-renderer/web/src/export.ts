import {
  Composition,
  loadTrack,
  checked,
  type Preset,
  type Track,
} from "./studio";
import { parseReplay } from "@vosu-tools/replay";
import type { Layout } from "./layout";
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
    /** The client's current skin as the service reads it (see `/v1/context`). */
    current_skin: { builtin: string | null };
    overlays: { tracks: number[] | null }[];
    outro_ms: number;
    fade_ms: number;
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
    tracks.push(
      await loadTrack(entry.id, bytes, preset, request, {
        assetPrefix: "assets",
        currentBuiltin: spec.current_skin.builtin,
      }),
    );
  }
  const [width, height] = spec.resolution.split("x").map(Number);
  composition = new Composition(tracks, width, height, spec.layout);
  composition.timing = { outroMs: spec.outro_ms, fadeMs: spec.fade_ms };
  composition.validate();
  const rate = tracks[0].replay.rate,
    start = composition.start,
    frames = Math.ceil((composition.duration / rate / 1000) * spec.fps);
  const cells = composition.cells();
  // Tracks whose cells show overlay pages: their state drives their own pages.
  const overlaid = spec.overlays.length
    ? tracks.map((_, i) => spec.overlays.some((layer) => !layer.tracks || layer.tracks.includes(i)))
    : tracks.map(() => false);
  await request("begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hash: tracks[0].replay.beatmapHash,
      rate,
      frames,
      start_ms: start,
      tracks: tracks.map((track) => ({
        hash: track.replay.beatmapHash,
        mods: track.replay.mods,
        initial: telemetry(track, start, start),
      })),
    }),
  });
  for (let i = 0; i < frames; i++) {
    const time = start + ((i * 1000) / spec.fps) * rate;
    await composition.renderOffline(time, { fade: false });
    if (overlaid.some(Boolean)) {
      const answers = (await (
        await request("frame-state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            tracks.map((track, t) => (overlaid[t] ? telemetry(track, time, start) : null)),
          ),
        })
      ).json()) as {
        track: number;
        images: {
          png: string;
          x: number;
          y: number;
          width: number;
          height: number;
          scale: number;
          opacity: number;
        }[];
      }[];
      for (const { track, images } of answers) {
        // Overlay positions are relative to the track's cell.
        const cell = cells[track];
        for (const image of images) {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${image.png}`)).blob(),
          );
          composition.context.save();
          composition.context.globalAlpha = image.opacity;
          composition.context.drawImage(
            bitmap,
            cell.x + image.x,
            cell.y + image.y,
            image.width * image.scale,
            image.height * image.scale,
          );
          composition.context.restore();
          bitmap.close();
        }
      }
    }
    composition.fade(time);
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
