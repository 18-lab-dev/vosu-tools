#!/usr/bin/env bun
// Skin studio's previews draw mania at the osu! client's scroll speed, followed
// live, and match Map preview at the same speed, moment and skin.
//
//   bun tools/skin-studio/web/e2e/scroll.e2e.ts --playwright <playwright/index.mjs> \
//     --skins <Skins folder> --skin "Arturia (sxlvia mania+taiko)" --out <evidence dir>
//
// Build first: `cargo build -p vosu-skin-studio`, then `bun run build` in
// tools/skin-studio/web and tools/map-preview/web. Set VOSU_CHECKOUT to a vosu
// checkout for its theme (default: the sibling vosu-wt/dev-1.2.0).
//
// A stand-in vosu on 127.0.0.1:25260 serves both built UIs with a bridge,
// host context and settings, the skin-studio service (from target/debug, with
// a temporary HOME and every XDG folder) behind the tool API, `/files/skin/`
// for the current skin, `/files/beatmap/file`, and `/websocket/v2/subscribe`
// validated as vosu validates it. The client is stable with a copy of one of
// the user's skins; the selected beatmap is Skin studio's own 4K demo (three
// periods), paused at the start of its loop window. Skin studio's clock is
// frozen there too, so both pages draw the same moment. The skin is copied;
// the original is only read.
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { demo, repeatOsu } from "@vosu-tools/demo-maps";
import { at, checkSubscription } from "../../../practice/web/test/subscription.ts";

