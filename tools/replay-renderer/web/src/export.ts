import {
  Composition,
  loadTrack,
  checked,
  type Preset,
  type Track,
} from "./studio";
import { parseReplay, replayMods, replayPitched } from "@vosu-tools/replay";
import type { Layout } from "./layout";
import { telemetry } from "./telemetry";
import type { InspectedLayer } from "./inspector";
import { frameRange } from "./partition";
const request = async (path: string, init?: RequestInit) =>
  checked(await fetch(new URL(path, location.href), init));
let composition: Composition | undefined;
const bitmaps = new Map<string, { png: string; bitmap: ImageBitmap }>();
const loadStarted = performance.now();
try {
  const adapterInfo = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }))?.info;
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
    /** Debug export: draw the composition inspector into every frame. */
    inspect?: boolean;
    segment: [number, number] | null;
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
  composition = new Composition(tracks, width, height, spec.layout, false, true);
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
  const [segment, jobs] = spec.segment ?? [0, 1];
  const [first, end] = frameRange(frames, segment, jobs, overlaid.some(Boolean));
  await request("begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hash: tracks[0].replay.beatmapHash,
      rate,
      pitch: replayPitched(tracks[0].replay),
      frames: end - first,
      full_frames: frames,
      start_ms: start,
      tracks: tracks.map((track) => ({
        hash: track.replay.beatmapHash,
        mods: track.replay.mods,
        ...ratingMods(track),
        initial: telemetry(track, start, start),
      })),
    }),
  });
  const timings = { scene: 0, readback: 0, composite: 0, overlays: 0, pixels: 0, transfer: 0, gpu: 0 as number | null };
  const startup = {
    load: performance.now() - loadStarted,
    simulation: tracks.reduce((sum, track) => sum + (track.timings?.simulation ?? 0), 0),
    scene_build: tracks.reduce((sum, track) => sum + (track.timings?.sceneBuild ?? 0), 0),
    warmup: 0,
  };
  // One upload may overlap the next frame's GPU/overlay work. Await it before
  // posting another frame, so HTTP scheduling can never reorder the encoder.
  let upload: Promise<unknown> = Promise.resolve();
  const uploaded = async () => {
    const result = await upload;
    if (result instanceof Error) throw result;
  };
  // Replay every prior overlay state and clock tick, without screenshots. This
  // preserves history-dependent widgets and animations at partition boundaries.
  const warmupStarted = performance.now();
  if (overlaid.some(Boolean) && first < end) {
    for (let i = 0; i < first; i++) {
      const time = start + i * 1000 / spec.fps * rate;
      await request("frame-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tracks.map((track, t) => {
          if (!overlaid[t]) return null;
          const state = telemetry(track, time, start);
          return { ...state, __render: { ...state.__render, capture: false } };
        })),
      });
    }
  }
  startup.warmup = performance.now() - warmupStarted;
  for (let i = first; i < end; i++) {
    const time = start + ((i * 1000) / spec.fps) * rate;
    await composition.renderOffline(time, { fade: false });
    for (const stage of ["scene", "readback", "composite"] as const)
      timings[stage] += composition.timings[stage];
    if (composition.timings.gpu === null) timings.gpu = null;
    else if (timings.gpu !== null) timings.gpu += composition.timings.gpu;
    const pages: InspectedLayer[] = [];
    const pagesStarted = performance.now();
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
        for (const [index, image] of images.entries()) {
          const key = `${track}:${index}`;
          let cached = bitmaps.get(key);
          if (!cached || cached.png !== image.png) {
            const bitmap = await createImageBitmap(
              await (await fetch(`data:image/png;base64,${image.png}`)).blob(),
            );
            cached?.bitmap.close();
            cached = { png: image.png, bitmap };
            bitmaps.set(key, cached);
          }
          const bitmap = cached.bitmap;
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
          if (spec.inspect)
            pages.push({
              name: `V${track + 1} overlay`,
              kind: "overlay",
              box: { x: cell.x + image.x, y: cell.y + image.y, width: image.width * image.scale, height: image.height * image.scale },
              ms: null,
            });
        }
      }
      if (pages[0]) pages[0].ms = performance.now() - pagesStarted;
    }
    timings.overlays += performance.now() - pagesStarted;
    const pixelsStarted = performance.now();
    composition.fade(time);
    if (spec.inspect) composition.drawInspector(time, pages);
    const pixels = composition.context.getImageData(0, 0, width, height);
    timings.pixels += performance.now() - pixelsStarted;
    await uploaded();
    const transferStarted = performance.now();
    upload = request("frame", { method: "POST", body: pixels.data })
      .then(() => { timings.transfer += performance.now() - transferStarted; })
      .catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    document.querySelector("#status")!.textContent = `Frame ${i + 1}/${frames}`;
  }
  await uploaded();
  if (first < end) await request("finish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timings_ms: timings, startup_ms: startup, adapter: adapterInfo && {
      vendor: adapterInfo.vendor, architecture: adapterInfo.architecture,
      device: adapterInfo.device, description: adapterInfo.description,
    } }),
  });
  document.querySelector("#status")!.textContent = "Export complete";
} catch (error) {
  await request("fail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: String(error) }),
  });
  document.querySelector("#status")!.textContent = String(error);
} finally {
  for (const { bitmap } of bitmaps.values()) bitmap.close();
  composition?.destroy();
}
/** lazer's mods for the overlay's pp rating: acronyms (Classic, custom rates) and Difficulty Adjust values. */
function ratingMods(track: Track) {
  if (!track.replay.lazer) return {};
  const mods = replayMods(track.replay),
    da = mods.find((m) => m.acronym === "DA")?.settings ?? {};
  const value = (key: string) => (typeof da[key] === "number" ? da[key] : undefined);
  return {
    acronyms: mods.map((m) => m.acronym).join("") || "NM",
    overrides: {
      ar: value("approach_rate"),
      cs: value("circle_size"),
      od: value("overall_difficulty"),
      hp: value("drain_rate"),
    },
  };
}
