// Headless end-to-end check of the practice UI against its real service.
//
//   bun tools/practice/web/test/render.mjs <playwright index.mjs> <evidence dir> <stable osu! .osu> <stable mania .osu>
//
// A stand-in host on 127.0.0.1:25250 (the practice test port) serves web/dist, a
// bridge with the protocol-v1 surface (fragment `theme=` → colorScheme,
// `session=1` → write session, subscribe over a real WebSocket), host context and
// settings, /files/beatmap/{audio,background}, and the tool API proxy, which like
// vosu refuses [api].write routes without a UI session. The practice service runs
// from target/debug with isolated HOME/XDG_* on temporary copies of both map
// folders; when target/debug/vosu-map-analysis exists it runs too and answers as
// `map-analysis`. The source Songs folders are never written.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { at, checkSubscription } from './subscription.ts';

const [playwrightModule, evidence, osuSource, maniaSource] = process.argv.slice(2);
if (!playwrightModule || !evidence || !osuSource || !maniaSource) {
  throw new Error('Usage: render.mjs <playwright index.mjs> <evidence dir> <osu! .osu> <mania .osu>');
}
const { chromium } = await import(playwrightModule);
const root = path.resolve(import.meta.dir, '../../../..');
const dist = path.join(root, 'tools/practice/web/dist');
const mapPreviewDist = path.join(root, 'tools/map-preview/web/dist');
const manifest = await readFile(path.join(root, 'tools/practice/tool.toml'), 'utf8');
const routes = Object.fromEntries(['read', 'write'].map((kind) => [kind, JSON.parse(manifest.match(new RegExp(`^${kind} = (\\[.*\\])$`, 'm'))[1])]));
const settingsSchema = JSON.parse(await readFile(path.join(root, 'tools/practice/settings.json'), 'utf8'));
// vosu's shared design system, served like /tools/_host/v1/theme.css (tokens +
// components) with its fonts under /assets/. VOSU_CHECKOUT points at a vosu
// checkout that has them (default: the sibling dev/1.2.0 worktree).
const vosuAssets = path.join(process.env.VOSU_CHECKOUT ?? path.resolve(root, '../../../vosu-wt/dev-1.2.0'), 'assets/server');
const themeCss = `${await readFile(path.join(vosuAssets, 'tokens.css'), 'utf8')}\n${await readFile(path.join(vosuAssets, 'system.css'), 'utf8')}`;
const TOKENS = { practice: 'practice-render-check', ratings: 'ratings-render-check' };
const SESSION = 'practice-render-session';
await mkdir(evidence, { recursive: true });

const temporary = await mkdtemp(path.join(tmpdir(), 'practice-r3-render-'));
const isolated = async (name) => {
  const env = { ...process.env };
  for (const variable of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    env[variable] = path.join(temporary, name, variable);
    await mkdir(env[variable], { recursive: true, mode: 0o700 });
  }
  return env;
};
const songs = path.join(temporary, 'Songs');
async function stage(source) {
  const text = await readFile(source, 'utf8');
  const field = (key) => text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1];
  const folder = path.join(songs, path.basename(path.dirname(source)));
  await mkdir(folder, { recursive: true });
  const chart = path.join(folder, path.basename(source));
  await cp(source, chart);
  const audio = field('AudioFilename');
  await cp(path.join(path.dirname(source), audio), path.join(folder, audio));
  const bg = text.match(/^0,0,"([^"]+)"/m)?.[1];
  if (bg && existsSync(path.join(path.dirname(source), bg))) await cp(path.join(path.dirname(source), bg), path.join(folder, bg));
  const original = await readFile(source);
  return {
    source, chart, original,
    context: {
      client: 'stable', songs_dir: songs, osu_dir: null, skin: null,
      beatmap: {
        checksum: new Bun.CryptoHasher('md5').update(original).digest('hex'),
        mode: { 0: 'osu', 1: 'taiko', 2: 'fruits', 3: 'mania' }[Number(field('Mode') ?? 0)],
        folder, file: chart, audio: path.join(folder, audio), background: bg ? path.join(folder, bg) : null,
      },
    },
  };
}
const maps = { osu: await stage(osuSource), mania: await stage(maniaSource) };
let context = maps.osu.context;
// Read-only copies of two of the user's stable skins, served like vosu's
// `/files/skin/` (report + files by case-insensitive name) for the client's
// current skin; the v2 stand-in reports the current one at /folders/skin.
const SKINS = (process.env.PRACTICE_SKINS ?? 'Arturia (sxlvia mania+taiko)|- Staircase!mania').split('|');
const skinRoot = path.join(process.env.HOME, '.local/share/osu-wine/osu!/Skins');
const skinFiles = {};
for (const name of SKINS) {
  const copy = path.join(temporary, 'Skins', name);
  await cp(path.join(skinRoot, name), copy, { recursive: true });
  const index = new Map();
  for (const rel of await readdir(copy, { recursive: true })) index.set(rel.replaceAll('\\', '/').toLowerCase(), path.join(copy, rel));
  skinFiles[name] = index;
}
let currentSkin = SKINS[0];

