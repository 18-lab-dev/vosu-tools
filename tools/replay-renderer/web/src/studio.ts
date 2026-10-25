import {
  parseReplay,
  frameAt,
  stateAt,
  playableMap,
  judgeReplay,
  replayMods,
  replayHealth,
  type Result,
  type Replay,
  type Simulation,
} from "@vosu-tools/replay";
import {
  parseOsu,
  csv,
  type Beatmap,
} from "@vosu-tools/osu-parse";
import {
  builtinLook,
  builtinSkinNames,
  createPlayfield,
  loadPlayfieldSkin,
  maniaKeysFor,
  type BuiltinSkinName,
  type JudgementEvent,
  type Renderer,
  type RenderTarget,
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
import { assertCompatible } from "@vosu-tools/render-export";
import { convertBeatmap, isConvert } from "@vosu-tools/ruleset-convert";
import {
  HUD,
  HUD_KEYS,
  VIEW,
  contentBounds,
  fitBounds,
  hudBox,
  layoutCells,
  place,
  type HudKey,
  type Layout,
  type Rect,
  type Transform,
} from "./layout";
import { BUILTIN } from "./skins";
import { drawInspector, type InspectedLayer } from "./inspector";
import settingSchema from "../../render-settings.json";
export interface Preset {
  skin?: string | null;
  settings: Record<string, number>;
}
export interface Track extends Preset {
  id: string;
  replay: Replay;
  map: Beatmap;
  /** The `.osu`'s own difficulty, before conversion and mods. */
  original: Beatmap["difficulty"];
  /** Played converted from another ruleset. */
  convert: boolean;
  simulation: Simulation | null;
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  warning: string;
  background: ImageBitmap | null;
  /** Drawn built-ins expose no skin files (including the current lazer skin). */
  builtinSamples?: boolean;
  /** Visible playfield extent in world units (see `probeContent`). */
  content: Rect;
  /** Running score, when the judgements verified (see `scoreCurve`). */
  score: ScoreCurve | null;
  timings?: { simulation: number; sceneBuild: number };
  dispose(): void;
}
/**
 * Score over time: the client's own score when the simulation reproduced the
 * recorded total (osu!, catch), else judgement values so far scaled to it.
 */
export interface ScoreCurve {
  times: number[];
  scores: number[];
}
export function scoreCurve(simulation: Simulation, finalScore: number): ScoreCurve {
  const times: number[] = [],
    values: number[] = [];
  if (simulation.scoreVerified) {
    for (const event of simulation.events) {
      times.push(event.time);
      values.push(event.score ?? 0);
    }
    return { times, scores: values };
  }
  let total = 0;
  for (const event of simulation.events) {
    total += event.result ? hitValues[event.result] : 0;
    times.push(event.time);
    values.push(total);
  }
  return { times, scores: values.map((value) => (total ? Math.round((finalScore * value) / total) : 0)) };
}
export function scoreAt(curve: ScoreCurve, time: number) {
  let low = 0,
    high = curve.times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (curve.times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low ? curve.scores[low - 1] : 0;
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
/** One WebGPU device for every track, when WebGPU is available. */
let sharedDevice: Promise<GPUDevice | undefined> | undefined;
/**
 * The playfield's visible extent in world units. osu! and catch use the
 * whole 640×480 view; mania stages and the taiko strip are measured from a
 * reference render, so any skin's stage width is respected.
 */
async function probeContent(renderer: Renderer, mode: number): Promise<Rect> {
  if (mode === 0 || mode === 2) return { ...VIEW };
  const { width, height } = VIEW;
  const target = renderer.createTarget(width, height);
  try {
    renderer.resize(width, height);
    renderer.renderAt(0, { target });
    return fitBounds(mode, contentBounds(await target.read(), width, height));
  } finally {
    target.destroy();
  }
}
const KNOWN = new Set(settingSchema.map((rule) => rule.key));
/** The simulation's results in render-core's terms. */
export function judgementEvents(simulation: Simulation): JudgementEvent[] {
  return simulation.events.flatMap((e) =>
    e.kind
      ? [
          {
            time: e.time,
            result: e.kind,
            note: e.note,
            object: e.object,
            x: e.x,
            y: e.y,
            combo: e.combo,
            catcher: e.catcher,
          },
        ]
      : [],
  );
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
    // Settings this version no longer has (old presets) are dropped.
    ...Object.fromEntries(Object.entries(preset.settings).filter(([key]) => KNOWN.has(key))),
  };
  const raw = parseOsu(
    await (
      await checked(
        await fetcher(`${assetPrefix}?kind=map&hash=${replay.beatmapHash}`),
      )
    ).text(),
  );
  const mods = replayMods(replay);
  // osu! maps play converted in the replay's ruleset, as the clients convert them.
  const source = isConvert(raw, replay.mode) ? convertBeatmap(raw, replay.mode, mods) : raw;
  const map = playableMap(replay, raw);
  // Skin values: "" current skin, "builtin/<id>" a drawn lazer look, else
  // files from the service (stable folder, "imported/…", "lazer/<id>").
  // lazer's built-in current skin has no files: draw it. File skins keep the
  // classic look for any element they lack, as the clients do.
  let skin: Skin,
    owned: ImageBitmap[] = [];
  const drawn = preset.skin?.startsWith(BUILTIN)
    ? preset.skin.slice(BUILTIN.length)
    : preset.skin
      ? null
      : options.currentBuiltin;
  if (drawn && builtinSkinNames.includes(drawn as BuiltinSkinName))
    skin = builtinLook(drawn as BuiltinSkinName);
  else if (preset.skin?.startsWith(BUILTIN))
    throw new Error(`Unknown built-in skin ${preset.skin}`);
  else {
    let loaded: { files: Skin; skin: Skin };
    try {
      loaded = await loadPlayfieldSkin(
        async (filename) => {
          const query = new URLSearchParams({ kind: "skin", path: filename });
          if (preset.skin) query.set("skin", preset.skin);
          try {
            const response = await fetcher(`${assetPrefix}?${query}`);
            return response.ok ? response.blob() : null;
          } catch {
            return null;
          }
        },
        preset.skin ?? "Current skin",
        // Only the played stage's mania images (hold bodies can be large).
        { maniaKeys: maniaKeysFor(source, { mods }) },
      );
    } catch (e) {
      throw new Error(`Skin load failed: ${e}`);
    }
    owned = [...loaded.files.assets.values()];
    skin = loaded.skin;
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
  // Tracks share one WebGPU device; without WebGPU (or with `?backend=webgl2`)
  // each track draws with its own WebGL2 context instead.
  sharedDevice ??= (async () => {
    if (new URLSearchParams(location.search).get("backend") === "webgl2") return undefined;
    try {
      const adapter =
        (await navigator.gpu?.requestAdapter()) ??
        (await navigator.gpu?.requestAdapter());
      return await adapter?.requestDevice({
        requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
      });
    } catch {
      return undefined;
    }
  })();
  // Product: an offscreen target per track (sized by Composition for its
  // layout cell), cleared transparent for the background and dim beneath.
  const renderer = await createPlayfield({
    canvas,
    device: await sharedDevice,
    width: 960,
    height: 540,
    skin,
    format: "rgba8unorm",
    transparent: true,
  });
  let simulation: Simulation | null = null,
    warning = "";
  const simulationStarted = performance.now();
  try {
    simulation = judgeReplay(replay, raw).simulation;
    const differences = Object.entries(simulation.differences).map(
      ([result, d]) => `${result} ${d.expected}≠${d.actual}`,
    );
    // A score that misses the recorded total falls back to the scaled curve silently.
    const notes = simulation.warnings.filter((w) => !w.startsWith("Score:"));
    if (!simulation.verified)
      warning = differences.length
        ? `Counters hidden: judgements differ (${differences.join(", ")})`
        : `Counters hidden: ${notes.join("; ")}`;
    else if (!simulation.comboVerified)
      warning = notes.length
        ? `Combo hidden: ${notes.join("; ")}`
        : `Combo hidden: max combo ${replay.maxCombo} not reproduced`;
  } catch (e) {
    warning = String(e);
  }
  const simulationMs = performance.now() - simulationStarted;
  const sceneStarted = performance.now();
  // Judgements are drawn from the simulation whether or not it verified;
  // only the HUD counters wait for verification.
  renderer.setBeatmap(source, {
    mods,
    scrollSpeed: settings["mania.scroll_speed"],
    noteSpeed: settings.note_speed,
    hitLighting: settings.hit_lighting !== 0,
    taikoTopArea: settings["taiko.top_area"] !== 0,
    judgements: simulation ? judgementEvents(simulation) : undefined,
    // The replay's own input: drum hits, dash trails, key and light timing,
    // the skin's cursor; and lazer's gameplay playfield position.
    input: replay.frames,
    playfieldShift: true,
  });
  const content = await probeContent(renderer, replay.mode);
  return {
    id,
    replay,
    map,
    original: raw.difficulty,
    convert: isConvert(raw, replay.mode),
    simulation,
    timings: { simulation: simulationMs, sceneBuild: performance.now() - sceneStarted },
    renderer,
    canvas,
    skin: preset.skin,
    builtinSamples: !!drawn,
    settings,
    background,
    content,
    score: simulation?.verified ? scoreCurve(simulation, replay.score) : null,
    dispose() {
      renderer.destroy();
      background?.close();
      // Built-in skins are shared between tracks; only file-skin bitmaps are ours.
      for (const bitmap of owned) bitmap.close();
    },
    warning,
  };
}
/** A track's playfield transform, from its render settings. */
export function transformOf(track: Pick<Track, "settings">): Transform {
  return {
    x: track.settings["playfield.x"] ?? 0,
    y: track.settings["playfield.y"] ?? 0,
    scale: track.settings["playfield.scale"] ?? 1,
  };
}
const DEFAULTS = Object.fromEntries(settingSchema.map((rule) => [rule.key, rule.default]));
/** A HUD layer's placement, from its render settings: distance from its cell
 *  corner (HUD units) and scale. */
export function hudTransform(track: Pick<Track, "settings">, key: HudKey): Transform {
  const value = (axis: string) =>
    track.settings[`hud.${key}.${axis}`] ?? DEFAULTS[`hud.${key}.${axis}`];
  return { x: value("dx"), y: value("dy"), scale: value("scale") };
}
/** Whether a HUD layer is switched on for this track. */
export const hudShown = (track: Pick<Track, "settings">, key: HudKey) =>
  (track.settings[`hud.${key}`] ?? 1) !== 0;
const HUD_INK = "#f6f3ee",
  HUD_SHADOW = "rgba(0, 0, 0, 0.7)";
/**
 * Draws a track's enabled HUD layers. Combo, accuracy and score appear only
 * when the replay's judgements verified; health follows the recorded life graph
 * (osu!stable), else lazer's health simulated from those verified judgements.
 */
function drawHud(context: CanvasRenderingContext2D, track: Track, cell: Rect, time: number) {
  const state = track.simulation?.verified ? stateAt(track.replay, track.simulation, time) : null;
  for (const key of HUD_KEYS) {
    if (!hudShown(track, key)) continue;
    const box = hudBox(cell, key, hudTransform(track, key));
    context.save();
    if (key === "health") {
      const health = replayHealth(track.replay, track.simulation, time);
      if (health !== null) {
        context.fillStyle = "rgba(0, 0, 0, 0.45)";
        context.fillRect(box.x, box.y, box.width, box.height);
        context.fillStyle = HUD_INK;
        context.fillRect(box.x, box.y, box.width * health, box.height);
      }
      context.restore();
      continue;
    }
    const text =
      key === "score"
        ? track.score && state
          ? String(scoreAt(track.score, time)).padStart(8, "0")
          : null
        : key === "accuracy"
          ? state
            ? `${(state.accuracy * 100).toFixed(2)}%`
            : null
          : state?.combo != null
            ? `${state.combo}x`
            : null;
    if (text) {
      const right = HUD[key].anchorX === 1;
      context.font = `700 ${Math.round(box.height * 0.86)}px monospace`;
      context.textAlign = right ? "right" : "left";
      context.textBaseline = "middle";
      context.shadowColor = HUD_SHADOW;
      context.shadowBlur = box.height * 0.12;
      context.fillStyle = HUD_INK;
      context.fillText(text, right ? box.x + box.width : box.x, box.y + box.height / 2, box.width);
    }
    context.restore();
  }
}
/** lazer: gameplay starts two seconds before the first object. */
const LEAD_IN_MS = 2000;
/** lazer's Player entry: hidden for 250 ms, then a 250 ms fade in. */
export const ENTRY_HOLD_MS = 250,
  ENTRY_FADE_MS = 250;
/** lazer: results 1000 ms after completion, the player fading out over 250 ms. */
export const DEFAULT_OUTRO_MS = 1250,
  DEFAULT_FADE_MS = 250;
export class Composition {
  canvas = document.createElement("canvas");
  context: CanvasRenderingContext2D;
  private staging: HTMLCanvasElement;
  /** Wall-clock stage timings for the most recently completed offline frame. */
  timings = { scene: 0, readback: 0, composite: 0, gpu: null as number | null };
  private frameContext: CanvasRenderingContext2D;
  private readbacks: {
    target: RenderTarget;
    width: number;
    height: number;
    pixels: ImageData;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    query?: GPUQuerySet;
    queryResolve?: GPUBuffer;
    queryRead?: GPUBuffer;
  }[] = [];
  constructor(
    public tracks: Track[],
    public width: number,
    public height: number,
    public layout: Layout,
    /** Preview publishes atomically; exports have no visible previous frame. */
    atomic = true,
    private profile = false,
  ) {
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas2D unavailable");
    this.context = context;
    this.staging = atomic ? document.createElement("canvas") : this.canvas;
    const frameContext = this.staging.getContext("2d", {
      willReadFrequently: true,
    });
    if (!frameContext) throw new Error("Canvas2D unavailable");
    this.frameContext = frameContext;
    this.resize(width, height, layout);
  }
  /** Layout cells in output pixels, one per track. */
  cells(): Rect[] {
    return layoutCells(
      this.tracks.length,
      this.width,
      this.height,
      this.layout,
      this.tracks.map((track) => track.content),
    );
  }
  /** (Re)creates render targets sized for every playfield's current scale. */
  resize(width: number, height: number, layout: Layout) {
    this.width = width;
    this.height = height;
    this.layout = layout;
    this.canvas.width = width;
    this.canvas.height = height;
    this.staging.width = width;
    this.staging.height = height;
    this.releaseTargets();
    this.cells().forEach((cell, i) => {
      const track = this.tracks[i],
        renderer = track.renderer,
        { width: w, height: h } = place(cell, track.content, transformOf(track)).target;
      renderer.resize(w, h);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      // GPU pass timings need WebGPU's timestamp queries; WebGL2 reports none.
      const device = renderer.device;
      const query = this.profile && device?.features.has("timestamp-query")
        ? device.createQuerySet({ type: "timestamp", count: 2 }) : undefined;
      this.readbacks.push({
        target: renderer.createTarget(w, h),
        query,
        queryResolve: query ? device!.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : undefined,
        queryRead: query ? device!.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : undefined,
        width: w,
        height: h,
        pixels: new ImageData(w, h),
        canvas,
        context: canvas.getContext("2d", { willReadFrequently: true })!,
      });
    });
  }
  /** Re-renders targets at the playfields' current scales (after an edit). */
  retarget() {
    this.resize(this.width, this.height, this.layout);
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
  /** Draws the frame at map `time`. `fade` false leaves the fade to the caller
   *  (the MP4 export composites overlay pages first). */
  async renderOffline(time: number, { fade = true } = {}): Promise<HTMLCanvasElement> {
    this.timings = { scene: 0, readback: 0, composite: 0, gpu: this.readbacks.some((resource) => resource.query) ? 0 : null };
    const context = this.frameContext;
    context.fillStyle = "#000";
    context.fillRect(0, 0, this.width, this.height);
    const rects = this.cells();
    const layers: InspectedLayer[] = [];
    let started = performance.now();
    const took = () => {
      const now = performance.now(),
        ms = now - started;
      started = now;
      return ms;
    };
    // Backgrounds first: a playfield moved over a neighbouring cell stays on top.
    this.tracks.forEach((track, i) => {
      const rect = rects[i],
        bg = track.background;
      if (!bg) return;
      context.save();
      context.beginPath();
      context.rect(rect.x, rect.y, rect.width, rect.height);
      context.clip();
      // Cover the cell, cropping the image rather than stretching it.
      const cover = Math.max(rect.width / bg.width, rect.height / bg.height);
      context.drawImage(
        bg,
        rect.x + (rect.width - bg.width * cover) / 2,
        rect.y + (rect.height - bg.height * cover) / 2,
        bg.width * cover,
        bg.height * cover,
      );
      context.fillStyle = `rgba(0,0,0,${track.settings.background_dim ?? 0.85})`;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.restore();
      layers.push({ name: `V${i + 1} background`, kind: "background", box: rect, ms: took() });
    });
    const mappings: Promise<unknown>[] = [];
    for (let i = 0; i < this.tracks.length; i++) {
      const sceneStarted = performance.now();
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
        target: resource.target,
        timestampWrites: resource.query ? {
          querySet: resource.query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1,
        } : undefined,
        cursor: {
          x: frame.x,
          y: frame.y,
          pressed: !!frame.keys,
          scale: settings["cursor.size"] ?? 1,
        },
        // The look-back trail for skins without a cursortrail image.
        cursorTrail: trail,
      });
      const device = track.renderer.device;
      if (resource.query && device) {
        const commands = device.createCommandEncoder();
        commands.resolveQuerySet(resource.query, 0, 2, resource.queryResolve!, 0);
        commands.copyBufferToBuffer(resource.queryResolve!, 0, resource.queryRead!, 0, 16);
        device.queue.submit([commands.finish()]);
      }
      this.timings.scene += performance.now() - sceneStarted;
      mappings.push(resource.target.read(new Uint8Array(resource.pixels.data.buffer)));
      if (resource.queryRead) mappings.push(resource.queryRead.mapAsync(GPUMapMode.READ));
    }
    // Submit every player's work before waiting for the GPU, then preserve
    // paint order while consuming the mapped buffers. No frame clock changes.
    const readbackStarted = performance.now();
    await Promise.all(mappings);
    this.timings.readback += performance.now() - readbackStarted;
    for (let i = 0; i < this.tracks.length; i++) {
      const copyStarted = performance.now(),
        resource = this.readbacks[i],
        track = this.tracks[i],
        rect = rects[i],
        { width: tw, height: th } = resource;
      if (resource.queryRead) {
        const ticks = new BigUint64Array(resource.queryRead.getMappedRange());
        this.timings.gpu! += Number(ticks[1] - ticks[0]) / 1e6;
        resource.queryRead.unmap();
      }
      this.timings.readback += performance.now() - copyStarted;
      const compositeStarted = performance.now();
      resource.context.putImageData(resource.pixels, 0, 0);
      // Playfields may be moved anywhere in the frame, so they clip to it.
      const { draw, box } = place(rect, track.content, transformOf(track), {
        width: tw,
        height: th,
      });
      context.drawImage(resource.canvas, draw.x, draw.y, draw.width, draw.height);
      layers.push({ name: `V${i + 1} playfield`, kind: "playfield", box, ms: took() });
      this.timings.composite += performance.now() - compositeStarted;
    }
    // HUD layers last: they stay above every playfield, wherever those were moved.
    this.tracks.forEach((track, i) => {
      drawHud(context, track, rects[i], time);
      const ms = took();
      for (const key of HUD_KEYS)
        if (hudShown(track, key))
          layers.push({ name: `V${i + 1} ${key}`, kind: "hud", box: hudBox(rects[i], key, hudTransform(track, key)), ms: key === "score" ? ms : null });
    });
    this.inspected = layers;
    if (fade) {
      this.fade(time, context);
      if (this.inspect) this.drawInspector(time, this.overlayBoxes, context);
    }
    // Publish atomically: GPU readback must not blank the previous visible preview.
    if (this.staging !== this.canvas) this.context.drawImage(this.staging, 0, 0);
    return this.canvas;
  }
  /** Outro after the last object and the fade at its end (wall-clock ms);
   *  lazer shows results 1000 ms after the last judgement, fading out over 250 ms. */
  timing = { outroMs: DEFAULT_OUTRO_MS, fadeMs: DEFAULT_FADE_MS };
  /** First rendered map time: lazer's gameplay start, two seconds before the
   *  first object (earlier when the map asks for a longer audio lead-in), never after 0. */
  get start() {
    return Math.min(
      ...this.tracks.map((t) => {
        const first = t.map.objects[0]?.time ?? 0,
          leadIn = Number(t.map.general.AudioLeadIn) || 0;
        return Math.min(0, first - LEAD_IN_MS, leadIn > 0 ? first - leadIn : 0);
      }),
    );
  }
  /** Last rendered map time: the last object's end plus the outro. */
  get end() {
    const rate = this.tracks[0]?.replay.rate ?? 1;
    return Math.max(...this.tracks.map((t) => t.map.duration)) + this.timing.outroMs * rate;
  }
  get duration() {
    return this.end - this.start;
  }
  /** Black over the picture at `time`: lazer's entry (250 ms black, then a
   *  250 ms fade in) and the fade out at the end of the outro. 0 = clear. */
  dimAt(time: number) {
    const rate = this.tracks[0]?.replay.rate ?? 1,
      sinceStart = (time - this.start) / rate,
      untilEnd = (this.end - time) / rate,
      fade = this.timing.fadeMs;
    const entry = Math.min(1, Math.max(0, 1 - (sinceStart - ENTRY_HOLD_MS) / ENTRY_FADE_MS));
    const exit = fade > 0 ? Math.min(1, Math.max(0, 1 - untilEnd / fade)) : untilEnd <= 0 ? 1 : 0;
    return Math.max(entry, exit);
  }
  /** Development aid: draw the composition inspector over each frame. */
  inspect = false;
  /** Overlay boxes the preview shows in the inspector (pages render only in MP4). */
  overlayBoxes: InspectedLayer[] = [];
  /** The last frame's layers in paint order, with their draw times. */
  inspected: InspectedLayer[] = [];
  /** Draws the inspector over the finished frame; `overlays` are layers the
   *  caller painted after `renderOffline` (overlay pages in the MP4 export, or
   *  their boxes in the preview). */
  drawInspector(time: number, overlays: readonly InspectedLayer[], context = this.context) {
    drawInspector(context, this, this.cells(), [...this.inspected, ...overlays], {
      time,
      start: this.start,
      end: this.end,
      dim: this.dimAt(time),
    });
  }
  /** Fades the finished frame (after overlays, when the caller adds them). */
  fade(time: number, context = this.context) {
    const dim = this.dimAt(time);
    if (dim <= 0) return;
    context.save();
    context.fillStyle = `rgba(0, 0, 0, ${dim})`;
    context.fillRect(0, 0, this.width, this.height);
    context.restore();
  }
  releaseTargets() {
    for (const resource of this.readbacks) {
      resource.target.destroy();
      resource.query?.destroy();
      resource.queryRead?.destroy();
      resource.queryResolve?.destroy();
    }
    this.readbacks = [];
  }
  destroy() {
    this.releaseTargets();
    for (const track of this.tracks) track.dispose();
  }
}
