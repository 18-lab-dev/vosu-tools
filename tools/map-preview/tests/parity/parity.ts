/**
 * Backend parity page: render-core's demo scenes drawn by one backend
 * (`?backend=webgpu|webgl2`), for tests/backend_parity.py to compare.
 *
 * `window.__render(spec)` draws a demo map at a time with a skin, with
 * judgements and replay-style input (osu! cursor and trail, mania keys), twice:
 * into an offscreen target cleared transparent (the composition path, read
 * back as raw RGBA) and on a visible canvas (bitmap presentation, as PNG).
 */
import { parseOsu, type Beatmap } from "@vosu-tools/osu-parse";
import { demo, type DemoId } from "@vosu-tools/demo-maps";
import {
  builtinLook,
  createPlayfield,
  loadPlayfieldSkin,
  maniaKeysFor,
  type Backend,
  type BuiltinSkinName,
  type InputFrame,
  type JudgementEvent,
  type Playfield,
  type Skin,
} from "@vosu-tools/render-core";

interface Spec {
  demo: DemoId;
  time: number;
  /** `builtin:<name>` or `files:<base url>`. */
  skin: string;
  width: number;
  height: number;
}
declare global {
  interface Window {
    __ready?:
      { backend: Backend; fallbackReason: string | null } | { error: string };
    __render?: (spec: Spec) => Promise<unknown>;
    __lose?: () => Promise<unknown>;
  }
}

const backend = new URLSearchParams(location.search).get("backend") as Backend;
const canvas = document.createElement("canvas");
document.body.append(canvas);

/** A hit for every object judged by `time`, as a replay's results would be. */
function judgements(map: Beatmap, time: number): JudgementEvent[] {
  const keys = Math.max(1, Math.round(map.difficulty.cs));
  return map.objects.flatMap((o, note): JudgementEvent[] => {
    if (o.time > time) return [];
    const object =
      map.mode === 0
        ? o.type & 2
          ? "slider"
          : o.type & 8
            ? "spinner"
            : "circle"
        : map.mode === 1
          ? "hit"
          : map.mode === 2
            ? "fruit"
            : "note";
    return [
      {
        time: o.endTime > o.time ? o.endTime : o.time,
        result: map.mode === 3 ? "perfect" : "great",
        note,
        object,
        x:
          map.mode === 3
            ? Math.min(keys - 1, Math.floor((o.x * keys) / 512))
            : o.x,
        y: o.y,
        combo: note + 1,
        catcher: map.mode === 2 ? o.x : undefined,
      },
    ];
  });
}

/** Replay-style input: an osu! cursor walking the objects, mania columns held. */
function input(map: Beatmap): InputFrame[] {
  const frames: InputFrame[] = [],
    keys = Math.max(1, Math.round(map.difficulty.cs)),
    objects = map.objects;
  for (let t = 0; t <= map.duration + 500; t += 16) {
    let x = 256,
      y = 192,
      pressed = 0;
    if (map.mode === 0) {
      const next = objects.findIndex((o) => o.time >= t),
        b = objects[next] ?? objects.at(-1)!,
        a = objects[Math.max(0, next - 1)] ?? b,
        f =
          b.time > a.time
            ? Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time)))
            : 1;
      x = a.x + (b.x - a.x) * f;
      y = a.y + (b.y - a.y) * f;
      if (
        objects.some(
          (o) => t >= o.time - 20 && t <= Math.max(o.time + 60, o.endTime),
        )
      )
        pressed = 1;
    } else if (map.mode === 3)
      for (const o of objects)
        if (t >= o.time && t <= Math.max(o.time + 60, o.endTime + 45))
          pressed |= 1 << Math.min(keys - 1, Math.floor((o.x * keys) / 512));
    frames.push({ time: t, x, y, keys: pressed });
  }
  return frames;
}

