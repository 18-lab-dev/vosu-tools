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
  type Beatmap,
  type Mod,
} from "@vosu-tools/osu-parse";
import {
  createRenderer,
  loadSkin,
  type Renderer,
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
}
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
export async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    let message = await response.text();
    try {
      message = JSON.parse(message).error ?? message;
    } catch {}
    throw new Error(message);
  }
  return response;
}
let sharedDevice: Promise<GPUDevice> | undefined;
export async function loadTrack(
  id: string,
  bytes: Uint8Array,
  preset: Preset,
  fetcher: Fetcher,
  assetPrefix = "v1/assets",
): Promise<Track> {
  const replay = await parseReplay(bytes);
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
  let skin;
  try {
    skin = await loadSkin(async (filename) => {
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
  });
  renderer.setBeatmap(raw, {
    mods,
    scrollSpeed: preset.settings["mania.scroll_speed"],
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
        warning = `Judgement verification failed: ${JSON.stringify(simulation.differences)}. Timing HUD omitted.`;
    } catch (e) {
      warning = String(e);
    }
  } else warning = "Judgement HUD unavailable for this ruleset";
  return {
    id,
    replay,
    map,
    simulation,
    renderer,
    canvas,
    skin: preset.skin,
    settings: preset.settings,
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
      track.renderer.renderAt(time, {
        target: resource.texture.createView(),
        cursor: { x: frame.x, y: frame.y, pressed: !!frame.keys },
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
      context.drawImage(resource.canvas, rect.x, rect.y);
      const state = track.simulation?.verified
        ? stateAt(track.replay, track.simulation, time)
        : null;
      context.fillStyle = "#111214";
      context.fillRect(rect.x, rect.y, rect.width, 34);
      context.fillStyle = "#ff963f";
      context.font = `${Math.max(12, Math.round(rect.height / 30))}px monospace`;
      context.fillText(
        `${track.replay.player}${state ? `  ${state.combo}x  ${(state.accuracy * 100).toFixed(2)}%` : ""}`,
        rect.x + 12,
        rect.y + 23,
      );
      const health = healthAt(track.replay, time);
      if (health !== null) {
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
    for (const track of this.tracks) track.renderer.destroy();
  }
}
