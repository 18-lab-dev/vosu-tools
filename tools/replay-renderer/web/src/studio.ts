import {
  parseReplay,
  frameAt,
  columnKeys,
  simulate,
  stateAt,
  healthAt,
  type Result,
  type Replay,
  type Simulation,
} from "@vosu-tools/replay";
import {
  parseOsu,
  applyMods,
  csv,
  type Beatmap,
  type Mod,
} from "@vosu-tools/osu-parse";
import {
  builtinSkin,
  builtinSkinNames,
  createRenderer,
  loadSkin,
  withFallback,
  type BuiltinSkinName,
  type Renderer,
  type Skin,
} from "@vosu-tools/render-core";
const hitValues: Record<Result, number> = {
  geki: 320,
  n300: 300,
  katu: 200,
  n100: 100,
  n50: 50,
  miss: 0,
};
import {
  layoutRects,
  assertCompatible,
  type Layout,
} from "@vosu-tools/render-export";
import settingSchema from "../../render-settings.json";
export interface Preset {
  skin?: string | null;
  settings: Record<string, number>;
}
export interface Track extends Preset {
  id: string;
  replay: Replay;
  map: Beatmap;
  simulation: Simulation | null;
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  warning: string;
  background: ImageBitmap | null;
  dispose(): void;
}
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
/** A failed service call; `details` is the JSON error body when there is one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
  }
}
export async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const text = await response.text();
    let details: Record<string, unknown> | null = null;
    try {
      details = JSON.parse(text);
    } catch {}
    const message = details?.error;
    throw new ApiError(
      typeof message === "string" ? message : text,
      response.status,
      details,
    );
  }
  return response;
}
let sharedDevice: Promise<GPUDevice> | undefined;
/** Built-in skins are drawn once per page and shared by every track. */
const builtins = new Map<BuiltinSkinName, Skin>();
function builtin(name: BuiltinSkinName) {
  let skin = builtins.get(name);
  if (!skin) builtins.set(name, (skin = builtinSkin(name)));
  return skin;
}
export interface LoadOptions {
  /** Service route prefix for map and skin files. */
  assetPrefix?: string;
  /** lazer built-in id (`argon`, …) when the client's current skin has no files. */
  currentBuiltin?: string | null;
}
export async function loadTrack(
  id: string,
  bytes: Uint8Array,
  preset: Preset,
  fetcher: Fetcher,
  options: LoadOptions = {},
): Promise<Track> {
  const assetPrefix = options.assetPrefix ?? "v1/assets";
  const replay = await parseReplay(bytes);
  const settings = {
    ...Object.fromEntries(
      settingSchema
        .filter((rule) => rule.modes.includes(replay.mode))
        .map((rule) => [rule.key, rule.default]),
    ),
    ...preset.settings,
  };
  const raw = parseOsu(
    await (
      await checked(
        await fetcher(`${assetPrefix}?kind=map&hash=${replay.beatmapHash}`),
      )
    ).text(),
  );
  if (raw.mode !== replay.mode)
    throw new Error(
      "Converted rulesets are not yet supported; select a native-ruleset replay",
    );
  const mods: Mod[] = [];
  for (const [bit, acronym] of [
    [1, "NF"],
    [2, "EZ"],
    [8, "HD"],
    [16, "HR"],
    [64, "DT"],
    [256, "HT"],
    [512, "NC"],
    [1024, "FL"],
    [1048576, "FI"],
    [1073741824, "MR"],
  ] as const)
    if (replay.mods & bit) mods.push({ acronym });
  const map = applyMods(raw, mods);
  const columns = Math.round(map.difficulty.cs);
  // lazer's built-in current skin has no files: draw it. File skins keep the
  // classic look for any element they lack, as the clients do.
  let skin: Skin,
    owned: ImageBitmap[] = [];
  const current = options.currentBuiltin;
  if (!preset.skin && builtinSkinNames.includes(current as BuiltinSkinName))
    skin = builtin(current as BuiltinSkinName);
  else {
    let loaded: Skin;
    try {
      loaded = await loadSkin(async (filename) => {
        const query = new URLSearchParams({ kind: "skin", path: filename });
        if (preset.skin) query.set("skin", preset.skin);
        try {
          const response = await fetcher(`${assetPrefix}?${query}`);
          return response.ok ? response.blob() : null;
        } catch {
          return null;
        }
      }, preset.skin ?? "Current skin");
    } catch (e) {
      throw new Error(`Skin load failed: ${e}`);
    }
    owned = [...loaded.assets.values()];
    skin = withFallback(loaded, builtin("legacy"));
  }
  let background: ImageBitmap | null = null;
  const backgroundFile = raw.events
    .map(csv)
    .find((fields) => fields[0] === "0" && fields[2])?.[2];
  if (backgroundFile) {
    const response = await fetcher(
      `${assetPrefix}?${new URLSearchParams({ kind: "map-asset", hash: replay.beatmapHash, path: backgroundFile })}`,
    );
    background = await createImageBitmap(await response.blob());
  }
  const canvas = document.createElement("canvas");
  sharedDevice ??= (async () => {
    const adapter =
      (await navigator.gpu.requestAdapter()) ??
      (await navigator.gpu.requestAdapter());
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    return adapter.requestDevice();
  })();
  const renderer = await createRenderer({
    canvas,
    device: await sharedDevice,
    width: 960,
    height: 540,
    skin,
    format: "rgba8unorm",
    transparentBackground: true,
  });
  renderer.setBeatmap(raw, {
    mods,
    scrollSpeed: settings["mania.scroll_speed"],
    noteSpeed: settings.note_speed,
    hitLighting: settings.hit_lighting !== 0,
  });
  let simulation: Simulation | null = null,
    warning = "";
  if (replay.mode === 1 || replay.mode === 3) {
    try {
      simulation = simulate(
        replay,
        map.objects.map((o) => ({
          time: o.time,
          endTime: o.type & 128 ? o.endTime : undefined,
          column: Math.min(columns - 1, Math.floor((o.x * columns) / 512)),
          rim: !!(o.sound & 10),
          kind:
            o.type & 128
              ? "hold"
              : o.type & 2
                ? "slider"
                : o.type & 8
                  ? "spinner"
                  : "circle",
          x: o.x,
          y: o.y,
        })),
        map.difficulty.od,
        columns,
      );
      if (!simulation.verified)
        warning = `Counters hidden: judgements differ (${Object.entries(
          simulation.differences,
        )
          .map(([result, d]) => `${result} ${d.expected}≠${d.actual}`)
          .join(", ")})`;
    } catch (e) {
      warning = String(e);
    }
  } else warning = "No judgement counters for this ruleset";
  return {
    id,
    replay,
    map,
    simulation,
    renderer,
    canvas,
    skin: preset.skin,
    settings,
    background,
    dispose() {
      renderer.destroy();
      background?.close();
      // Built-in skins are shared between tracks; only file-skin bitmaps are ours.
      for (const bitmap of owned) bitmap.close();
    },
    warning,
  };
}
export class Composition {
  canvas = document.createElement("canvas");
  context: CanvasRenderingContext2D;
  private staging = document.createElement("canvas");
  private frameContext: CanvasRenderingContext2D;
  private readbacks: {
    texture: GPUTexture;
    buffer: GPUBuffer;
    stride: number;
    pixels: ImageData;
    canvas: HTMLCanvasElement;
  }[] = [];
  constructor(
    public tracks: Track[],
    public width: number,
    public height: number,
    public layout: Layout,
  ) {
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas2D unavailable");
    this.context = context;
    const frameContext = this.staging.getContext("2d", {
      willReadFrequently: true,
    });
    if (!frameContext) throw new Error("Canvas2D unavailable");
    this.frameContext = frameContext;
    this.resize(width, height, layout);
  }
  resize(width: number, height: number, layout: Layout) {
    this.width = width;
    this.height = height;
    this.layout = layout;
    this.canvas.width = width;
    this.canvas.height = height;
    this.staging.width = width;
    this.staging.height = height;
    for (const resource of this.readbacks) {
      resource.texture.destroy();
      resource.buffer.destroy();
    }
    this.readbacks = [];
    layoutRects(this.tracks.length, width, height, layout).forEach((r, i) => {
      const renderer = this.tracks[i].renderer;
      renderer.resize(r.width, r.height);
      const stride = Math.ceil((r.width * 4) / 256) * 256;
      const canvas = document.createElement("canvas");
      canvas.width = r.width;
      canvas.height = r.height;
      this.readbacks.push({
        texture: renderer.device.createTexture({
          size: [r.width, r.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
        buffer: renderer.device.createBuffer({
          size: stride * r.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        stride,
        pixels: new ImageData(r.width, r.height),
        canvas,
      });
    });
  }
  validate() {
    assertCompatible(
      this.tracks.map((t) => ({
        rate: t.replay.rate,
        beatmapHash: t.replay.beatmapHash,
        mapset:
          t.map.metadata.BeatmapSetID && t.map.metadata.BeatmapSetID !== "-1"
            ? t.map.metadata.BeatmapSetID
            : undefined,
      })),
    );
  }
  async renderOffline(time: number): Promise<HTMLCanvasElement> {
    const context = this.frameContext;
    context.fillStyle = "#111214";
    context.fillRect(0, 0, this.width, this.height);
    const rects = layoutRects(
      this.tracks.length,
      this.width,
      this.height,
      this.layout,
    );
    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i],
        frame = frameAt(track.replay, time),
        resource = this.readbacks[i],
        rect = rects[i];
      const settings = track.settings;
      const trailDuration = settings["cursor.trail_ms"] ?? 0,
        trail = [];
      if (track.replay.mode === 0 || track.replay.mode === 2)
        for (let ago = trailDuration; ago > 0; ago -= 16) {
          const sample = frameAt(track.replay, time - ago);
          trail.push({
            x: sample.x,
            y: sample.y,
            opacity: (1 - ago / Math.max(1, trailDuration)) * 0.6,
            scale: settings["cursor.size"] ?? 1,
          });
        }
      track.renderer.renderAt(time, {
        target: resource.texture.createView(),
        cursor: {
          x: frame.x,
          y: frame.y,
          pressed: !!frame.keys,
          scale: settings["cursor.size"] ?? 1,
        },
        cursorTrail: trail,
        keys:
          track.replay.mode === 3
            ? columnKeys(frame, Math.round(track.map.difficulty.cs))
            : undefined,
        judgements: track.simulation?.verified
          ? track.simulation.events
              .filter((event) => event.time <= time && event.time > time - 300)
              .map((event) => ({
                x: event.x,
                y: event.y,
                time: event.time,
                result: hitValues[event.result],
              }))
          : [],
      });
      const commands = track.renderer.device.createCommandEncoder();
      commands.copyTextureToBuffer(
        { texture: resource.texture },
        { buffer: resource.buffer, bytesPerRow: resource.stride },
        { width: rect.width, height: rect.height },
      );
      track.renderer.device.queue.submit([commands.finish()]);
      await resource.buffer.mapAsync(GPUMapMode.READ);
      const source = new Uint8Array(resource.buffer.getMappedRange());
      for (let y = 0; y < rect.height; y++)
        resource.pixels.data.set(
          source.subarray(
            y * resource.stride,
            y * resource.stride + rect.width * 4,
          ),
          y * rect.width * 4,
        );
      resource.buffer.unmap();
      resource.canvas.getContext("2d")!.putImageData(resource.pixels, 0, 0);
      context.save();
      context.beginPath();
      context.rect(rect.x, rect.y, rect.width, rect.height);
      context.clip();
      if (track.background) {
        context.drawImage(
          track.background,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        );
        context.fillStyle = `rgba(0,0,0,${settings.background_dim ?? 0.85})`;
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      const scale = settings["playfield.scale"] ?? 1;
      const x = rect.x + rect.width * (0.5 + (settings["playfield.x"] ?? 0)),
        y = rect.y + rect.height * (0.5 + (settings["playfield.y"] ?? 0));
      context.drawImage(
        resource.canvas,
        x - (rect.width * scale) / 2,
        y - (rect.height * scale) / 2,
        rect.width * scale,
        rect.height * scale,
      );
      context.restore();
      const state = track.simulation?.verified
        ? stateAt(track.replay, track.simulation, time)
        : null;
      context.fillStyle = "#111214";
      context.fillRect(rect.x, rect.y, rect.width, 34);
      context.fillStyle = "#ff963f";
      context.font = `${Math.max(12, Math.round(rect.height / 30))}px monospace`;
      const hud = [
        settings["hud.player"] !== 0 ? track.replay.player : "",
        state && state.combo !== null && settings["hud.combo"] !== 0
          ? `${state.combo}x`
          : "",
        state && settings["hud.accuracy"] !== 0
          ? `${(state.accuracy * 100).toFixed(2)}%`
          : "",
      ].filter(Boolean);
      context.fillText(hud.join("  "), rect.x + 12, rect.y + 23);
      if (state && settings["hud.judgements"] !== 0) {
        context.font = "12px monospace";
        context.fillText(
          Object.entries(state.counts)
            .map(([key, value]) => `${key}:${value}`)
            .join("  "),
          rect.x + 12,
          rect.y + 50,
        );
      }
      if (
        settings.key_overlay !== 0 &&
        (track.replay.mode === 1 || track.replay.mode === 3)
      ) {
        const keys =
          track.replay.mode === 3
            ? columnKeys(frame, Math.round(track.map.difficulty.cs))
            : Array.from(
                { length: 4 },
                (_, key) => !!(frame.keys & (1 << key)),
              );
        keys.forEach((pressed, key) => {
          context.fillStyle = pressed ? "#ff963f" : "#303239";
          context.fillRect(
            rect.x + 12 + key * 26,
            rect.y + rect.height - 24,
            22,
            12,
          );
        });
      }
      const health = healthAt(track.replay, time);
      if (health !== null && settings["hud.health"] !== 0) {
        context.fillStyle = "#3a3c3f";
        context.fillRect(rect.x, rect.y + 32, rect.width, 3);
        context.fillStyle = "#ff963f";
        context.fillRect(rect.x, rect.y + 32, rect.width * health, 3);
      }
    }
    // Publish atomically: GPU readback must not blank the previous visible preview.
    this.context.drawImage(this.staging, 0, 0);
    return this.canvas;
  }
  get duration() {
    return (
      Math.max(
        ...this.tracks.map((t) =>
          Math.max(t.map.duration, t.replay.frames.at(-1)?.time ?? 0),
        ),
      ) + 1500
    );
  }
  releaseTargets() {
    for (const resource of this.readbacks) {
      resource.texture.destroy();
      resource.buffer.destroy();
    }
    this.readbacks = [];
  }
  destroy() {
    this.releaseTargets();
    for (const track of this.tracks) track.dispose();
  }
}
