/**
 * The renderer on a chosen backend (index.ts createRenderer picks it): scenes,
 * per-frame uniforms and overlay instances, the same for every backend.
 */
import { applyMods, scrollPosition, type Beatmap } from "@vosu-tools/osu-parse";
import { legacyBool } from "./osu";
import {
  buildAtlas,
  regionInstances,
  type AtlasRegion,
  type Skin,
} from "./skin";
import { CursorModel, PLAYFIELD_SHIFT, pressIntervals } from "./gameplay";
import { compileScene, type RenderOptions, type Scene } from "./scene";
import { CURSOR_OVERLAYS, MAX_OVERLAYS, recoloured, type Gpu } from "./gpu";
import type { FrameState, Renderer, RendererOptions } from "./index";

const PLAIN_CURSOR = [1, 0.8, 0.2] as const,
  WHITE = [1, 1, 1] as const;

export function rendererOn(
  gpu: Gpu,
  fallbackReason: string | null,
  options: RendererOptions,
  width: number,
  height: number,
): Renderer {
  let skin = options.skin,
    regions = new Map<string, AtlasRegion>(),
    scene: Scene | undefined,
    map: Beatmap | undefined,
    original: Beatmap | undefined,
    settings: RenderOptions = {},
    aspect = width / height;
  let keyIntervals: { start: number; end: number }[][] = [];
  let holdIntervals: { start: number; end: number }[][] = [];
  /** Key images (LegacyKeyArea) stay pressed 80 ms after a release. */
  let keyImageIntervals: { start: number; end: number }[][] = [];
  function activeMask(
    columns: readonly (readonly { start: number; end: number }[])[],
    time: number,
  ): number {
    let result = 0;
    for (let lane = 0; lane < columns.length; lane++) {
      const intervals = columns[lane];
      let lo = 0,
        hi = intervals.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (intervals[mid].start <= time) lo = mid + 1;
        else hi = mid;
      }
      if (lo && intervals[lo - 1].end >= time) result |= 1 << lane;
    }
    return result;
  }
  /** The catcher's hyper-dash tint: 180 ms fades in and out (lazer's OutQuint, approximated linearly). */
  function hyperAmount(
    intervals: readonly { start: number; end: number }[],
    time: number,
  ): number {
    let lo = 0,
      hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (intervals[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    const last = intervals[lo - 1];
    if (!last) return 0;
    // Catcher.runHyperDashStateTransition: FadeColour over 180 ms, out quint.
    const ease = (t: number) =>
      1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 5);
    return time <= last.end
      ? ease((time - last.start) / 180)
      : ease((last.end - last.start) / 180) *
          (1 - ease((time - last.end) / 180));
  }
  /** The catcher's state from the last result at or before `time` (idle before any). */
  function stateAt(
    states: readonly { time: number; state: number }[],
    time: number,
  ): number {
    let lo = 0,
      hi = states.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (states[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return states[lo - 1]?.state ?? 0;
  }
  const uniforms = new Float32Array(24),
    overlays = new Float32Array(24 * MAX_OVERLAYS),
    visible: { first: number; count: number }[] = [];
  function installSkin(next?: Skin): void {
    gpu.setAtlas((sink) => {
      const atlas = buildAtlas(sink, next);
      regions = atlas.regions;
      return atlas.frames;
    });
  }
  installSkin(skin);
  /** The plain cursor (and look-back trail) dot; the default tint is the
   *  replay cursor's yellow. */
  function writeCursor(
    index: number,
    x: number,
    y: number,
    size: number,
    alpha: number,
    time: number,
    tint: readonly number[] = PLAIN_CURSOR,
  ): void {
    const b = index * 24;
    overlays.fill(0, b, b + 24);
    overlays[b] = x;
    overlays[b + 1] = y;
    overlays[b + 2] = size;
    overlays[b + 3] = size;
    overlays[b + 4] = time;
    overlays[b + 5] = time;
    overlays[b + 6] = -1e9;
    overlays[b + 7] = 1e9;
    overlays[b + 8] = tint[0];
    overlays[b + 9] = tint[1];
    overlays[b + 10] = tint[2];
    overlays[b + 11] = alpha;
  }
  /** A textured per-frame sprite (kind 35, Profile.sprite); returns the next index. */
  function writeSprite(
    index: number,
    asset: string,
    x: number,
    y: number,
    w: number,
    h: number,
    angle: number,
    alpha: number,
    additive: boolean,
    time: number,
    tint: readonly number[] = WHITE,
  ): number {
    const region = regions.get(asset);
    if (!region) return index;
    for (const { entry, uv } of regionInstances(region, true)) {
      if (index >= MAX_OVERLAYS) break;
      overlays.set(
        [
          x,
          y,
          w,
          h,
          time,
          time,
          -1e9,
          1e9,
          tint[0],
          tint[1],
          tint[2],
          alpha,
          35,
          27,
          angle,
          0,
          uv.u,
          uv.v,
          uv.w,
          uv.h,
          additive ? 13 : 10,
          entry,
          0,
          0,
        ],
        index++ * 24,
      );
    }
    return index;
  }
  /** osu!: the replay's cursor with the skin's images (setBeatmap's `input`),
   *  or one per overlapping player (`cursorInputs`). */
  let cursorModel: CursorModel | undefined;
  let cursorModels: CursorModel[] = [];
  /**
   * One osu! cursor: the caller's look-back trail when the skin has no trail
   * image, then the skin's cursor sprites (or the plain dot). Returns the
   * next overlay index; at most `limit` instances are written.
   */
  function drawCursor(
    count: number,
    model: CursorModel | undefined,
    cursor: NonNullable<FrameState["cursor"]>,
    trail: FrameState["cursorTrail"],
    time: number,
    limit: number,
    tint?: readonly number[],
  ): number {
    const end = Math.min(MAX_OVERLAYS, count + limit),
      // The skin's images in the player's colour; the plain dot takes it as is.
      spriteTint = tint && recoloured(tint);
    const skinned = model?.sprites(time, Math.max(0, cursor.scale ?? 1), end - count - 1);
    // Skins without a cursor trail keep the caller's look-back trail.
    if (trail && !(skinned && regions.has("cursortrail")))
      for (let i = 0; i < trail.length && count < end - 1; i++) {
        const sample = trail[i];
        if (sample.opacity > 0)
          writeCursor(
            count++,
            sample.x,
            sample.y,
            15 * Math.max(0, sample.scale ?? 1),
            Math.min(1, sample.opacity),
            time,
            tint,
          );
      }
    if (skinned) {
      for (const sprite of skinned) {
        if (count >= end) break;
        count = writeSprite(
          count,
          sprite.asset,
          sprite.x,
          sprite.y,
          sprite.w,
          sprite.h,
          sprite.angle,
          sprite.alpha,
          sprite.additive,
          time,
          spriteTint,
        );
      }
    } else if (count < end)
      writeCursor(
        count++,
        cursor.x,
        cursor.y,
        (cursor.pressed ? 20 : 15) * Math.max(0, cursor.scale ?? 1),
        1,
        time,
        tint,
      );
    return count;
  }
  let disposed = false;
  const renderer: Renderer = {
    backend: gpu.backend,
    fallbackReason,
    device: gpu.device,
    format: gpu.format,
    lost: gpu.lost,
    get textureBytes() {
      return gpu.textureBytes;
    },
    createTarget: (w, h) =>
      gpu.createTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))),
    finished: () => gpu.finished(),
    setBeatmap(source, opts = {}) {
      if (disposed) throw new Error("Renderer was destroyed");
      original = source;
      settings = opts;
      map = applyMods(source, opts.mods ?? [], { ar: opts.ar, cs: opts.cs });
      aspect = width / height;
      scene = compileScene(map, opts, regions, skin, aspect);
      keyIntervals =
        map.mode === 3
          ? Array.from({ length: Math.round(map.difficulty.cs) }, () => [])
          : [];
      holdIntervals = keyIntervals.map(() => []);
      if (map.mode === 3 && opts.input)
        keyIntervals = pressIntervals(opts.input, keyIntervals.length);
      else if (map.mode === 3)
        for (const object of map.objects) {
          const lane = Math.min(
              keyIntervals.length - 1,
              Math.floor((object.x * keyIntervals.length) / 512),
            ),
            intervals = keyIntervals[lane],
            last = intervals[intervals.length - 1];
          if (last && last.end >= object.time)
            last.end = Math.max(last.end, object.endTime + 45);
          else intervals.push({ start: object.time, end: object.endTime + 45 });
          if (object.endTime > object.time) {
            const holds = holdIntervals[lane],
              previous = holds[holds.length - 1];
            if (previous && previous.end >= object.time)
              previous.end = Math.max(previous.end, object.endTime);
            else holds.push({ start: object.time, end: object.endTime });
          }
        }
      if (map.mode === 3 && opts.input)
        for (const object of map.objects) {
          if (object.endTime <= object.time) continue;
          const lane = Math.min(
              holdIntervals.length - 1,
              Math.floor((object.x * holdIntervals.length) / 512),
            ),
            holds = holdIntervals[lane],
            previous = holds[holds.length - 1];
          if (previous && previous.end >= object.time)
            previous.end = Math.max(previous.end, object.endTime);
          else holds.push({ start: object.time, end: object.endTime });
        }
      const general = skin?.sections.get("General")?.[0] ?? {},
        flag = (key: string) => legacyBool(general[key]) ?? true;
      const cursorSkin = {
        size: (asset: string): [number, number] | undefined => {
          const r = regions.get(asset);
          return r ? [r.width ?? 0, r.height ?? 0] : undefined;
        },
        centre: flag("CursorCentre"),
        rotate: flag("CursorRotate"),
        expand: flag("CursorExpand"),
        trailRotate: flag("CursorTrailRotate"),
      };
      const skinnedCursor = map.mode === 0 && regions.has("cursor");
      cursorModel =
        skinnedCursor && opts.input ? new CursorModel(opts.input, cursorSkin) : undefined;
      cursorModels = skinnedCursor
        ? (opts.cursorInputs ?? []).map((input) => new CursorModel(input, cursorSkin))
        : [];
      keyImageIntervals = opts.input
        ? keyIntervals.map((column) =>
            column.map(({ start, end }) => ({ start, end: end + 80 })),
          )
        : keyIntervals;
      gpu.setInstances(scene.data);
    },
    setSkin(next) {
      skin = next;
      installSkin(next);
      if (original) renderer.setBeatmap(original, settings);
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      // osu!taiko's playfield follows the window's aspect ratio, as in lazer.
      if (
        original &&
        map?.mode === 1 &&
        Math.abs(width / height - aspect) > 1e-6
      )
        renderer.setBeatmap(original, settings);
      gpu.resize(width, height);
    },
    renderAt(time, frame) {
      if (disposed) throw new Error("Renderer was destroyed");
      if (!scene || !map) throw new Error("Set a beatmap before rendering");
      if (!Number.isFinite(time)) throw new Error("Frame time must be finite");
      let direction = 1,
        cursorX = frame?.cursor?.x ?? 256,
        cursorY = frame?.cursor?.y ?? 192;
      if (!frame?.cursor && scene.catcher.length) {
        const a = scene.catcher;
        let lo = 0,
          hi = a.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (a[mid].time < time) lo = mid + 1;
          else hi = mid;
        }
        const p = a[Math.max(0, lo - 1)],
          q = a[Math.min(a.length - 1, lo)],
          f =
            q.time === p.time
              ? 1
              : Math.max(0, Math.min(1, (time - p.time) / (q.time - p.time)));
        cursorX = p.x + (q.x - p.x) * f;
        // The catcher faces the way it last moved (lazer's VisualDirection).
        for (let i = Math.min(a.length - 1, lo); i > 0; i--)
          if (a[i].x !== a[i - 1].x && a[i - 1].time < time) {
            direction = a[i].x > a[i - 1].x ? 1 : -1;
            break;
          }
        cursorY = (p.y ?? 350) + ((q.y ?? 350) - (p.y ?? 350)) * f;
      }
      // A replay's input (setBeatmap) wins over per-frame keys.
      const fromInput = !!settings.input;
      let mask = frame?.keys && !fromInput ? 0 : activeMask(keyIntervals, time);
      if (frame?.keys && !fromInput)
        for (let lane = 0; lane < Math.min(31, frame.keys.length); lane++)
          if (frame.keys[lane]) mask |= 1 << lane;
      uniforms[13] = activeMask(holdIntervals, time) & mask;
      uniforms[20] =
        map.mode === 0 && settings.playfieldShift ? PLAYFIELD_SHIFT : 0;
      uniforms[21] = fromInput ? activeMask(keyImageIntervals, time) : mask;
      // Slider bodies' snaking (shader.ts, kind SLIDER_BODY): 1 in, 2 out.
      uniforms[22] =
        (settings.snakingIn === false ? 0 : 1) +
        (settings.snakingOut === false ? 0 : 2);
      uniforms[14] = hyperAmount(scene.hyper, time);
      uniforms[0] = time;
      uniforms[1] = width;
      uniforms[2] = height;
      uniforms[3] = map.mode;
      uniforms[4] = scene.speed;
      uniforms[5] = scrollPosition(map.timing, time, "mania", scene.scrollBase);
      uniforms[6] = scene.preempt;
      uniforms[7] = scene.clipX;
      uniforms[8] = cursorX;
      uniforms[9] = cursorY;
      uniforms[10] = map.visualMods.includes("FL") ? 1 : 0;
      uniforms[11] = direction;
      uniforms[12] = mask;
      uniforms[16] = map.visualMods.includes("HD") ? 1 : 0;
      uniforms[17] = map.visualMods.includes("FI") ? 1 : 0;
      uniforms[18] =
        Number(map.visualMods.includes("UD")) ^
        Number(settings.maniaScrollUp === true);
      let timingIndex = 0;
      while (
        timingIndex + 1 < map.timing.length &&
        map.timing[timingIndex + 1].time <= time
      )
        timingIndex++;
      uniforms[19] = frame?.failed
        ? 2
        : scene.catcherStates
          ? stateAt(scene.catcherStates, time)
          : (map.timing[timingIndex]?.effects ?? 0) & 1
            ? 1
            : 0;
      if (!frame?.target && !options.canvas)
        throw new Error("Offscreen rendering requires frame.target");
      visible.length = 0;
      for (let i = 0; i < scene.chunks.length; i++) {
        const chunk = scene.chunks[i];
        if (time >= chunk.from && time <= chunk.until) visible.push(chunk);
      }
      let count = 0;
      if (map.mode === 0 && frame?.cursors)
        // Overlap: every player's cursor over one playfield, each in its tint.
        frame.cursors.forEach((cursor, i) => {
          count = drawCursor(count, cursorModels[i], cursor, cursor.trail, time, CURSOR_OVERLAYS, cursor.tint);
        });
      else if (map.mode === 0 && (cursorModel || frame?.cursor))
        count = drawCursor(
          count,
          cursorModel,
          { x: cursorX, y: cursorY, pressed: frame?.cursor?.pressed, scale: frame?.cursor?.scale },
          frame?.cursorTrail,
          time,
          CURSOR_OVERLAYS,
        );
      gpu.draw({
        uniforms,
        chunks: visible,
        overlays,
        overlayCount: count,
        target: frame?.target,
        timestampWrites: frame?.timestampWrites,
      });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      gpu.destroy();
    },
  };
  renderer.resize(width, height);
  return renderer;
}