const { values: opt } = parseArgs({
  options: {
    playwright: { type: "string" },
    skins: { type: "string" },
    skin: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["playwright", "skins", "skin", "out"] as const)
  if (!opt[name]) throw new Error(`--${name} is required`);
const evidence = path.resolve(opt.out!);
await mkdir(evidence, { recursive: true });
// Playwright is not a workspace dependency: its path is given at run time.
const { chromium } = await import(opt.playwright!);
const ROOT = path.resolve(import.meta.dir, "../../../..");
const PORT = 25260;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dists: Record<string, string> = {
  "skin-studio": path.join(ROOT, "tools/skin-studio/web/dist"),
  "map-preview": path.join(ROOT, "tools/map-preview/web/dist"),
};
const vosuAssets = path.join(process.env.VOSU_CHECKOUT ?? path.resolve(ROOT, "../../vosu-wt/dev-1.2.0"), "assets/server");
const themeCss = `${await readFile(path.join(vosuAssets, "tokens.css"), "utf8")}\n${await readFile(path.join(vosuAssets, "system.css"), "utf8")}`;
const TOKEN = "skin-studio-scroll-check";
const skinSettings = Object.fromEntries(
  (JSON.parse(await readFile(path.join(ROOT, "tools/skin-studio/settings.json"), "utf8")) as { uniqueID: string; value: unknown }[])
    .map((s) => [s.uniqueID, s.value]),
);
// No lazer-library here: list stable skins only.
skinSettings.lazer_skins = false;

// ── An osu! folder with a copy of the skin, and the demo map as the selection ──
const LAB = await mkdtemp(path.join(tmpdir(), "skin-scroll-e2e-"));
const osuDir = path.join(LAB, "osu");
const skinDir = path.join(osuDir, "Skins", opt.skin!);
await cp(path.join(opt.skins!, opt.skin!), skinDir, { recursive: true });
// A copy of a read-only original keeps its modes: make it removable.
spawnSync("chmod", ["-R", "u+w", skinDir]);
const skinIndex = new Map<string, string>();
for (const rel of new Bun.Glob("**/*").scanSync({ cwd: skinDir }))
  skinIndex.set(rel.replaceAll("\\", "/").toLowerCase(), path.join(skinDir, rel));
const KEYS = 4;
const mania = demo(`mania-${KEYS}k`);
const chart = repeatOsu(mania.osu, mania.period, 3);
const songFolder = path.join(osuDir, "Songs", "demo");
await mkdir(songFolder, { recursive: true });
const chartFile = path.join(songFolder, "demo.osu");
await writeFile(chartFile, chart);
const checksum = new Bun.CryptoHasher("md5").update(chart).digest("hex");
// demoLoop's window starts one period in.
const loopStart = mania.period;
const context = {
  client: "stable",
  songs_dir: path.join(osuDir, "Songs"),
  osu_dir: osuDir,
  skin: { name: opt.skin, folder: skinDir, files: true, builtin: null },
  beatmap: { checksum, mode: "mania", folder: songFolder, file: chartFile, audio: null, background: null },
};

// ── The client's state: vosu's v2 document for the stand-in subscription ──
let maniaSpeed: number | null = 15;
const v2 = () => ({
  client: "stable",
  state: { number: 5 },
  folders: { skin: opt.skin },
  beatmap: { checksum, mode: { number: 3, name: "mania" }, time: { live: loopStart, rate: 1, running: false } },
  settings: {
    mode: { number: 3 },
    ...(maniaSpeed === null
      ? {}
      : { mania: { speedBPMScale: false, usePerBeatmapSpeedScale: false, scrollSpeed: maniaSpeed, scrollDirection: { number: 1, name: "down" } } }),
  },
  play: { mods: { array: [] }, source: null },
});
type Socket = { send(data: string): void; close(code?: number): void; data: { pointers: string[][] | null; last: unknown[] } };
const sockets = new Set<Socket>();
let revision = 0;
const values = (pointers: string[][]) => pointers.map((tokens) => at(v2(), tokens));
function push() {
  for (const ws of sockets) {
    if (!ws.data.pointers) continue;
    const next = values(ws.data.pointers);
    const present: [number, unknown][] = [], absent: number[] = [];
    next.forEach((value, i) => {
      if (JSON.stringify(value) === JSON.stringify(ws.data.last[i])) return;
      if (value === undefined) absent.push(i);
      else present.push([i, value]);
    });
    ws.data.last = next;
    if (present.length || absent.length) ws.send(JSON.stringify([1, ++revision, present, absent]));
  }
}
const subscriptions: { request: string; accepted: boolean }[] = [];

const bridge = (id: string) => `
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname + location.search);
const theme = fragment.get('theme');
const colorScheme = ['dark', 'light'].includes(theme) ? theme : 'dark';
document.documentElement.dataset.theme = colorScheme;
const base = new URL('/tools/${id}/api/', location.origin);
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: { id: '${id}', name: '${id}', version: '0' },
  dashboardUrl: 'http://127.0.0.1:${PORT + 1}/',
  colorScheme,
  canWrite: false,
  fetch(target, options = {}) {
    const url = new URL(target, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new TypeError('outside tool API');
    return fetch(url, { ...options, credentials: 'omit' });
  },
  subscribe(fields, onFrame, onStatus) {
    onStatus?.('connecting');
    const socket = new WebSocket(new URL('/websocket/v2/subscribe', location.href.replace('http', 'ws')));
    socket.addEventListener('open', () => { socket.send(JSON.stringify(fields)); onStatus?.('open'); });
    socket.addEventListener('message', (event) => onFrame(JSON.parse(event.data)));
    socket.addEventListener('close', () => onStatus?.('closed'));
    return () => socket.close();
  },
});`;

// ── The skin-studio service, isolated ──
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["HOME", "home"], ["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = path.join(LAB, dir);
  await mkdir(env[key], { recursive: true, mode: 0o700 });
}
Object.assign(env, {
  VOSU_TOOL_PROTOCOL: "1", VOSU_TOOL_ID: "skin-studio", VOSU_TOOL_TOKEN: TOKEN, VOSU_URL: ORIGIN,
  VOSU_TOOL_DATA_DIR: path.join(LAB, "tool-data"), VOSU_TOOL_CACHE_DIR: path.join(LAB, "tool-cache"), VOSU_TOOL_INTERFACE: "service",
});
const binary = path.join(ROOT, "target/debug/vosu-skin-studio");
if (!existsSync(binary)) throw new Error(`build first: ${binary}`);

const host = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  websocket: {
    open(ws: Socket) { ws.data = { pointers: null, last: [] }; sockets.add(ws); },
    close(ws: Socket) { sockets.delete(ws); },
    message(ws: Socket, text: string | Buffer) {
      if (ws.data.pointers) { ws.send(JSON.stringify([2, 5, "subscription already established"])); ws.close(1008); return; }
      const checked = checkSubscription(String(text));
      subscriptions.push({ request: String(text), accepted: "pointers" in checked });
      if ("error" in checked) { ws.send(JSON.stringify(checked.error)); ws.close(1008); return; }
      ws.data.pointers = checked.pointers;
      ws.data.last = values(checked.pointers);
      ws.send(JSON.stringify([0, ++revision, ws.data.last.flatMap((value, i) => (value === undefined ? [] : [[i, value]]))]));
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    const token = request.headers.get("X-Vosu-Tool-Token");
    if (url.pathname === "/websocket/v2/subscribe" && server.upgrade(request)) return;
    if (url.pathname === "/tools/_host/v1/context") return token === TOKEN ? Response.json(context) : new Response(null, { status: 401 });
    if (url.pathname === "/tools/_host/v1/settings") return token === TOKEN ? Response.json(skinSettings) : new Response(null, { status: 401 });
    if (url.pathname === "/tools/_host/v1/theme.css") return new Response(themeCss, { headers: { "content-type": "text/css" } });
    if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".woff2")) {
      const font = Bun.file(path.join(vosuAssets, path.basename(url.pathname)));
      return (await font.exists()) ? new Response(font) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/files/skin/") return Response.json({ client: "stable", name: opt.skin, files: true, builtin: null, base: null });
    if (url.pathname.startsWith("/files/skin/")) {
      const file = skinIndex.get(decodeURIComponent(url.pathname.slice("/files/skin/".length)).toLowerCase());
      return file ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/files/beatmap/file") return new Response(chart);
    const tool = url.pathname.match(/^\/tools\/([^/]+)\/(.*)$/);
    if (tool && dists[tool[1]]) {
      const [, id, rest] = tool;
      if (rest.startsWith("api/")) {
        if (id !== "skin-studio" || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 403 });
        return fetch(`http://127.0.0.1:${service.port}/${rest.slice(4)}${url.search}`, { headers: { "X-Vosu-Tool-Token": TOKEN, "X-Vosu-Caller": `ui:${id}` } });
      }
      const file = Bun.file(path.join(dists[id], path.normalize(rest || "index.html")));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/tools/_host/v1/bridge.js") {
      const id = new URL(request.headers.get("referer") ?? ORIGIN).pathname.split("/")[2] ?? "";
      return new Response(bridge(id), { headers: { "content-type": "text/javascript" } });
    }
    return new Response(null, { status: 404 });
  },
});
const child = spawn(binary, [], { env, stdio: ["pipe", "pipe", "inherit"] });
const ready: string = await new Promise((resolve) => createInterface({ input: child.stdout! }).once("line", resolve));
if (!ready.startsWith("vosu-tool-ready ")) throw new Error(`skin-studio not ready: ${ready}`);
const service = { port: Number(ready.split(" ")[1]) };

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: unknown, detail?: unknown) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface"],
});
const errors: string[] = [];
async function open(id: string, init?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  // Headless Chromium can answer the first requestAdapter() with null.
  await page.addInitScript("{ const request = GPU.prototype.requestAdapter; GPU.prototype.requestAdapter = async function (o) { return (await request.call(this, o)) ?? request.call(this, o); }; }");
  if (init) await page.addInitScript(init);
  page.on("pageerror", (error: Error) => errors.push(`${id}: ${error.message}`));
  await page.goto(`${ORIGIN}/tools/${id}/?presentation=bitmap#theme=dark`, { waitUntil: "networkidle" });
  return { ctx, page };
}

