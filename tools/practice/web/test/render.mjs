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
// folders; when target/debug/vosu-mania-ratings exists it runs too and answers as
// `mania-ratings`. The source Songs folders are never written.
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
const manifest = await readFile(path.join(root, 'tools/practice/tool.toml'), 'utf8');
const routes = Object.fromEntries(['read', 'write'].map((kind) => [kind, JSON.parse(manifest.match(new RegExp(`^${kind} = (\\[.*\\])$`, 'm'))[1])]));
const settingsSchema = JSON.parse(await readFile(path.join(root, 'tools/practice/settings.json'), 'utf8'));
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

const services = {};
const sockets = new Set();
const bridge = `
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname + location.search);
const theme = fragment.get('theme');
const session = fragment.get('session') === '1' ? ${JSON.stringify(SESSION)} : null;
const base = new URL('/tools/practice/api/', location.origin);
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: { id: 'practice', name: 'osu! practice tool', version: '0.1.0' },
  dashboardUrl: 'http://127.0.0.1:25251/',
  ...(['dark', 'light'].includes(theme) ? { colorScheme: theme } : {}),
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
const v2 = () => ({ beatmap: { checksum: context.beatmap.checksum } });
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
  // mania-ratings' local-MSD timeline takes a while in a debug build.
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
    if (url.pathname === '/files/beatmap/audio') return new Response(Bun.file(context.beatmap.audio));
    if (url.pathname === '/files/beatmap/background') {
      return context.beatmap.background ? new Response(Bun.file(context.beatmap.background)) : new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith('/tools/mania-ratings/api/')) {
      if (token !== TOKENS.practice) return new Response(null, { status: 401 });
      if (!services.ratings) return Response.json({ error: 'tool not installed' }, { status: 404 });
      return proxy(request, url, services.ratings.port, '/tools/mania-ratings/api/', TOKENS.ratings);
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
if (existsSync(path.join(root, 'target/debug/vosu-mania-ratings'))) await start('ratings', path.join(root, 'target/debug/vosu-mania-ratings'));

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
  check('osu!: ruleset transforms only', JSON.stringify(await texts(page, '#transforms .mod-code')) === '["MR","RD"]', await texts(page, '#transforms .mod-code'));
  check('osu!: difficulty fields HP/CS/AR/OD', JSON.stringify(await page.$$eval('#difficulty input[type=number]', (e) => e.map((i) => i.name))) === '["hp","cs","ar","od"]');
  check('osu!: stats show CS/AR, no keys', (await statLabels(page)).includes('AR') && !(await statLabels(page)).includes('Keys'), await statLabels(page));
  const webgpu = await page.evaluate(() => document.getElementById('preview-message').hidden);
  check('playfield preview rendered by render-core', webgpu, await page.textContent('#preview-message'));
  check('no gameplay-only explanation or copies list', !(await page.content()).includes('Gameplay-only') && !(await page.$('#generated')));
  check('button reads "Generate map"', (await page.textContent('#generate')).trim() === 'Generate map');
  // Regression (round 3): vosu rejects anything but JSON-pointer selectors, and
  // the page must then not claim vosu is unreachable while it is up.
  await page.waitForFunction(() => document.getElementById('live').dataset.state === 'open', null, { timeout: 10_000 }).catch(() => {});
  check('subscription accepted by vosu’s validation; page follows osu!', report.subscriptions.length > 0 && report.subscriptions.every((s) => s.accepted) && (await page.textContent('#live')) === 'Following osu!', { subscriptions: report.subscriptions, live: await page.textContent('#live') });
  await page.screenshot({ path: `${evidence}/osu-dark-1920.png` });

  // ---- Follow the game: switch to the mania map without reloading.
  switchMap('mania');
  await page.waitForFunction((t) => document.getElementById('title').textContent.includes(t), 'Sanzu', { timeout: 20_000 });
  await settled(page);
  check('follows the selected map live (WebSocket frame, no reload)', true, await page.textContent('#title'));
  check('mania: ruleset transforms only', JSON.stringify(await texts(page, '#transforms .mod-code')) === '["IN","HO","MR","RD","CS"]');
  check('mania: difficulty HP/OD only', JSON.stringify(await page.$$eval('#difficulty input[type=number]', (e) => e.map((i) => i.name))) === '["hp","od"]');
  const maniaStats = await statLabels(page);
  check('mania: keys shown, no CS/AR', maniaStats.includes('Keys') && !maniaStats.includes('CS') && !maniaStats.includes('AR'), maniaStats);
  // The mania stage uses the preview's full height: the column narrows to the
  // stage and the canvas keeps render-core's 4:3 world at that height.
  const fit = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const canvas = document.getElementById('canvas').getBoundingClientRect();
    const work = document.querySelector('.workspace').getBoundingClientRect();
    return { fitted: document.querySelector('.workspace').classList.contains('fit-preview'), stageWidth: Math.round(stage.width), stageHeight: Math.round(stage.height), canvasWidth: Math.round(canvas.width), workspaceWidth: Math.round(work.width) };
  });
  check('mania: preview column fits the stage; playfield at full height', fit.fitted && fit.stageWidth < fit.workspaceWidth / 2 && fit.canvasWidth >= fit.stageHeight * 4 / 3 - 1, fit);
  await page.waitForFunction((rated) => {
    const label = document.getElementById('timeline-label').textContent;
    return rated ? label.includes('Mania ratings') : label.startsWith('Notes per second');
  }, Boolean(services.ratings), { timeout: 240_000 }).catch(() => {});
  const timelineLabel = await page.textContent('#timeline-label');
  check(`timeline source: ${services.ratings ? 'mania-ratings local MSD' : 'notes per second'}`, services.ratings ? timelineLabel.includes('Mania ratings') : timelineLabel.includes('Notes per second'), { label: timelineLabel, note: await page.textContent('#timeline-note') });

  // Trims: drag two sections on the strip; set the rate.
  const strip = await page.locator('#strip').boundingBox();
  const drag = async (from, to) => {
    await page.mouse.move(strip.x + strip.width * from, strip.y + strip.height / 2);
    await page.mouse.down();
    await page.mouse.move(strip.x + strip.width * ((from + to) / 2), strip.y + strip.height / 2, { steps: 4 });
    await page.mouse.move(strip.x + strip.width * to, strip.y + strip.height / 2, { steps: 4 });
    await page.mouse.up();
  };
  const objectsBefore = await page.evaluate(() => document.querySelector('#stats div:nth-child(2) dd').textContent);
  await drag(0.30, 0.38);
  await drag(0.62, 0.70);
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

  // ---- Screenshots: both schemes, 1920 (design), 2560, split-screen and phone widths.
  for (const [scheme, width, height] of [['light', 1920, 1080], ['dark', 2560, 1440], ['light', 2560, 1440], ['dark', 960, 1080], ['light', 960, 1080], ['dark', 390, 844], ['light', 390, 844]]) {
    ({ ctx, page, errors } = await open(scheme, { width, height }));
    const layout = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth > innerWidth,
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      scheme: document.documentElement.dataset.scheme,
    }));
    check(`${scheme} ${width}×${height}: scheme, no sideways overflow${width >= 960 ? ', page fits the viewport' : ''}`, layout.scheme === scheme && !layout.overflowX && (width < 960 || !layout.pageScrolls), layout);
    check(`${scheme} ${width}: no page errors`, errors.length === 0, errors);
    await page.screenshot({ path: `${evidence}/mania-${scheme}-${width}.png`, fullPage: width < 960 });
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

  // ---- Older bridges without colorScheme follow the browser preference.
  for (const preference of ['light', 'dark']) {
    ({ ctx, page } = await open(null, { preference }));
    const scheme = await page.evaluate(() => document.documentElement.dataset.scheme);
    check(`no colorScheme → prefers-color-scheme ${preference}`, scheme === preference, scheme);
    await ctx.close();
  }
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
