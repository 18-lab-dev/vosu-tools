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
  type ReplayMod,
  type Simulation,
} from "@vosu-tools/replay";
import {
  parseOsu,
  csv,
  type Beatmap,
} from "@vosu-tools/osu-parse";
import {
  ACCURACY_SCALE,
  SCORE_SCALE,
  builtinLook,
  builtinSkinNames,
  comboChanges,
  createPlayfield,
  drawHealth,
  drawHudText,
  formatAccuracy,
  healthFrame,
  healthSize,
  hudText,
  legacyComboFrame,
  loadHud,
  loadPlayfieldSkin,
  maniaComboFrame,
  maniaConfig,
  maniaKeysFor,
  rolling,
  rollingAt,
  type BuiltinSkinName,
  type ComboChange,
  type HealthSource,
  type Hud,
  type HudFont,
  type JudgementEvent,
  type ManiaConfig,
  type Renderer,
  type RenderTarget,
  type Rolling,
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
  HUD_KEYS,
  VIEW,
  contentBounds,
  drawnWidth,
  fitBounds,
  hudBox,
  hudTransformFor,
  hudUnit,
  layoutCells,
  place,
  uiUnit,
  worldToOutput,
  type HudKey,
  type Layout,
  type Rect,
  type Size,
  type Transform,
} from "./layout";
import { BUILTIN } from "./skins";
import { drawInspector, type InspectedLayer } from "./inspector";
import {
  DEFAULT_OVERLAP,
  overlapColour,
  overlapEligibility,
  overlapJudgements,
  overlapMods,
  overlapTint,
  type OverlapOptions,
} from "./overlap";
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
  /** The map as the renderer draws it (converted for converts, before mods),
   *  the replay's mods and its playfield skin: an overlap draws from them. */
  source: Beatmap;
  mods: ReplayMod[];
  look: Skin;
  simulation: Simulation | null;
  /** The simulation's results in render-core's terms; null when not judged. */
  events: JudgementEvent[] | null;
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  warning: string;
  background: ImageBitmap | null;
  /** Drawn built-ins expose no skin files (including the current lazer skin). */
  builtinSamples?: boolean;
  /** Visible playfield extent in world units (see `probeContent`). */
  content: Rect;
  /** World width the playfield draws, centred on x = 256 (see `probeContent`). */
  drawn: number;
  /** Running score, when the judgements verified (see `scoreCurve`). */
  score: ScoreCurve | null;
  /** The skin's HUD and the values it shows (see `trackHud`). */
  hud: TrackHud;
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
 * An offscreen playfield renderer (sized by Composition for its layout cell),
 * cleared transparent for the background and dim beneath. Tracks share one
 * WebGPU device; without WebGPU (or with `?backend=webgl2`) each draws with
 * its own WebGL2 context instead.
 */
async function newPlayfield(skin: Skin): Promise<{ renderer: Renderer; canvas: HTMLCanvasElement }> {
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
  const canvas = document.createElement("canvas");
  const renderer = await createPlayfield({
    canvas,
    device: await sharedDevice,
    width: 960,
    height: 540,
    skin,
    format: "rgba8unorm",
    transparent: true,
  });
  return { renderer, canvas };
}
/**
 * The playfield's visible extent in world units. osu! and catch use the
 * whole 640×480 view; mania stages and the taiko strip are measured from a
 * reference render, so any skin's stage width is respected. `drawn` is the
 * world width the playfield draws (mania's StageLeft/StageRight images may
 * reach past the view, `PROBE_WIDTH` at most), the view's elsewhere.
 */