try {
  // Skin studio: the Preview tab on mania 4K with the client's skin selected,
  // its clock frozen so the looping demo stays at the start of its window.
  const studio = await open(
    "skin-studio",
    `{ const t = performance.now(); performance.now = () => t;
       localStorage.setItem('skin-studio:preview', JSON.stringify({ source: 'focus', ruleset: 'mania', keys: ${KEYS}, playing: true })); }`,
  );
  await studio.page.waitForFunction(() => !document.getElementById("guide") || document.getElementById("guide")!.hidden, null, { timeout: 30_000 }).catch(() => {});
  await studio.page.click("#tab-preview");
  const mapPreview = await open("map-preview");
  const studioShown = (want: string) =>
    studio.page.waitForFunction((w: string) => {
      const field = document.getElementById("pv-scroll") as HTMLInputElement;
      const state = document.getElementById("pv-state")!.textContent ?? "";
      return field.placeholder === w && !/Loading/.test(state) && state !== "";
    }, want, { timeout: 30_000 }).then(() => studio.page.waitForTimeout(800)).then(() => true, () => false);
  const mapShown = (want: string) =>
    mapPreview.page.waitForFunction(([w, skin]: string[]) =>
      (document.getElementById("scroll") as HTMLInputElement).placeholder === w
      && document.getElementById("skin-name")!.textContent === skin
      && document.getElementById("skin-panel")!.getAttribute("aria-busy") !== "true",
    [want, opt.skin!], { timeout: 30_000 }).then(() => mapPreview.page.waitForTimeout(800)).then(() => true, () => false);
  const hint = () => studio.page.getAttribute("#pv-scroll-help", "data-tip");
  const shots: Record<string, string> = {};
  const shoot = async (name: string, page: { locator(selector: string): { screenshot(): Promise<Buffer> } }, selector: string) => {
    const png: Buffer = await page.locator(selector).screenshot();
    await writeFile(`${evidence}/scroll-${name}.png`, png);
    shots[name] = png.toString("base64");
  };

  const live = [];
  for (const speed of [15, 30]) {
    maniaSpeed = speed;
    push();
    live.push({ speed, studio: await studioShown(String(speed)), mapPreview: await mapShown(String(speed)), hint: await hint() });
    await shoot(`skin-studio-${speed}`, studio.page, "#pv-canvas");
    await shoot(`map-preview-${speed}`, mapPreview.page, "#playfield");
  }
  await studio.page.screenshot({ path: `${evidence}/skin-studio-preview-30-dark-1920.png` });
  const fieldShown = await studio.page.evaluate(() => !document.getElementById("pv-scroll-field")!.hidden && !document.getElementById("pv-scroll-help")!.hidden);
  check("subscription accepted by vosu's validation", subscriptions.length >= 2 && subscriptions.every((s) => s.accepted), subscriptions);
  check("Skin studio follows the client's speed live (15 → 30), as Map preview does; the hint names the source",
    fieldShown && live.every((l) => l.studio && l.mapPreview && l.hint === `Your osu! scroll speed (${l.speed}).`), live);

  // Override (client back at 15), blank follows the client, and the fallback.
  maniaSpeed = 15;
  push();
  await studio.page.fill("#pv-scroll", "30");
  await studio.page.waitForTimeout(800);
  const overrideHint = await hint();
  await shoot("skin-studio-override-30", studio.page, "#pv-canvas");
  await studio.page.fill("#pv-scroll", "");
  const cleared = await studioShown("15");
  maniaSpeed = null;
  push();
  const fallback = await studioShown("8");
  const fallbackHint = await hint();
  await shoot("skin-studio-default-8", studio.page, "#pv-canvas");
  check("override wins, blank follows the client, lazer's default (8) without a reported speed",
    overrideHint === "Set here; clear it to follow osu!." && cleared && fallback && (fallbackHint ?? "").includes("lazer's default (8)"),
    { overrideHint, cleared, fallback, fallbackHint });

  // Measure the captures in playfield units: render-core fits the 640×480
  // world into each canvas, centred.
  const measured = await studio.page.evaluate(async (images: Record<string, string>) => {
    const out: Record<string, { rows: number[]; notes: { x: number; y: number }[] }> = {};
    for (const [name, b64] of Object.entries(images)) {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      c.drawImage(bitmap, 0, 0);
      const { data, width, height } = c.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = Math.min(width / 640, height / 480), top = (height - 480 * scale) / 2;
      const worldY = (y: number) => (y - top) / scale;
      // Mean brightness per world row.
      const sums = new Array(480).fill(0), counts = new Array(480).fill(0);
      for (let y = 0; y < height; y++) {
        const row = Math.floor(worldY(y));
        if (row < 0 || row >= 480) continue;
        let sum = 0;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
        sums[row] += sum / width;
        counts[row]++;
      }
      // Notes: round coloured blobs, whole ones only (the skin's grey
      // receptors and Map preview's progress line are left out).
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        mask[i] = Math.max(r, g, b) > 80 && Math.max(r, g, b) - Math.min(r, g, b) > 40 ? 1 : 0;
      }
      const notes: { x: number; y: number }[] = [];
      const stack: number[] = [];
      for (let start = 0; start < mask.length; start++) {
        if (mask[start] !== 1) continue;
        let n = 0, sx = 0, sy = 0, first = height, last = 0, left = width, right = 0;
        mask[start] = 2;
        stack.push(start);
        while (stack.length) {
          const i = stack.pop()!, x = i % width, y = (i - x) / width;
          n++; sx += x; sy += y; first = Math.min(first, y); last = Math.max(last, y); left = Math.min(left, x); right = Math.max(right, x);
          for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1])
            if (j >= 0 && mask[j] === 1) { mask[j] = 2; stack.push(j); }
        }
        const aspect = (right - left + 1) / (last - first + 1);
        if (first > 0 && n > scale * scale * 40 && aspect > 0.6 && aspect < 1.6)
          notes.push({ x: Math.round((sx / n - width / 2) / scale), y: Math.round(worldY(sy / n) * 10) / 10 });
      }
      out[name] = { rows: sums.map((s, i) => s / Math.max(1, counts[i])), notes };
    }
    return out;
  }, shots);
  const pearson = (a: number[], b: number[]) => {
    const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
    return Math.round((ab / Math.sqrt(aa * bb)) * 1000) / 1000;
  };
  const field = (name: string) => measured[name].rows.slice(8, 330);
  const same = {
    at15: pearson(field("skin-studio-15"), field("map-preview-15")),
    at30: pearson(field("skin-studio-30"), field("map-preview-30")),
    override30: pearson(field("skin-studio-override-30"), field("map-preview-30")),
    across15vs30: pearson(field("skin-studio-15"), field("skin-studio-30")),
  };
  // Note positions: Skin studio's notes where Map preview's are, and at 30
  // each column's n-th note from the hit line twice as far up as at 15.
  const columns = (notes: { x: number; y: number }[]) => {
    const hit = Math.max(...notes.map((n) => n.y));
    const byColumn = new Map<number, number[]>();
    for (const n of notes) byColumn.set(Math.round(n.x / 8), [...(byColumn.get(Math.round(n.x / 8)) ?? []), hit - n.y].sort((p, q) => p - q));
    return byColumn;
  };
  const offsets: number[] = [];
  for (const speed of [15, 30]) {
    const a = columns(measured[`skin-studio-${speed}`].notes), b = columns(measured[`map-preview-${speed}`].notes);
    for (const [key, ds] of a) ds.forEach((d, i) => { const e = b.get(key)?.[i]; if (e !== undefined) offsets.push(Math.round(Math.abs(d - e) * 10) / 10); });
  }
  // Distance ratios of the same notes between two speeds.
  const ratiosOf = (slow: string, fast: string) => {
    const out: number[] = [];
    const near = columns(measured[slow].notes), far = columns(measured[fast].notes);
    for (const [key, ds] of far)
      ds.forEach((d, i) => { const n = near.get(key)?.[i]; if (d > 0 && n !== undefined && n > 0) out.push(Math.round((d / n) * 1000) / 1000); });
    return out;
  };
  const ratios = { "15→30": ratiosOf("skin-studio-15", "skin-studio-30"), "8→15": ratiosOf("skin-studio-default-8", "skin-studio-15") };
  const near = (rs: number[], want: number) => rs.length >= 1 && rs.every((r) => Math.abs(r - want) <= 0.06);
  const notes = Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.notes.length]));
  check("Skin studio matches Map preview at 15 and 30 (same moment and skin); note distances from the hit line scale with the speed",
    same.at15 >= 0.95 && same.at30 >= 0.95 && same.override30 >= 0.95 && same.across15vs30 < same.at15 - 0.2
      && offsets.length >= 4 && offsets.every((o) => o <= 1.5) && near(ratios["15→30"], 2) && near(ratios["8→15"], 15 / 8),
    { same, notes, maxOffset: Math.max(...offsets), ratios });
  check("no page errors", errors.length === 0, errors);
  await writeFile(`${evidence}/scroll.json`, JSON.stringify({ subscriptions, checks, same, measured: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.notes])) }, null, 2) + "\n");
} finally {
  await browser.close();
  child.stdin!.end();
  await new Promise((resolve) => child.once("exit", resolve));
  host.stop(true);
  await rm(LAB, { recursive: true, force: true });
}
if (checks.some((c) => !c.ok)) process.exit(1);