const files = new Map<string, Skin>();
async function skinFor(source: string, map: Beatmap): Promise<Skin> {
  if (source.startsWith("builtin:"))
    return builtinLook(source.slice(8) as BuiltinSkinName);
  const keys = maniaKeysFor(map),
    key = `${source}\n${keys.join(",")}`;
  let skin = files.get(key);
  if (!skin) {
    const base = source.slice(6);
    ({ skin } = await loadPlayfieldSkin(
      async (name) => {
        const response = await fetch(
          base + name.split("/").map(encodeURIComponent).join("/"),
        );
        return response.ok ? response.blob() : null;
      },
      source,
      { maniaKeys: keys },
    ));
    files.set(key, skin);
  }
  return skin;
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

let offscreen: Playfield, onscreen: Playfield;
async function start() {
  offscreen = await createPlayfield({ backend, transparent: true });
  onscreen = await createPlayfield({ backend, canvas, presentation: "bitmap" });
  if (offscreen.backend !== backend || onscreen.backend !== backend)
    throw new Error(`Asked for ${backend}, got ${offscreen.backend}`);
  window.__render = async (spec) => {
    const map = parseOsu(demo(spec.demo).osu),
      skin = await skinFor(spec.skin, map),
      options = {
        scrollSpeed: 20,
        judgements: judgements(map, spec.time),
        input: map.mode === 0 || map.mode === 3 ? input(map) : undefined,
      };
    const trail = [];
    for (let ago = 160; ago > 0; ago -= 16)
      trail.push({
        x: 256 + ago * 0.4,
        y: 192 - ago * 0.2,
        opacity: 1 - ago / 160,
      });
    const frame = {
      cursor: { x: 256, y: 192, pressed: true },
      cursorTrail: map.mode === 0 ? trail : undefined,
    };
    const target = offscreen.createTarget(spec.width, spec.height);
    offscreen.setSkin(skin);
    offscreen.resize(spec.width, spec.height);
    offscreen.setBeatmap(map, options);
    offscreen.renderAt(spec.time, { ...frame, target });
    const pixels = await target.read();
    target.destroy();
    onscreen.setSkin(skin);
    onscreen.resize(spec.width, spec.height);
    canvas.style.width = `${spec.width}px`;
    canvas.style.height = `${spec.height}px`;
    onscreen.setBeatmap(map, options);
    onscreen.renderAt(spec.time, frame);
    await onscreen.finished();
    return {
      offscreen: bytesToBase64(pixels),
      canvas: canvas.toDataURL("image/png"),
      textureMB: offscreen.textureBytes / 2 ** 20,
    };
  };
  // A playfield presenting directly on its own canvas loses its device or
  // context, as a GPU reset would, and must draw the same frame afterwards.
  window.__lose = async () => {
    let shown = document.createElement("canvas"),
      recovered: (reason: string) => void = () => {};
    const first = shown,
      reason = new Promise<string>((resolve) => (recovered = resolve));
    shown.style.width = "640px";
    shown.style.height = "360px";
    document.body.append(shown);
    const playfield = await createPlayfield({
      backend,
      canvas: shown,
      presentation: "direct",
      skin: builtinLook("legacy"),
      onRecover: (replaced, why) => {
        shown = replaced.canvas as HTMLCanvasElement;
        recovered(why);
      },
    });
    playfield.resize(640, 360);
    playfield.setBeatmap(parseOsu(demo("osu").osu));
    // Read in the same task as the draw, before the frame is presented.
    const draw = () => {
      playfield.renderAt(2260);
      return shown.toDataURL("image/png");
    };
    const before = draw();
    if (playfield.device) playfield.device.destroy();
    else
      shown
        .getContext("webgl2")!
        .getExtension("WEBGL_lose_context")!
        .loseContext();
    const why = await reason,
      after = draw();
    const result = {
      reason: why,
      backend: playfield.backend,
      canvasReplaced:
        shown !== first && shown.isConnected && !first.isConnected,
      before,
      after,
    };
    playfield.destroy();
    shown.remove();
    return result;
  };
  window.__ready = {
    backend: offscreen.backend,
    fallbackReason: offscreen.fallbackReason,
  };
}
start().catch((error) => (window.__ready = { error: String(error) }));