async function probeContent(renderer: Renderer, mode: number): Promise<{ content: Rect; drawn: number }> {
  if (mode === 0 || mode === 2) return { content: { ...VIEW }, drawn: VIEW.width };
  const probe = async (width: number) => {
    const target = renderer.createTarget(width, VIEW.height);
    try {
      renderer.resize(width, VIEW.height);
      renderer.renderAt(0, { target });
      return await target.read();
    } finally {
      target.destroy();
    }
  };
  const content = fitBounds(mode, contentBounds(await probe(VIEW.width), VIEW.width, VIEW.height));
  return { content, drawn: mode === 3 ? drawnWidth(await probe(PROBE_WIDTH), PROBE_WIDTH, VIEW.height) : VIEW.width };
}
/** World width of mania's wide probe: past the half width of a 32:9 frame (853 units). */
const PROBE_WIDTH = 4 * VIEW.width;
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
    files: Skin | null = null,
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
    files = loaded.files;
    skin = loaded.skin;
  }
  // A background the map names but does not ship (404) or names outside its
  // folder (400), or one that does not decode, leaves the cell black, as the
  // clients show it; other failures (the service itself) still fail the load.
  let background: ImageBitmap | null = null;
  const backgroundFile = raw.events
    .map(csv)
    .find((fields) => fields[0] === "0" && fields[2])?.[2];
  if (backgroundFile) {
    let blob: Blob | null = null;
    try {
      blob = await (
        await fetcher(
          `${assetPrefix}?${new URLSearchParams({ kind: "map-asset", hash: replay.beatmapHash, path: backgroundFile })}`,
        )
      ).blob();
    } catch (error) {
      if (!(error instanceof ApiError && (error.status === 404 || error.status === 400))) throw error;
    }
    if (blob) background = await createImageBitmap(blob).catch(() => null);
  }
  const { renderer, canvas } = await newPlayfield(skin);
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
  const events = simulation ? judgementEvents(simulation) : null;
  renderer.setBeatmap(source, {
    mods,
    scrollSpeed: settings["mania.scroll_speed"],
    // lazer's scroll direction is a client setting, not part of the replay.
    maniaScrollUp: settings["mania.scroll_up"] === 1,
    hitLighting: settings.hit_lighting !== 0,
    taikoTopArea: settings["taiko.top_area"] !== 0,
    judgements: events ?? undefined,
    // The replay's own input: drum hits, dash trails, key and light timing,
    // the skin's cursor; and lazer's gameplay playfield position.
    input: replay.frames,
    playfieldShift: true,
  });
  const probed = await probeContent(renderer, replay.mode);
  const score = simulation?.verified ? scoreCurve(simulation, replay.score) : null;
  const keys = maniaKeysFor(source, { mods })[0];
  const hud = await trackHud(
    files,
    replay,
    simulation,
    score,
    keys ? maniaConfig(skin, keys) : null,
    settings["mania.scroll_up"] === 1,
  );
  return {
    id,
    replay,
    map,
    original: raw.difficulty,
    convert: isConvert(raw, replay.mode),
    source,
    mods,
    look: skin,
    simulation,
    events,
    timings: { simulation: simulationMs, sceneBuild: performance.now() - sceneStarted },
    renderer,
    canvas,
    skin: preset.skin,
    builtinSamples: !!drawn,
    settings,
    background,
    content: probed.content,
    drawn: probed.drawn,
    score,
    hud,
    dispose() {
      renderer.destroy();
      background?.close();
      hud.look.close();
      // Built-in skins are shared between tracks; only file-skin bitmaps are ours.
      for (const bitmap of owned) bitmap.close();
    },
    warning,
  };
}
/** What a track's HUD draws with and the values it shows. */
export interface TrackHud {
  look: Hud;
  /** The skin's counters and health bar at scale 1, lazer UI units. */
  sizes: Record<"score" | "accuracy" | "combo" | "health", Size>;
  /** The counters' rolling values over verified judgements; null when they did not verify. */
  score: Rolling | null;
  accuracy: Rolling | null;
  /** Combo changes when the combo verified, else null. */
  combo: ComboChange[] | null;
  /** mania's combo counter sits over the stage: `ComboPosition` (stage units) from
   *  its top, or its bottom with upscroll, and `ColourBreak`. */
  mania: { comboPosition: number; scrollUp: boolean; breakColour: readonly [number, number, number] } | null;
  /** The health bar's values without its start (the composition's); null without a health graph. */
  health: Omit<HealthSource, "start"> | null;
}
async function trackHud(
  files: Skin | null,
  replay: Replay,
  simulation: Simulation | null,
  score: ScoreCurve | null,
  mania: ManiaConfig | null,
  scrollUp: boolean,
): Promise<TrackHud> {
  const look = await loadHud(files);
  // At least a unit across, so a skin without its fonts still leaves a box to select.
  const atLeastUnit = ({ width, height }: Size): Size => ({ width: Math.max(1, width), height: Math.max(1, height) });
  const text = (font: HudFont, sample: string, scale: number, fixed = true) => {
    const measured = hudText(font, sample, fixed);
    return atLeastUnit({ width: measured.width * scale, height: measured.height * scale });
  };
  const verified = simulation?.verified ? simulation : null;
  // The graph `replayHealth` reads: the recorded one, else lazer's from verified judgements.
  const graph = replay.life.length ? replay.life : (verified?.health ?? []);
  const breakColour = mania?.colours.get("ColourBreak");
  return {
    look,
    sizes: {
      score: text(look.score, "00000000", SCORE_SCALE),
      accuracy: text(look.score, "100.00%", ACCURACY_SCALE),
      combo: text(look.combo, "0000x", LEGACY_COMBO_SCALE, false),
      health: atLeastUnit(healthSize(look)),
    },
    // LegacyScoreCounter rolls over 1000 ms, the accuracy counter (PercentageCounter) over 375 ms.
    score: score ? rolling(score.times, score.scores, 0, 1000) : null,
    accuracy: verified
      ? rolling(verified.events.map((e) => e.time), verified.events.map((e) => e.accuracy), 1, 375)
      : null,
    combo: verified?.comboVerified ? comboChanges(verified.events) : null,
    mania: mania
      ? {
          comboPosition: mania.comboPosition,
          scrollUp,
          // LegacyManiaComboCounter: Color4.Red without ColourBreak.
          breakColour: breakColour ? [breakColour[0], breakColour[1], breakColour[2]] : [1, 0, 0],
        }
      : null,
    health: graph.length
      ? {
          value: (time) => replayHealth(replay, simulation, time) ?? 0,
          settled: graph.find((point) => point.health !== graph[0].health)?.time ?? Infinity,
          hits: (simulation?.events ?? [])
            .filter((e) => !(e.result === "miss" || e.kind?.includes("miss")))
            .map((e) => e.time),
        }
      : null,
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
/** A HUD layer's placement, from its render settings: margins from its cell
 *  corner (lazer UI units; accuracy's vertical one from the score) and scale. */
export function hudTransform(track: Pick<Track, "settings">, key: HudKey): Transform {
  const value = (axis: string) =>
    track.settings[`hud.${key}.${axis}`] ?? DEFAULTS[`hud.${key}.${axis}`];
  return { x: value("margin_x"), y: value("margin_y"), scale: value("scale") };
}
const RULES = new Map(settingSchema.map((rule) => [rule.key, rule]));
/** Whether a HUD layer is switched on for this track and drawn in its ruleset
 *  (lazer's catch HUD has no combo counter: the catcher carries it). */
export const hudShown = (track: Pick<Track, "settings" | "replay">, key: HudKey) =>
  !!RULES.get(`hud.${key}`)?.modes.includes(track.replay.mode) && (track.settings[`hud.${key}`] ?? 1) !== 0;
/** The HUD layers the layout editor places: shown ones with margins in this
 *  ruleset (mania's combo counter moves with the stage). */
export const hudLayers = (track: Pick<Track, "settings" | "replay">) =>
  HUD_KEYS.filter(
    (key) => hudShown(track, key) && !!RULES.get(`hud.${key}.margin_x`)?.modes.includes(track.replay.mode),
  );
const hudSize = (track: Pick<Track, "hud">, key: HudKey): Size => track.hud.sizes[key];
/** A track's HUD layer in `cell`, output pixels: the skin's counters and
 *  health bar at their size; accuracy hangs under the score. */
export function hudBoxOf(track: Pick<Track, "settings" | "hud">, cell: Rect, key: HudKey): Rect {
  const below = key === "accuracy" ? hudBoxOf(track, cell, "score") : undefined;
  return hudBox(cell, key, hudTransform(track, key), hudSize(track, key), below);
}
/** The transform that puts a track's HUD layer at `box` (the inverse of `hudBoxOf`). */
export function hudTransformAt(track: Pick<Track, "settings" | "hud">, cell: Rect, key: HudKey, box: Rect): Transform {
  const below = key === "accuracy" ? hudBoxOf(track, cell, "score") : undefined;
  return hudTransformFor(cell, key, box, hudSize(track, key), below);
}
/** LegacyDefaultComboCounter's own scale (set by the legacy HUD layouts). */
const LEGACY_COMBO_SCALE = 1.28;
/** The default combo font's line: its glyphs scale about 0.625 of their height plus 9 units. */
const comboOrigin = (height: number) => 0.625 * height + 9;
/**
 * Draws a track's enabled HUD layers as lazer draws them with the track's
 * skin (`TrackHud`), from the HUD's appearance at `start`: score, accuracy,
 * the health bar, and the ruleset's combo counter (osu! and taiko bottom
 * left, mania over the stage at ComboPosition). Combo, accuracy and score
 * appear only when the replay's judgements verified; health follows the
 * recorded life graph (osu!stable), else lazer's health simulated from those
 * verified judgements.
 */
function drawHud(context: CanvasRenderingContext2D, track: Track, cell: Rect, time: number, start: number) {
  const hud = track.hud,
    unit = uiUnit(cell);
  for (const key of HUD_KEYS) {
    if (!hudShown(track, key)) continue;
    if (key === "combo") {
      if (hud.combo) drawCombo(context, track, cell, time);
      continue;
    }
    const box = hudBoxOf(track, cell, key),
      scale = unit * hudTransform(track, key).scale;
    if (key === "health") {
      if (hud.health) drawHealth(context, hud.look, healthFrame({ ...hud.health, start }, time), box.x, box.y, scale);
      continue;
    }
    const curve = hud[key];
    if (!curve) continue;
    const value = rollingAt(curve, time),
      text = hudText(hud.look.score, key === "score" ? String(Math.round(value)).padStart(8, "0") : formatAccuracy(value)),
      size = scale * (key === "score" ? SCORE_SCALE : ACCURACY_SCALE);
    // Both counters hang from their top-right corner.
    drawHudText(context, text, box.x + box.width - text.width * size, box.y, size);
  }
}
/** The ruleset's legacy combo counter in the skin's combo font. */
function drawCombo(context: CanvasRenderingContext2D, track: Track, cell: Rect, time: number) {
  const hud = track.hud,
    font = hud.look.combo,
    changes = hud.combo!;
  if (hud.mania) {
    // Centred over the stage, ComboPosition in from its top (from its bottom with
    // upscroll, as lazer flips the counter's anchor); HUD units are 1/1.6 of the
    // stage's world units.
    const offset = hud.mania.comboPosition / 1.6;
    const frame = maniaComboFrame(changes, time),
      at = worldToOutput(
        cell,
        track.content,
        transformOf(track),
        256,
        hud.mania.scrollUp ? VIEW.y + VIEW.height - offset : VIEW.y + offset,
      ),
      scale = at.scale / 1.6;
    const shown = hudText(font, String(frame.count), false);
    drawHudText(context, shown, at.x, at.y, scale, {
      origin: [shown.width / 2, shown.height / 2],
      stretch: frame.stretch,
      alpha: frame.alpha,
    });
    if (frame.popOut) {
      const lost = hudText(font, String(frame.popOut.count), false);
      drawHudText(context, lost, at.x, at.y, scale, {
        origin: [lost.width / 2, lost.height / 2],
        stretch: [frame.popOut.scale, frame.popOut.scale],
        alpha: frame.popOut.alpha,
        additive: true,
        tint: hud.mania.breakColour,
      });
    }
    return;
  }
  const frame = legacyComboFrame(changes, time),
    box = hudBoxOf(track, cell, "combo"),
    scale = uiUnit(cell) * hudTransform(track, "combo").scale * LEGACY_COMBO_SCALE;
  // The counter's box is the shown text's, on the layer's bottom-left corner.
  const shown = hudText(font, `${frame.count}x`, false),
    top = box.y + box.height - shown.height * scale,
    line = top + comboOrigin(shown.height) * scale;
  drawHudText(context, shown, box.x, line, scale, {
    origin: [0, comboOrigin(shown.height)],
    stretch: frame.stretch,
    alpha: frame.alpha,
  });
  if (frame.popOut) {
    // Bottom-aligned with the shown text; it grows from 3 units left of its corner, as in stable.
    const popped = hudText(font, `${frame.popOut.count}x`, false);
    drawHudText(context, popped, box.x, top + (shown.height - 0.375 * popped.height + 9) * scale, scale, {
      origin: [3, comboOrigin(popped.height)],
      stretch: [frame.popOut.scale, frame.popOut.scale],
      alpha: frame.popOut.alpha,
      additive: true,
    });
  }
}
const LEGEND_INK = "#f6f3ee";
/** A 2D canvas of `width`×`height` (at least 1×1), kept in memory like the
 *  frame canvas: drawing a GPU-backed canvas into it would read the source
 *  back from the GPU on every frame. */
function canvas2d(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return { canvas, context: canvas.getContext("2d", { willReadFrequently: true })! };
}
/**
 * Overlap's legend: per player a colour swatch, name, accuracy, combo, score
 * and misses, the focus player marked. Values the simulation does not back
 * show as a dash. Text is drawn once into a cached image and redrawn only when
 * a value changes, so a frame costs one image draw (text on the frame canvas
 * is slow to rasterise every frame).
 */
class Legend {
  private cached: { key: string; canvas: HTMLCanvasElement } | null = null;
  /** Draws the legend at `at` (output px); returns its box. */
  draw(
    context: CanvasRenderingContext2D,
    tracks: readonly Track[],
    labels: readonly string[],
    time: number,
    at: { x: number; y: number },
    unit: number,
    focus: number,
  ): Rect {
    const size = Math.max(9, Math.round(22 * unit));
    const rows = tracks.map((track, i) => {
      const v = legendRow(track, time),
        dash = "–";
      return [
        `${labels[i]}${i === focus ? " ●" : ""}`,
        v.accuracy === null ? dash : `${(v.accuracy * 100).toFixed(2)}%`,
        v.combo === null ? dash : `${v.combo}x`,
        v.score === null ? dash : String(v.score).padStart(7, "0"),
        v.misses === null ? dash : `${v.misses} miss`,
      ];
    });
    const key = JSON.stringify([size, rows]);
    if (this.cached?.key !== key) this.cached = { key, canvas: Legend.render(rows, size) };
    const image = this.cached.canvas;
    context.drawImage(image, at.x, at.y);
    return { x: at.x, y: at.y, width: image.width, height: image.height };
  }
  private static render(rows: readonly string[][], size: number): HTMLCanvasElement {
    const row = Math.round(size * 1.45),
      pad = Math.round(size * 0.55),
      gap = Math.round(size * 1.1),
      swatch = Math.round(size * 0.8);
    const font = `700 ${size}px monospace`;
    const measure = canvas2d(1, 1).context;
    measure.font = font;
    const widths = rows[0].map((_, column) =>
      Math.max(...rows.map((cells) => measure.measureText(cells[column]).width)),
    );
    const { canvas, context } = canvas2d(
      pad * 2 + swatch + pad + widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1),
      pad * 2 + row * rows.length,
    );
    context.fillStyle = "rgba(0, 0, 0, 0.55)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.textBaseline = "middle";
    rows.forEach((cells, i) => {
      const y = pad + row * i + row / 2;
      context.fillStyle = overlapColour(i);
      context.fillRect(pad, y - swatch / 2, swatch, swatch);
      let x = pad + swatch + pad;
      cells.forEach((text, column) => {
        context.fillStyle = column === 0 ? overlapColour(i) : LEGEND_INK;
        // Numbers line up on the right of their column, names on the left.
        context.textAlign = column === 0 ? "left" : "right";
        context.fillText(text, column === 0 ? x : x + widths[column], y);
        x += widths[column] + gap;
      });
    });
    return canvas;
  }
}
/** A name tag in the player's colour with a dark outline, drawn once per size. */
function nameTag(label: string, colour: string, size: number): HTMLCanvasElement {
  const font = `700 ${size}px monospace`,
    stroke = Math.max(2, Math.round(size / 5));
  const measure = canvas2d(1, 1).context;
  measure.font = font;
  const { canvas, context } = canvas2d(measure.measureText(label).width + stroke * 2, size * 1.15 + stroke * 2);
  context.font = font;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = stroke;
  context.strokeStyle = "rgba(0, 0, 0, 0.85)";
  context.fillStyle = colour;
  context.strokeText(label, stroke, canvas.height / 2);
  context.fillText(label, stroke, canvas.height / 2);
  return canvas;
}
/** lazer: gameplay starts two seconds before the first object. */
const LEAD_IN_MS = 2000;
/** lazer's Player entry: hidden for 250 ms, then a 250 ms fade in. */
export const ENTRY_HOLD_MS = 250,
  ENTRY_FADE_MS = 250;
/** lazer: results 1000 ms after completion, the player fading out over 250 ms. */
export const DEFAULT_OUTRO_MS = 1250,
  DEFAULT_FADE_MS = 250;
/** A render target and the 2D canvas its pixels are composited from. */
interface Readback {
  target: RenderTarget;
  width: number;
  height: number;
  pixels: ImageData;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  query?: GPUQuerySet;
  queryResolve?: GPUBuffer;
  queryRead?: GPUBuffer;
}
function readback(renderer: Renderer, width: number, height: number, profile = false): Readback {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  // GPU pass timings need WebGPU's timestamp queries; WebGL2 reports none.
  const device = renderer.device;
  const query = profile && device?.features.has("timestamp-query")
    ? device.createQuerySet({ type: "timestamp", count: 2 }) : undefined;
  return {
    target: renderer.createTarget(width, height),
    query,
    queryResolve: query ? device!.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : undefined,
    queryRead: query ? device!.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : undefined,
    width,
    height,
    pixels: new ImageData(width, height),
    canvas,
    context: canvas.getContext("2d", { willReadFrequently: true })!,
  };
}
function releaseReadback(resource: Readback) {
  resource.target.destroy();
  resource.query?.destroy();
  resource.queryRead?.destroy();
  resource.queryResolve?.destroy();
}
/** The cursor's look-back trail (skins without a trail image) at `time`. */
function cursorTrail(track: Track, time: number) {
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
  return trail;
}
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Name tags tried below each other before one may cover another. */
const MAX_OVERLAP_TAGS = 8;
/** osu! gameplay draws the playfield this much lower (render-core's `playfieldShift`). */
const PLAYFIELD_SHIFT = 8;
/** The legend's values for one overlapping player at `time`; null when the
 *  simulation does not back them (the same rule as the HUD counters). */
export function legendRow(track: Track, time: number) {
  const state = track.simulation?.verified ? stateAt(track.replay, track.simulation, time) : null;
  return {
    name: track.replay.player,
    accuracy: state ? state.accuracy : null,
    combo: state?.combo ?? null,
    score: track.score && state ? scoreAt(track.score, time) : null,
    misses: state ? state.counts.miss : null,
  };
}
/** Legend and name tag labels: player names, numbered when two are the same. */
export function playerLabels(tracks: readonly Pick<Track, "replay">[]): string[] {
  const names = tracks.map((track) => track.replay.player || "Player");
  return names.map((name, i) => (names.filter((other) => other === name).length > 1 ? `${name} (${i + 1})` : name));
}
export class Composition {
  canvas = document.createElement("canvas");
  context: CanvasRenderingContext2D;
  private staging: HTMLCanvasElement;
  /** Wall-clock stage timings for the most recently completed offline frame. */
  timings = { scene: 0, readback: 0, composite: 0, gpu: null as number | null };
  private frameContext: CanvasRenderingContext2D;
  private readbacks: Readback[] = [];
  /** Overlap's legend and name tag images (see `Legend`, `nameTag`). */
  private legend = new Legend();
  private tags = new Map<string, HTMLCanvasElement>();
  /** Overlap's last drawn legend (and health bar) box, frame pixels. */
  legendBox: Rect | null = null;
  /** Overlap options (used while `layout` is `overlap`). */
  overlap: OverlapOptions = { ...DEFAULT_OVERLAP };
  /** Overlap's one playfield: the focus player's skin, every player's cursor. */
  private shared?: { key: string; look: Skin; renderer: Renderer; resource?: Readback };
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
  /** (Re)creates render targets sized for every playfield's current scale.
   *  Overlap's one target is made when its playfield is (see `sharedPlayfield`). */
  resize(width: number, height: number, layout: Layout) {
    this.width = width;
    this.height = height;
    this.layout = layout;
    this.canvas.width = width;
    this.canvas.height = height;
    this.staging.width = width;
    this.staging.height = height;
    this.releaseReadbacks();
    if (layout === "overlap") return;
    this.cells().forEach((cell, i) => {
      const track = this.tracks[i],
        renderer = track.renderer,
        { width: w, height: h } = place(cell, track.content, transformOf(track), undefined, track.drawn).target;
      renderer.resize(w, h);
      this.readbacks.push(readback(renderer, w, h, this.profile));
    });
  }
  /** The overlap's focus track. */
  get focus(): Track {
    return this.tracks[this.overlap.focus] ?? this.tracks[0];
  }
  /**
   * Overlap's playfield: drawn once from the focus player's map, skin and
   * hit lighting setting, with every player's judgements (as `overlap`
   * filters them) and cursor. Made on first use, re-made when the options or
   * tracks change, and sized for the focus playfield's placement.
   */
  private async sharedPlayfield(): Promise<{ renderer: Renderer; resource: Readback }> {
    const focus = this.focus;
    const key = JSON.stringify([
      this.tracks.map((track) => track.id),
      this.overlap.focus,
      this.overlap.judgements,
      focus.settings.hit_lighting,
    ]);
    if (this.shared && this.shared.look !== focus.look) this.releaseShared();
    if (!this.shared) {
      const { renderer } = await newPlayfield(focus.look);
      this.shared = { key: "", look: focus.look, renderer };
    }
    const shared = this.shared;
    if (shared.key !== key) {
      const replays = this.tracks.map((track) => track.replay);
      shared.renderer.setBeatmap(focus.source, {
        mods: overlapMods(replays, this.overlap.focus),
        hitLighting: focus.settings.hit_lighting !== 0,
        judgements: overlapJudgements(this.tracks.map((track) => track.events), this.overlap.judgements),
        cursorInputs: replays.map((replay) => replay.frames),
        playfieldShift: true,
      });
      shared.key = key;
    }
    const cell = this.cells()[0],
      { width: w, height: h } = place(cell, focus.content, transformOf(focus)).target;
    if (!shared.resource || shared.resource.width !== w || shared.resource.height !== h) {
      if (shared.resource) releaseReadback(shared.resource);
      shared.renderer.resize(w, h);
      shared.resource = readback(shared.renderer, w, h);
    }
    return { renderer: shared.renderer, resource: shared.resource };
  }
  private releaseShared() {
    if (!this.shared) return;
    if (this.shared.resource) releaseReadback(this.shared.resource);
    this.shared.renderer.destroy();
    this.shared = undefined;
  }
  /** Re-renders targets at the playfields' current scales (after an edit). */
  retarget() {
    this.resize(this.width, this.height, this.layout);
  }
  validate() {
    if (this.layout === "overlap") {
      const eligibility = overlapEligibility(this.tracks.map((track) => track.replay));
      if (!eligibility.ok) throw new Error(eligibility.reason);
    }
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
    if (this.layout === "overlap") await this.renderOverlap(context, time);
    else await this.renderCells(context, time);
    if (fade) {
      this.fade(time, context);
      if (this.inspect) this.drawInspector(time, this.overlayBoxes, context);
    }
    // Publish atomically: GPU readback must not blank the previous visible preview.
    if (this.staging !== this.canvas) this.context.drawImage(this.staging, 0, 0);
    return this.canvas;
  }
  /** Draws a track's background over `rect`, cropped to cover it, and its dim. */
  private drawBackground(context: CanvasRenderingContext2D, track: Track, rect: Rect) {
    const bg = track.background;
    if (!bg) return false;
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
    return true;
  }
  /**
   * Overlap: the focus player's background, one playfield with every
   * player's cursor and (filtered) judgements, then name tags, the legend and
   * optionally the focus player's health bar.
   */
  private async renderOverlap(context: CanvasRenderingContext2D, time: number) {
    const layers: InspectedLayer[] = [];
    let started = performance.now();
    const took = () => {
      const now = performance.now(),
        ms = now - started;
      started = now;
      return ms;
    };
    const cell = this.cells()[0],
      focus = this.focus;
    if (this.drawBackground(context, focus, cell))
      layers.push({ name: "Background", kind: "background", box: cell, ms: took() });
    const sceneStarted = performance.now();
    const { renderer, resource } = await this.sharedPlayfield();
    const labels = playerLabels(this.tracks);
    const cursors = this.tracks.map((track, i) => {
      const frame = frameAt(track.replay, time);
      return {
        x: frame.x,
        y: frame.y,
        pressed: !!frame.keys,
        scale: track.settings["cursor.size"] ?? 1,
        tint: overlapTint(i),
        trail: cursorTrail(track, time),
      };
    });
    renderer.renderAt(time, { target: resource.target, cursors });
    this.timings.scene += performance.now() - sceneStarted;
    const readbackStarted = performance.now();
    await resource.target.read(new Uint8Array(resource.pixels.data.buffer));
    this.timings.readback += performance.now() - readbackStarted;
    const compositeStarted = performance.now();
    resource.context.putImageData(resource.pixels, 0, 0);
    const transform = transformOf(focus);
    const { draw, box } = place(cell, focus.content, transform, resource);
    context.drawImage(resource.canvas, draw.x, draw.y, draw.width, draw.height);
    layers.push({ name: "Overlap playfield", kind: "playfield", box, ms: took() });
    this.timings.composite += performance.now() - compositeStarted;
    const unit = hudUnit(cell);
    if (this.overlap.names) {
      const size = Math.round(24 * unit),
        placed: Rect[] = [];
      cursors.forEach((cursor, i) => {
        const key = `${size}\n${overlapColour(i)}\n${labels[i]}`;
        let tag = this.tags.get(key);
        if (!tag) this.tags.set(key, (tag = nameTag(labels[i], overlapColour(i), size)));
        const at = worldToOutput(cell, focus.content, transform, cursor.x, cursor.y, PLAYFIELD_SHIFT);
        // Beside the cursor, clear of its image (about 20 world units across);
        // a tag that would cover an earlier one moves down below it. The box
        // keeps a gap of a third of a line around the tag.
        const gap = size / 3;
        const box = {
          x: at.x + 16 * at.scale * (cursor.scale ?? 1) - gap,
          y: at.y - 16 * at.scale * (cursor.scale ?? 1) - tag.height / 2,
          width: tag.width + 2 * gap,
          height: tag.height,
        };
        for (let tries = 0; tries < MAX_OVERLAP_TAGS && placed.some((other) => overlaps(box, other)); tries++)
          box.y = Math.max(...placed.filter((other) => overlaps(box, other)).map((other) => other.y + other.height));
        placed.push(box);
        context.drawImage(tag, box.x + gap, box.y);
      });
      layers.push({ name: "Name tags", kind: "hud", box: cell, ms: took() });
    }
    let top = Math.round(24 * unit);
    if (this.overlap.health) {
      // A plain bar in the player's colour (the legend's look, not the skin's),
      // inset like the legend and moved by the health layer's margins.
      const t = hudTransform(focus, "health"),
        ui = uiUnit(cell);
      const healthBox = {
        x: cell.x + 20 * unit + t.x * ui,
        y: cell.y + 20 * unit + t.y * ui,
        width: 480 * unit * t.scale,
        height: 14 * unit * t.scale,
      };
      const health = replayHealth(focus.replay, focus.simulation, time);
      if (health !== null) {
        context.save();
        context.fillStyle = "rgba(0, 0, 0, 0.45)";
        context.fillRect(healthBox.x, healthBox.y, healthBox.width, healthBox.height);
        context.fillStyle = overlapColour(this.overlap.focus);
        context.fillRect(healthBox.x, healthBox.y, healthBox.width * health, healthBox.height);
        context.restore();
      }
      top = Math.round(healthBox.y + healthBox.height + 16 * unit);
      layers.push({ name: `V${this.overlap.focus + 1} health`, kind: "hud", box: healthBox, ms: took() });
    }
    const legend = this.legend.draw(context, this.tracks, labels, time, { x: Math.round(24 * unit), y: top }, unit, this.overlap.focus);
    layers.push({ name: "Legend", kind: "hud", box: legend, ms: took() });
    // The legend and the health bar above it, for the editor's free spots.
    this.legendBox = { x: legend.x, y: Math.round(24 * unit), width: legend.width, height: legend.y + legend.height - Math.round(24 * unit) };
    this.inspected = layers;
  }
  /** Side by side, stacked, grid: every track's playfield in its own cell. */
  private async renderCells(context: CanvasRenderingContext2D, time: number) {
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
      if (this.drawBackground(context, track, rects[i]))
        layers.push({ name: `V${i + 1} background`, kind: "background", box: rects[i], ms: took() });
    });
    const mappings: Promise<unknown>[] = [];
    for (let i = 0; i < this.tracks.length; i++) {
      const sceneStarted = performance.now();
      const track = this.tracks[i],
        frame = frameAt(track.replay, time),
        resource = this.readbacks[i],
        rect = rects[i];
      const settings = track.settings;
      const trail = cursorTrail(track, time);
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
      drawHud(context, track, rects[i], time, this.start);
      const ms = took();
      for (const key of hudLayers(track))
        layers.push({ name: `V${i + 1} ${key}`, kind: "hud", box: hudBoxOf(track, rects[i], key), ms: key === "score" ? ms : null });
    });
    this.inspected = layers;
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
  private releaseReadbacks() {
    for (const resource of this.readbacks) releaseReadback(resource);
    this.readbacks = [];
    if (this.shared?.resource) releaseReadback(this.shared.resource);
    if (this.shared) this.shared.resource = undefined;
  }
  /** Frees every render target, and the overlap playfield. */
  releaseTargets() {
    this.releaseReadbacks();
    this.releaseShared();
  }
  destroy() {
    this.releaseTargets();
    for (const track of this.tracks) track.dispose();
  }
}