const services = {};
const sockets = new Set();
const bridge = `
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname + location.search);
const theme = fragment.get('theme');
// As the vosu bridge does: the launch hint (or the system preference) becomes data-theme.
const colorScheme = ['dark', 'light'].includes(theme) ? theme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
document.documentElement.dataset.theme = colorScheme;
const session = fragment.get('session') === '1' ? ${JSON.stringify(SESSION)} : null;
const base = new URL('/tools/practice/api/', location.origin);
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: { id: 'practice', name: 'osu! practice tool', version: '0.1.0' },
  dashboardUrl: 'http://127.0.0.1:25251/',
  colorScheme,
  get canWrite() { return Boolean(session); },
  async fetch(target, options = {}) {
    const url = new URL(target, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new TypeError('outside tool API');
    const headers = new Headers(options.headers);
    if (session) headers.set('X-Vosu-Tool-Session', session);
    return fetch(url, { ...options, headers, credentials: 'omit' });
  },
  subscribe(fields, onFrame, onStatus) {
    // One connection, no reconnects; statuses as the vosu 1.2.0 bridge reports them.
    onStatus?.('connecting');
    const socket = new WebSocket(new URL('/websocket/v2/subscribe', location.href.replace('http', 'ws')));
    socket.addEventListener('open', () => { socket.send(JSON.stringify(fields)); onStatus?.('open'); });
    socket.addEventListener('message', (event) => onFrame(JSON.parse(event.data)));
    socket.addEventListener('close', () => onStatus?.('closed'));
    return () => socket.close();
  },
});`;
// vosu's selected-field subscription (src/server/v2_subscription.rs): the
// request is validated exactly as vosu does, a rejected one gets vosu's error
// frame and close 1008, and frames carry values by pointer index.
let revision = 0;
// The client's mania settings as vosu reports stable's (src/api/v2/wire.rs);
// null leaves them out, as when vosu cannot read them. Map preview, opened on
// the same host for the scroll comparison, also follows the clock and modes.
let maniaSpeed = 20;
let liveTime = 0;
const RULESET = { osu: 0, taiko: 1, fruits: 2, mania: 3 };
const v2 = () => ({
  client: 'stable',
  state: { number: 5 },
  folders: { skin: currentSkin },
  beatmap: {
    checksum: context.beatmap.checksum,
    mode: { number: RULESET[context.beatmap.mode] },
    time: { live: liveTime, rate: 1, running: false },
  },
  settings: {
    mode: { number: RULESET[context.beatmap.mode] },
    ...(maniaSpeed === null ? {} : {
      mania: { speedBPMScale: false, usePerBeatmapSpeedScale: false, scrollSpeed: maniaSpeed, scrollDirection: { number: 1, name: 'down' } },
    }),
  },
  play: { mods: { array: [] }, source: null },
});
const values = (pointers) => pointers.map((tokens) => at(v2(), tokens));
function updates(ws) {
  const next = values(ws.data.pointers);
  const present = [], absent = [];
  next.forEach((value, i) => {
    if (JSON.stringify(value) === JSON.stringify(ws.data.last[i])) return;
    if (value === undefined) absent.push(i);
    else present.push([i, value]);
  });
  ws.data.last = next;
  if (present.length || absent.length) ws.send(JSON.stringify([1, ++revision, present, absent]));
}
function proxy(request, url, port, prefix, token) {
  const route = '/' + url.pathname.slice(prefix.length);
  return request.arrayBuffer().then((body) => fetch(`http://127.0.0.1:${port}${route}${url.search}`, {
    method: request.method, body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
    headers: { 'X-Vosu-Tool-Token': token, 'Content-Type': 'application/json', 'X-Vosu-Caller': 'ui:practice' },
  }));
}
const host = Bun.serve({
  hostname: '127.0.0.1',
  port: 25250,
  // map-analysis' local-MSD timeline takes a while in a debug build.
  idleTimeout: 255,
  websocket: {
    open(ws) { ws.data = { pointers: null, last: [] }; sockets.add(ws); },
    close(ws) { sockets.delete(ws); },
    message(ws, text) {
      if (ws.data.pointers) {
        ws.send(JSON.stringify([2, 5, 'subscription already established']));
        ws.close(1008);
        return;
      }
      const checked = checkSubscription(String(text));
      report.subscriptions.push({ request: String(text), accepted: 'pointers' in checked });
      if ('error' in checked) {
        ws.send(JSON.stringify(checked.error));
        ws.close(1008);
        return;
      }
      ws.data.pointers = checked.pointers;
      ws.data.last = values(checked.pointers);
      ws.send(JSON.stringify([0, ++revision, ws.data.last.flatMap((value, i) => (value === undefined ? [] : [[i, value]]))]));
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    const token = request.headers.get('X-Vosu-Tool-Token');
    if (url.pathname === '/websocket/v2/subscribe' && server.upgrade(request)) return;
    if (url.pathname === '/tools/_host/v1/context') {
      return Object.values(TOKENS).includes(token) ? Response.json(context) : new Response(null, { status: 401 });
    }
    if (url.pathname === '/tools/_host/v1/settings') {
      if (token === TOKENS.practice) return Response.json(Object.fromEntries(settingsSchema.map((s) => [s.uniqueID, s.value])));
      return token === TOKENS.ratings ? Response.json({}) : new Response(null, { status: 401 });
    }
    if (url.pathname === '/tools/_host/v1/bridge.js') return new Response(bridge, { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname === '/tools/_host/v1/theme.css') return new Response(themeCss, { headers: { 'content-type': 'text/css' } });
    if (url.pathname.startsWith('/assets/') && url.pathname.endsWith('.woff2')) {
      const font = Bun.file(path.join(vosuAssets, path.basename(url.pathname)));
      return (await font.exists()) ? new Response(font) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/files/skin/') return Response.json({ client: 'stable', name: currentSkin, files: true, builtin: null, base: null });
    if (url.pathname.startsWith('/files/skin/')) {
      const file = skinFiles[currentSkin].get(decodeURIComponent(url.pathname.slice('/files/skin/'.length)).toLowerCase());
      return file && (await Bun.file(file).exists()) ? new Response(Bun.file(file)) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/files/beatmap/file') return new Response(Bun.file(context.beatmap.file));
    if (url.pathname === '/files/beatmap/audio') return new Response(Bun.file(context.beatmap.audio));
    if (url.pathname === '/files/beatmap/background') {
      return context.beatmap.background ? new Response(Bun.file(context.beatmap.background)) : new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith('/tools/map-analysis/api/')) {
      if (token !== TOKENS.practice) return new Response(null, { status: 401 });
      if (!services.ratings) return Response.json({ error: 'tool not installed' }, { status: 404 });
      return proxy(request, url, services.ratings.port, '/tools/map-analysis/api/', TOKENS.ratings);
    }
    if (url.pathname.startsWith('/tools/practice/api/')) {
      const route = '/' + url.pathname.slice('/tools/practice/api/'.length);
      // Same classification as vosu: GET/HEAD on a read prefix is a read; else a write prefix needs the UI session.
      const matches = (prefixes) => prefixes.some((prefix) => route === prefix || route.startsWith(prefix + '/'));
      const read = ['GET', 'HEAD'].includes(request.method) && matches(routes.read);
      if (!read && !matches(routes.write)) return new Response(null, { status: 404 });
      if (!read && request.headers.get('X-Vosu-Tool-Session') !== SESSION) return Response.json({ error: 'write session required' }, { status: 403 });
      return proxy(request, url, services.practice.port, '/tools/practice/api/', TOKENS.practice);
    }
    // Map preview's built UI, for the scroll comparison (same skin, map and moment).
    if (url.pathname.startsWith('/tools/map-preview/')) {
      const relative = url.pathname.slice('/tools/map-preview/'.length) || 'index.html';
      const file = Bun.file(path.join(mapPreviewDist, path.normalize(relative)));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith('/tools/practice/')) {
      const relative = url.pathname.slice('/tools/practice/'.length) || 'index.html';
      const file = Bun.file(path.join(dist, path.normalize(relative)));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  },
});
function switchMap(name) {
  context = maps[name].context;
  for (const ws of sockets) if (ws.data.pointers) updates(ws);
}
function switchSkin(name) {
  currentSkin = name;
  for (const ws of sockets) if (ws.data.pointers) updates(ws);
}
/** A change in the client (the stand-in v2 document) reaches every subscriber. */
function pushGame() {
  for (const ws of sockets) if (ws.data.pointers) updates(ws);
}

async function start(id, binary) {
  const env = await isolated(id);
  Object.assign(env, {
    VOSU_TOOL_PROTOCOL: '1', VOSU_TOOL_ID: id, VOSU_TOOL_TOKEN: TOKENS[id], VOSU_URL: 'http://127.0.0.1:25250',
    VOSU_TOOL_DATA_DIR: path.join(temporary, id, 'data'), VOSU_TOOL_CACHE_DIR: path.join(temporary, id, 'cache'), VOSU_TOOL_INTERFACE: 'service',
  });
  const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise((resolve) => createInterface({ input: child.stdout }).once('line', resolve));
  if (!line.startsWith('vosu-tool-ready ')) throw new Error(`${id} not ready: ${line}`);
  services[id] = { child, port: Number(line.split(' ')[1]) };
}
await start('practice', path.join(root, 'target/debug/vosu-practice'));
if (existsSync(path.join(root, 'target/debug/vosu-map-analysis'))) await start('ratings', path.join(root, 'target/debug/vosu-map-analysis'));

const report = { maps: { osu: path.basename(osuSource), mania: path.basename(maniaSource) }, ratings: Boolean(services.ratings), subscriptions: [], checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
// Headless WebGPU as in Map preview's checks: Vulkan ANGLE without a surface,
// and the documented `?presentation=bitmap` capture mode, because screenshots
// cannot see a canvas's direct WebGPU swapchain.
const chrome = path.join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--autoplay-policy=no-user-gesture-required'],
});
const pageUrl = 'http://127.0.0.1:25250/tools/practice/?presentation=bitmap';
async function open(scheme, { session = true, width = 1920, height = 1080, preference } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: preference ?? (scheme === 'dark' ? 'light' : 'dark') });
  const page = await ctx.newPage();
  // Headless Chromium can answer the first requestAdapter() with null; the
  // second request succeeds. Harness-only retry.
  await page.addInitScript('{ const request = GPU.prototype.requestAdapter; GPU.prototype.requestAdapter = async function (o) { return (await request.call(this, o)) ?? request.call(this, o); }; }');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()));
  const fragment = [scheme && `theme=${scheme}`, session && 'session=1'].filter(Boolean).join('&');
  await page.goto(`${pageUrl}#${fragment}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('access')?.dataset.state !== 'pending');
  await page.waitForFunction(() => !['Waiting for osu!', 'No selected beatmap'].includes(document.getElementById('title')?.textContent ?? ''));
  await settled(page);
  return { ctx, page, errors };
}
/** Preview finished (canvas drawn or a message shown) and fonts loaded. */
async function settled(page) {
  await page.waitForFunction(() => !document.getElementById('play').disabled || !document.getElementById('preview-message').hidden, null, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
const texts = (page, selector) => page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));
const statLabels = (page) => texts(page, '#stats dt');

try {
  // ---- osu! map: only osu! transforms and stats; preview renders.
  let { ctx, page, errors } = await open('dark');
  check('osu!: ruleset transforms only', JSON.stringify(await texts(page, '#transforms button')) === '["Mirror","Random"]', await texts(page, '#transforms button'));
  check('osu!: difficulty fields HP/CS/AR/OD', JSON.stringify(await page.$$eval('#difficulty input[type=number]', (e) => e.map((i) => i.name))) === '["hp","cs","ar","od"]');
  check('osu!: stats show CS/AR, no keys', (await statLabels(page)).includes('AR') && !(await statLabels(page)).includes('Keys'), await statLabels(page));
  const webgpu = await page.evaluate(() => document.getElementById('preview-message').hidden);
  check('playfield preview rendered by render-core', webgpu, await page.textContent('#preview-message'));
  check('no gameplay-only explanation or copies list', !(await page.content()).includes('Gameplay-only') && !(await page.$('#generated')));
  check('button reads "Generate map"', (await page.textContent('#generate')).trim() === 'Generate map');
  // Regression (round 3): vosu rejects anything but JSON-pointer selectors, and
  // the page must then not claim vosu is unreachable while it is up.
  await page.waitForFunction(() => document.getElementById('live-dot').dataset.state === 'ok', null, { timeout: 10_000 }).catch(() => {});
  check('subscription accepted by vosu’s validation; page follows osu!', report.subscriptions.length > 0 && report.subscriptions.every((s) => s.accepted) && (await page.textContent('#live')) === 'Live' && (await page.getAttribute('#live-dot', 'data-state')) === 'ok', { subscriptions: report.subscriptions, live: await page.textContent('#live') });
  // Preview audio starts muted; the toggle is remembered.
  const muted = await page.evaluate(() => document.getElementById('mute').getAttribute('aria-pressed'));
  await page.click('#mute');
  const remembered = await page.evaluate(() => localStorage.getItem('vosu-tools:practice:muted'));
  await page.click('#mute');
  check('preview audio muted by default; toggle remembered', muted === 'true' && remembered === '0' && (await page.evaluate(() => localStorage.getItem('vosu-tools:practice:muted'))) === '1', { muted, remembered });
  await page.screenshot({ path: `${evidence}/osu-dark-1920.png` });

  // ---- Follow the game: switch to the mania map without reloading.
  switchMap('mania');
  await page.waitForFunction((t) => document.getElementById('title').textContent.includes(t), 'Sanzu', { timeout: 20_000 });
  await settled(page);
  check('follows the selected map live (WebSocket frame, no reload)', true, await page.textContent('#title'));
  check('mania: ruleset transforms only', JSON.stringify(await texts(page, '#transforms button')) === '["Invert","Hold Off","Mirror","Random","Constant Speed"]');
  check('mania: difficulty HP/OD only', JSON.stringify(await page.$$eval('#difficulty input[type=number]', (e) => e.map((i) => i.name))) === '["hp","od"]');
  const maniaStats = await statLabels(page);
  check('mania: keys shown, no CS/AR', maniaStats.includes('Keys') && !maniaStats.includes('CS') && !maniaStats.includes('AR'), maniaStats);
  // Space follows content: a compact controls column, the preview takes the rest,
  // and the mania stage stays at full height (canvas at least 4:3 of it, cropped).
  const fit = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const canvas = document.getElementById('canvas').getBoundingClientRect();
    const controls = document.querySelector('.controls').getBoundingClientRect();
    const work = document.getElementById('main').getBoundingClientRect();
    return { cropped: document.getElementById('main').classList.contains('crop-stage'), controlsWidth: Math.round(controls.width), stageWidth: Math.round(stage.width), stageHeight: Math.round(stage.height), canvasWidth: Math.round(canvas.width), mainWidth: Math.round(work.width) };
  });
  check('mania: compact controls column, wide preview, stage at full height', fit.cropped && fit.controlsWidth <= 21 * 16 && fit.stageWidth > fit.mainWidth / 2 && fit.canvasWidth >= fit.stageHeight * 4 / 3 - 1, fit);
  // The preview draws with the client's current skin and follows a skin change
  // reported by the game subscription, without a reload.
  const skinShown = (name) => page.waitForFunction((n) => {
    const el = document.getElementById('skin');
    return el.textContent === n && el.getAttribute('aria-busy') === 'false';
  }, name, { timeout: 30_000 }).then(() => true, () => false);
  const first = await skinShown(SKINS[0]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${evidence}/mania-skin-${SKINS[0].replace(/[^\w]+/g, '-')}-dark-1920.png` });
  switchSkin(SKINS[1]);
  const followed = await skinShown(SKINS[1]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${evidence}/mania-skin-${SKINS[1].replace(/[^\w]+/g, '-')}-dark-1920.png` });
  switchSkin(SKINS[0]);
  const back = await skinShown(SKINS[0]);
  check('preview uses the client skin and follows skin changes live', first && followed && back, { skin: await page.textContent('#skin'), title: await page.getAttribute('#skin', 'title') });
  const version = await page.textContent('#version');
  check('difficulty name: BPM integer or one decimal', /\(\d+(\.\d)?bpm\)/.test(version), version);

  // ---- Mania scroll speed: the client's own setting (stable's, as vosu
  // reports it) followed live, with an override and lazer's default as the
  // fallback. Practice's generated 1x map is drawn exactly as Map preview
  // draws the selected map at the same moment and speed: both pages open on
  // the map's first object (Practice's preview starts there; Map preview
  // follows the client's paused clock set to it).
  {
    const lines = maps.mania.original.toString('utf8').split(/\r?\n/);
    liveTime = Number(lines[lines.findIndex((l) => l.trim() === '[HitObjects]') + 1].split(',')[2]);
    maniaSpeed = 15;
    pushGame();
    const practice = await open('dark');
    const mpCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' });
    const mp = await mpCtx.newPage();
    await mp.addInitScript('{ const request = GPU.prototype.requestAdapter; GPU.prototype.requestAdapter = async function (o) { return (await request.call(this, o)) ?? request.call(this, o); }; }');
    mp.on('pageerror', (error) => practice.errors.push(`map preview: ${error.message}`));
    await mp.goto('http://127.0.0.1:25250/tools/map-preview/?presentation=bitmap#theme=dark', { waitUntil: 'networkidle' });
    const shown = (target, ids, want) => target.waitForFunction(([ids, want]) => {
      const skin = document.getElementById(ids.skin);
      return document.getElementById('scroll').placeholder === want.scroll && skin.textContent === want.skin
        && (document.getElementById(ids.busy).getAttribute('aria-busy') ?? 'false') === 'false';
    }, [ids, want], { timeout: 30_000 }).then(() => target.waitForTimeout(500)).then(() => true, () => false);
    const practiceShown = (scroll) => shown(practice.page, { skin: 'skin', busy: 'skin' }, { scroll, skin: SKINS[0] });
    const mapShown = (scroll) => shown(mp, { skin: 'skin-name', busy: 'skin-panel' }, { scroll, skin: SKINS[0] });
    const hint = () => practice.page.getAttribute('#scroll-help', 'data-tip');
    const shots = {};
    const shoot = async (name, target, selector) => {
      const png = await target.locator(selector).screenshot();
      await writeFile(`${evidence}/scroll-${name}.png`, png);
      shots[name] = png.toString('base64');
    };
    const live = [];
    for (const speed of [15, 30]) {
      maniaSpeed = speed;
      pushGame();
      live.push({ speed, practice: await practiceShown(String(speed)), mapPreview: await mapShown(String(speed)), hint: await hint() });
      await shoot(`practice-${speed}`, practice.page, '#canvas');
      await shoot(`map-preview-${speed}`, mp, '#playfield');
    }
    await practice.page.screenshot({ path: `${evidence}/scroll-practice-page-30-dark-1920.png` });
    const fieldShown = await practice.page.evaluate(() => !document.getElementById('scroll-field').hidden && !document.getElementById('scroll-help').hidden);
    check('mania scroll: Practice follows the client speed live (15 → 30), as Map preview does; the hint names the source',
      fieldShown && live.every((l) => l.practice && l.mapPreview && l.hint === `Your osu! scroll speed (${l.speed}).`), live);
    // Override: the field wins over the client (back at 15); clearing it follows the client again.
    maniaSpeed = 15;
    pushGame();
    await practice.page.fill('#scroll', '30');
    await practice.page.waitForTimeout(500);
    const overrideHint = await hint();
    await shoot('practice-override-30', practice.page, '#canvas');
    await practice.page.fill('#scroll', '');
    const cleared = await practiceShown('15');
    // Fallback: vosu reports no mania settings, then lazer's default (8) applies.
    maniaSpeed = null;
    pushGame();
    const fallback = await practiceShown('8');
    const fallbackHint = await hint();
    await shoot('practice-default-8', practice.page, '#canvas');
    check('mania scroll: override wins, blank follows the client, lazer default (8) without a reported speed',
      overrideHint === 'Set here; clear it to follow osu!.' && cleared && fallback && fallbackHint.includes("lazer's default (8)"),
      { overrideHint, cleared, fallback, fallbackHint });
    // Row profiles of the captures in playfield units (both canvases fit the
    // 480-unit world to their height): mean brightness per world row.
    const profiles = await practice.page.evaluate(async (images) => {
      const out = {};
      for (const [name, b64] of Object.entries(images)) {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const { data, width, height } = c.getImageData(0, 0, bitmap.width, bitmap.height);
        const sums = new Array(480).fill(0), counts = new Array(480).fill(0);
        for (let y = 0; y < height; y++) {
          let sum = 0;
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          }
          const row = Math.min(479, Math.floor((y / height) * 480));
          sums[row] += sum / width;
          counts[row]++;
        }
        out[name] = sums.map((s, i) => s / Math.max(1, counts[i]));
      }
      return out;
    }, shots);
    const pearson = (a, b) => {
      const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
      return Math.round((ab / Math.sqrt(aa * bb)) * 1000) / 1000;
    };
    // Notes above the receptors (world rows 8-330).
    const field = (name) => profiles[name].slice(8, 330);
    const same = {
      at15: pearson(field('practice-15'), field('map-preview-15')),
      at30: pearson(field('practice-30'), field('map-preview-30')),
      override30: pearson(field('practice-override-30'), field('map-preview-30')),
      across15vs30: pearson(field('practice-15'), field('practice-30')),
    };
    // Note spacing: the notes (coloured blobs; the receptor rings are grey)
    // in world units. At the first object's time that note sits on the hit
    // line (the lowest blob); every other note's distance from it is
    // speed × time ahead, so at 30 each column's n-th note from the bottom is
    // twice as far up as at 15.
    const notes = await practice.page.evaluate(async (images) => {
      const out = {};
      for (const [name, b64] of Object.entries(images)) {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const { data, width, height } = c.getImageData(0, 0, bitmap.width, bitmap.height);
        const mask = new Uint8Array(width * height);
        for (let i = 0; i < mask.length; i++) {
          const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
          mask[i] = Math.max(r, g, b) > 80 && Math.max(r, g, b) - Math.min(r, g, b) > 40 ? 1 : 0;
        }
        const blobs = [];
        const stack = [];
        for (let start = 0; start < mask.length; start++) {
          if (mask[start] !== 1) continue;
          let n = 0, sx = 0, sy = 0, top = height;
          mask[start] = 2;
          stack.push(start);
          while (stack.length) {
            const i = stack.pop(), x = i % width, y = (i - x) / width;
            n++; sx += x; sy += y; top = Math.min(top, y);
            for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1])
              if (j >= 0 && mask[j] === 1) { mask[j] = 2; stack.push(j); }
          }
          // Whole notes only: not cut by the top edge, not specks.
          if (top > 0 && n > (height / 480) ** 2 * 40)
            blobs.push({ x: Math.round(((sx / n - width / 2) / height) * 480), y: Math.round(((sy / n) / height) * 4800) / 10 });
        }
        out[name] = blobs;
      }
      return out;
    }, { 'practice-15': shots['practice-15'], 'practice-30': shots['practice-30'], 'map-preview-15': shots['map-preview-15'], 'map-preview-30': shots['map-preview-30'] });
    const columns = (blobs) => {
      const hit = Math.max(...blobs.map((b) => b.y));
      const byColumn = new Map();
      for (const b of blobs) {
        const key = Math.round(b.x / 8);
        byColumn.set(key, [...(byColumn.get(key) ?? []), hit - b.y].sort((p, q) => p - q));
      }
      return byColumn;
    };
    const ratios = [];
    const at15 = columns(notes['practice-15']), at30 = columns(notes['practice-30']);
    for (const [key, far] of at30)
      far.forEach((d, i) => { const near = at15.get(key)?.[i]; if (d > 0 && near > 0) ratios.push(Math.round((d / near) * 100) / 100); });
    ratios.sort((p, q) => p - q);
    const spacing = {
      notes: Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.length])),
      ratios,
      median: ratios[Math.floor(ratios.length / 2)],
    };
    report.scroll = { liveTime, same, spacing, notes };
    check('mania scroll: Practice matches Map preview at 15 and 30; at 30 notes sit twice as far from the hit line',
      same.at15 >= 0.95 && same.at30 >= 0.95 && same.override30 >= 0.95 && same.across15vs30 < same.at15 - 0.2
        && ratios.length >= 3 && ratios.every((r) => Math.abs(r - 2) <= 0.06),
      { same, spacing });
    maniaSpeed = 20;
    pushGame();
    await mpCtx.close();
    await practice.ctx.close();
  }
  await page.waitForFunction((rated) => {
    const label = document.getElementById('timeline-label').textContent;
    return rated ? label.includes('Map analysis') : label.startsWith('Notes per second');
  }, Boolean(services.ratings), { timeout: 240_000 }).catch(() => {});
  const timelineLabel = await page.textContent('#timeline-label');
  check(`timeline source: ${services.ratings ? 'map-analysis local MSD' : 'notes per second'}`, services.ratings ? timelineLabel.includes('Map analysis') : timelineLabel.includes('Notes per second'), { label: timelineLabel, note: await page.textContent('#timeline-note') });

  // Gestures: a plain drag scrubs (live clock updates, no section), Shift+drag
  // makes sections, the focused strip nudges with the arrow keys.
  const strip = await page.locator('#strip').boundingBox();
  const y = strip.y + strip.height / 2;
  const xAt = (f) => strip.x + strip.width * f;
  const drag = async (from, to, shift = false) => {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(xAt(from), y);
    await page.mouse.down();
    await page.mouse.move(xAt((from + to) / 2), y, { steps: 4 });
    await page.mouse.move(xAt(to), y, { steps: 4 });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  };
  const clockNow = () => page.textContent('#clock');
  await page.mouse.move(xAt(0.2), y);
  await page.mouse.down();
  await page.mouse.move(xAt(0.3), y, { steps: 3 });
  const scrubA = await clockNow();
  const cursorA = await page.evaluate(() => getComputedStyle(document.getElementById('strip')).cursor);
  await page.mouse.move(xAt(0.4), y, { steps: 3 });
  const scrubB = await clockNow();
  const during = await page.evaluate(() => document.getElementById('strip').dataset.gesture);
  await page.mouse.up();
  const scrubSections = await page.evaluate(() => document.querySelectorAll('#trim-list li').length);
  check('plain drag scrubs the playhead live and makes no section', during === 'scrub' && cursorA === 'col-resize' && scrubA !== scrubB && scrubSections === 0, { scrubA, scrubB, during, cursorA, scrubSections });
  await page.keyboard.down('Shift');
  await page.mouse.move(xAt(0.5), y + 1);
  const shiftCursor = await page.evaluate(() => getComputedStyle(document.getElementById('strip')).cursor);
  await page.keyboard.up('Shift');
  await page.focus('#strip');
  const beforeKey = await page.getAttribute('#strip', 'aria-valuenow');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const afterKey = await page.getAttribute('#strip', 'aria-valuenow');
  check('Shift shows the trim cursor; Right nudges the focused playhead by 1 s', shiftCursor === 'crosshair' && Number(afterKey) - Number(beforeKey) === 2000, { shiftCursor, beforeKey, afterKey });
  const objectsBefore = await page.evaluate(() => document.querySelector('#stats div:nth-child(2) dd').textContent);
  await drag(0.30, 0.38, true);
  await drag(0.62, 0.70, true);
  await page.fill('input[name=rate]', '1.2');
  await page.dispatchEvent('input[name=rate]', 'input');
  await page.waitForFunction(() => document.querySelectorAll('#trim-list li').length === 2);
  await page.waitForFunction(() => document.querySelectorAll('#strip .window').length === 2, null, { timeout: 30_000 });
  await settled(page);
  const objectsAfter = await page.evaluate(() => document.querySelector('#stats div:nth-child(2) dd').textContent);
  check('two trim sections from the strip; result stats update', objectsAfter.includes('→'), { before: objectsBefore, after: objectsAfter, ranges: await texts(page, '#trim-list li') });
  // Seek into the second section and play briefly.
  await page.mouse.click(strip.x + strip.width * 0.66, strip.y + strip.height / 2);
  const seeked = await page.textContent('#clock');
  await page.click('#play');
  await page.waitForTimeout(1200);
  await page.click('#play');
  const played = await page.textContent('#clock');
  check('timeline click seeks; playback advances the output clock', seeked !== played && !seeked.startsWith('0:00.0 '), { seeked, played });
  await page.mouse.click(strip.x + strip.width * 0.66, strip.y + strip.height / 2);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${evidence}/mania-trims-dark-1920.png` });
  await page.hover('.trim-label .v-help');
  await page.waitForTimeout(200);
  const tip = await page.evaluate(() => {
    const help = document.querySelector('.trim-label .v-help');
    const box = help.getBoundingClientRect();
    const panel = help.closest('.v-scroll').getBoundingClientRect();
    const width = parseFloat(getComputedStyle(help, '::after').width);
    // data-tip-pos="right": the tip starts at the icon's left edge.
    return { text: help.dataset.tip, tipLeft: Math.round(box.left), tipRight: Math.round(box.left + width), panelLeft: Math.round(panel.left), panelRight: Math.round(panel.right), shown: getComputedStyle(help, '::after').visibility };
  });
  check('trim help hover shows inside the controls panel', tip.shown === 'visible' && tip.tipLeft >= tip.panelLeft && tip.tipRight <= tip.panelRight, tip);
  report.trimHelp = tip;
  await page.screenshot({ path: `${evidence}/trim-help-dark-1920.png`, clip: { x: 0, y: 0, width: 760, height: 620 } });
  await page.focus('#strip');

  // Profiles: save as, then generate.
  await page.click('#profile-save-as');
  await page.fill('#profile-name', 'Grind 1.2x');
  await page.click('#profile-new button[type=submit]');
  await page.waitForFunction(() => document.getElementById('profile').value === 'Grind 1.2x');
  check('profile saved and active', true);
  await page.click('#generate');
  await page.waitForFunction(() => /Map ready|failed|error/i.test(document.getElementById('status').textContent), null, { timeout: 900_000 });
  const status = await page.textContent('#status');
  const done = status.includes('Map ready');
  check('generate map (write session, trims + rate)', done, status);
  check('no page errors so far', errors.length === 0, errors);
  await page.screenshot({ path: `${evidence}/mania-generated-dark-1920.png` });
  await ctx.close();
  if (done) {
    const folder = maps.mania.context.beatmap.folder;
    const name = (await readdir(folder)).find((f) => f.startsWith('vosu-practice-') && f.endsWith('.osu'));
    const text = await readFile(path.join(folder, name), 'utf8');
    const objects = text.split(/\r?\n/).slice(text.split(/\r?\n/).indexOf('[HitObjects]') + 1).filter(Boolean);
    const breaks = text.match(/^2,\d+,\d+$/m);
    const version = text.match(/^Version:(.*)$/m)[1];
    check('generated .osu: trimmed, rated, gap break', objects.length > 0 && breaks && /1\.2x/.test(version) && / trim /.test(version), { objects: objects.length, version, break: breaks?.[0] });
    const audioName = text.match(/^AudioFilename:(.*)$/m)[1].trim();
    check('generated audio exists beside it', existsSync(path.join(folder, audioName)), audioName);
    report.generated = { osu: name, audio: audioName, version, objects: objects.length };
    const unchanged = Buffer.compare(maps.mania.original, await readFile(maps.mania.source)) === 0 && Buffer.compare(maps.mania.original, await readFile(maps.mania.chart)) === 0;
    check('source map unchanged', unchanged);
  }

  // ---- Reload: the last used profile loads on page open.
  ({ ctx, page, errors } = await open('light'));
  check('last used profile loads on open', (await page.inputValue('#profile')) === 'Grind 1.2x' && (await page.inputValue('input[name=rate]')) === '1.20', { profile: await page.inputValue('#profile'), rate: await page.inputValue('input[name=rate]') });
  const audit = await page.evaluate(() => {
    const css = (el) => { const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor, colorScheme: s.colorScheme }; };
    const select = document.getElementById('profile');
    return { root: getComputedStyle(document.documentElement).colorScheme, select: css(select), option: css(select.options[0]), number: css(document.querySelector('input[name=rate]')) };
  });
  check('light: native controls carry the scheme and opaque colours', audit.root === 'light' && [audit.select, audit.option, audit.number].every((x) => x.colorScheme === 'light' && x.color !== x.background && !x.background.endsWith(', 0)')), audit);
  await page.locator('#profile').evaluate((select) => { select.size = 2; });
  await page.locator('#profile').screenshot({ path: `${evidence}/light-profile-select-options.png` });
  await page.locator('#profile').evaluate((select) => { select.size = 0; });
  await ctx.close();

  // ---- Screenshots and the app-shell rule: both schemes at 1920×1080, 2560×1440,
  // 1280×720 and half-width 960×1080 the page never scrolls and nothing sticks out
  // sideways (canvases cropped by their own panel don't count); 390 may stack.
  for (const [scheme, width, height] of [['dark', 1920, 1080], ['light', 1920, 1080], ['dark', 2560, 1440], ['light', 2560, 1440], ['dark', 1280, 720], ['light', 1280, 720], ['dark', 960, 1080], ['light', 960, 1080], ['dark', 390, 844], ['light', 390, 844]]) {
    ({ ctx, page, errors } = await open(scheme, { width, height }));
    const layout = await page.evaluate(() => {
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== 'visible') return true;
        }
        return false;
      };
      const outside = [...document.body.querySelectorAll('*')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && !clipped(el); })
        .map((el) => el.id || el.className || el.tagName);
      return {
        scrollHeight: document.scrollingElement.scrollHeight,
        innerHeight,
        outside,
        theme: document.documentElement.dataset.theme,
        font: getComputedStyle(document.body).fontFamily,
      };
    });
    const fits = width < 960 || layout.scrollHeight <= layout.innerHeight;
    check(`${scheme} ${width}×${height}: theme, shared font, nothing outside the viewport${width >= 960 ? ', page does not scroll' : ''}`, layout.theme === scheme && layout.font.includes('Barlow') && layout.outside.length === 0 && fits, layout);
    check(`${scheme} ${width}: no page errors`, errors.length === 0, errors);
    await page.screenshot({ path: `${evidence}/mania-${scheme}-${width}x${height}.png`, fullPage: width < 960 });
    await ctx.close();
  }

  // ---- Read-only page: preview still works, writes are disabled.
  ({ ctx, page, errors } = await open('dark', { session: false }));
  const readOnly = await page.evaluate(() => ({
    access: document.getElementById('access').textContent,
    disabled: ['generate', 'profile-save', 'profile-save-as', 'profile-delete'].map((id) => document.getElementById(id).disabled),
    preview: !document.getElementById('play').disabled || !document.getElementById('preview-message').hidden,
  }));
  check('read-only: generate and profile writes disabled, preview available', readOnly.disabled.every(Boolean) && readOnly.preview, readOnly);
  await page.screenshot({ path: `${evidence}/mania-dark-1920-readonly.png` });
  await ctx.close();

} finally {
  await writeFile(`${evidence}/render.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  for (const { child } of Object.values(services)) {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  host.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
if (report.checks.some((c) => !c.ok)) process.exit(1);
