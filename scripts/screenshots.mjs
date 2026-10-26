#!/usr/bin/env bun
// Regenerates the README previews in docs/screenshots/ from packaged tools in an
// isolated vosu. See docs/screenshots/README.md for requirements and usage.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dir, '..');
const { values: options } = parseArgs({
  options: {
    vosu: { type: 'string' },
    packages: { type: 'string' },
    'playwright-module': { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'docs/screenshots') },
    work: { type: 'string' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    // Opt-in, needs network: installs the latest published release from the
    // official catalog (18-lab-dev/vosu-tools) and captures only tools.webp.
    'official-tools-page': { type: 'boolean', default: false },
  },
});
const official = options['official-tools-page'];
if (!options.vosu || !options['playwright-module'] || !options.work || (!official && !options.packages))
  throw new Error('Usage: bun scripts/screenshots.mjs --vosu <test-harness vosu> --playwright-module <playwright/index.mjs> --work <scratch dir> (--packages <package.py --out dir> | --official-tools-page) [--out dir] [--only id,...] [--keep]');
/** The catalog source identity vosu shows as official. */
const OFFICIAL = '18-lab-dev/vosu-tools';

// Everything below runs in a bubblewrap sandbox: a private network namespace
// (vosu and the browser can reach only each other on loopback), a minimal /dev
// without GPU nodes (Chromium renders with SwiftShader), a private /tmp and no
// /run/user, so the user's own vosu, sockets and session bus are out of reach.
// The run's folder is the sandbox's /home/player, so paths in the pictures
// show that neutral home rather than the machine's.
const PLAYER = '/home/player';
if (process.env.VOSU_SCREENSHOTS_SANDBOX !== '1') {
  mkdirSync(resolve(options.work), { recursive: true });
  const run = mkdtempSync(join(resolve(options.work), 'run-'));
  const visible = [homedir(), ROOT, dirname(resolve(options.vosu)), ...(official ? [] : [resolve(options.packages)]),
    dirname(resolve(options['playwright-module'])), resolve(options.out)];
  mkdirSync(resolve(options.out), { recursive: true });
  const sandbox = spawnSync('bwrap', [
    '--dev-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run/user', '--tmpfs', '/home',
    ...visible.flatMap((path) => ['--bind', path, path]), '--bind', run, PLAYER,
    // The official-catalog mode alone keeps the network: vosu downloads the
    // published release the way a user's install does.
    // A fresh /proc for the PID namespace: no osu!, lazer or user vosu is visible.
    ...(official ? [] : ['--unshare-net']), '--unshare-ipc', '--unshare-pid', '--proc', '/proc', '--die-with-parent',
    '--setenv', 'VOSU_SCREENSHOTS_SANDBOX', '1',
    '--setenv', 'PLAYWRIGHT_BROWSERS_PATH', process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright'),
    process.execPath, ...process.argv.slice(1),
  ], { stdio: 'inherit' });
  if (options.keep) console.log('[screenshots] run folder (the sandbox\'s /home/player):', run);
  else rmSync(run, { recursive: true, force: true });
  process.exit(sandbox.status ?? 1);
}

const { chromium } = await import(resolve(options['playwright-module']));
const { demo, repeatOsu } = await import('../packages/demo-maps/src/index.ts');
const { maniaOsu } = await import('../packages/demo-maps/src/mania.ts');
const { writeAutoplay } = await import('../tools/replay-renderer/web/test/autoplay.ts');

const DASHBOARD = 'http://127.0.0.1:26251';
const OVERLAY = 'http://127.0.0.1:26250';
const VIEWPORT = { width: 1600, height: 1000 };
const only = options.only ? new Set(options.only.split(',')) : null;
const out = resolve(options.out);
const work = join(PLAYER, '.screenshots');
mkdirSync(work);
const log = (...parts) => console.log('[screenshots]', ...parts);

// ── Isolated environment ────────────────────────────────────────────────
const env = { ...process.env, HOME: PLAYER };
for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'VOSU_SCREENSHOTS_SANDBOX']) delete env[key];
for (const [key, folder] of [['XDG_CONFIG_HOME', '.config'], ['XDG_DATA_HOME', '.local/share'], ['XDG_CACHE_HOME', '.cache'], ['XDG_STATE_HOME', '.local/state'], ['XDG_RUNTIME_DIR', '.runtime']]) {
  mkdirSync(join(PLAYER, folder), { recursive: true, mode: 0o700 });
  env[key] = join(PLAYER, folder);
}

// ── Original content ────────────────────────────────────────────────────
// A stand-in osu! installation folder holding only generated content: demo
// maps, replays generated from them and skins drawn by render-core.
const osuDir = join(PLAYER, 'osu!');
const songs = join(osuDir, 'Songs');
const replays = join(osuDir, 'Replays');
const skins = join(osuDir, 'Skins');
for (const dir of [songs, replays, skins]) mkdirSync(dir, { recursive: true });

/** One period of a demo map repeated once per entry of `scales`, each copy's
 *  times (and tempo) scaled by its entry: a tour that speeds up and slows down. */
function tour(text, period, scales, metadata) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections = {};
  let section = '';
  for (const line of lines) {
    const header = /^\[([^\]]+)\]$/.exec(line.trim());
    if (header) { section = header[1]; sections[section] = []; continue; }
    if (line.trim()) (sections[section] ??= []).push(line);
  }
  const timing = [], objects = [];
  let offset = 0;
  for (const scale of scales) {
    const at = (t) => String(Math.round(offset + Number(t) * scale));
    for (const point of sections.TimingPoints) {
      const fields = point.split(',');
      fields[0] = at(fields[0]);
      if (fields[6] === '1') fields[1] = String(Number(fields[1]) * scale);
      timing.push(fields.join(','));
    }
    for (const object of sections.HitObjects) {
      const fields = object.split(',');
      const type = Number(fields[3]);
      fields[2] = at(fields[2]);
      if (type & 8) fields[5] = at(fields[5]);
      if (type & 128) {
        const [end, ...rest] = fields[5].split(':');
        fields[5] = [at(end), ...rest].join(':');
      }
      objects.push(fields.join(','));
    }
    offset += Math.round(period * scale);
  }
  const values = (name, overrides) => sections[name].map((line) => {
    const key = line.split(':')[0].trim();
    return key in overrides ? `${key}:${overrides[key]}` : line;
  });
  return [
    'osu file format v14', '',
    '[General]', ...values('General', {}), '',
    '[Metadata]', ...values('Metadata', { Title: metadata.title, TitleUnicode: metadata.title, Artist: '18-LAB', Creator: 'vosu tools', Version: metadata.version, Tags: '18-LAB demo' }),
    'BeatmapID:0', 'BeatmapSetID:-1', '',
    '[Difficulty]', ...values('Difficulty', metadata.difficulty ?? {}), '',
    '[TimingPoints]', ...timing, '',
    '[HitObjects]', ...objects, '',
  ].join('\r\n');
}

const MAPS = {
  // AR 5 (1.2 s approach) keeps several objects on the playfield at once.
  osu: tour(demo('osu').osu, 10000, [1, 1, 0.9, 0.9, 0.8, 0.8, 0.75, 0.75, 0.9, 1], { title: '18-LAB Demo · osu! tour', version: 'Showcase', difficulty: { ApproachRate: 5 } }),
  taiko: tour(demo('taiko').osu, 10000, [1, 1, 0.9, 0.9, 0.8, 0.8, 0.9, 1], { title: '18-LAB Demo · taiko tour', version: 'Showcase' }),
  fruits: tour(demo('fruits').osu, 10000, [1, 1, 0.9, 0.9, 0.8, 0.8, 0.9, 1], { title: '18-LAB Demo · catch tour', version: 'Showcase' }),
  mania: tour(maniaOsu(7), 8000, [1, 1, 0.9, 0.9, 0.8, 0.8, 0.7, 0.7, 0.65, 0.65, 0.8, 1], { title: '18-LAB Demo · 7K tour', version: '7K Showcase' }),
};
const maps = {};
for (const [ruleset, text] of Object.entries(MAPS)) {
  const title = /^Title:(.*)$/m.exec(text)[1];
  const version = /^Version:(.*)$/m.exec(text)[1];
  const folder = join(songs, `18-LAB - ${title.replace(/[·]/g, '-')}`);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `18-LAB - ${title.replace(/[·]/g, '-')} (vosu tools) [${version}].osu`);
  writeFileSync(file, text);
  maps[ruleset] = { ruleset, title, version, file, folder, text, md5: createHash('md5').update(text).digest('hex') };
}
log('maps', Object.values(maps).map((m) => `${m.title} [${m.version}] ${m.md5}`).join('; '));

// Generated replays (tools/replay-renderer/web/test/autoplay.ts): autoplay-like
// cursors with a deliberate per-player aim error, under neutral names.
const PLAYERS = [
  { player: 'Demo A', dx: 0, dy: 0, lateMs: 0, wobble: 2 },
  { player: 'Demo B', dx: 9, dy: -6, lateMs: 14, wobble: 8 },
  { player: 'Demo C', dx: -12, dy: 8, lateMs: -10, wobble: 14 },
];
for (const aim of PLAYERS) {
  const bytes = await writeAutoplay(new TextEncoder().encode(maps.osu.text), aim);
  writeFileSync(join(replays, `${aim.player} - 18-LAB - ${maps.osu.title.replace(/[·]/g, '-')} [${maps.osu.version}].osr`), bytes);
}

// ── Catalog stand-in for the packaged tools (served only inside the sandbox) ─
const packages = official ? null : resolve(options.packages);
const catalog = official ? { tools: [] } : JSON.parse(readFileSync(join(packages, 'catalog.json'), 'utf8'));
const served = new Map();
const catalogServer = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const file = served.get(new URL(request.url).pathname);
    return file ? new Response(Bun.file(file)) : new Response('not found', { status: 404 });
  },
});
const base = `http://tools.invalid:${catalogServer.port}`;
for (const tool of catalog.tools) {
  for (const key of ['icon_url', 'banner_url']) if (tool[key]) {
    const name = tool[key].split('/').pop();
    served.set(`/tools/${name}`, join(packages, name));
    tool[key] = `${base}/tools/${name}`;
  }
  for (const pkg of Object.values(tool.packages)) {
    const name = pkg.url.split('/').pop();
    served.set(`/tools/${name}`, join(packages, name));
    pkg.url = `${base}/tools/${name}`;
  }
}
const catalogFile = join(work, 'catalog.json');
writeFileSync(catalogFile, JSON.stringify(catalog));
served.set('/tools/catalog.json', catalogFile);

// ── vosu ────────────────────────────────────────────────────────────────
const config = join(env.XDG_CONFIG_HOME, 'vosu');
mkdirSync(join(config, 'tools'), { recursive: true });
writeFileSync(join(config, 'vosu.toml'), [
  'ENABLE_AUTOUPDATE = false', 'OPEN_DASHBOARD_ON_STARTUP = false', 'START_AT_LOGIN = false',
  'SERVER_IP = "127.0.0.1"', 'SERVER_PORT = 26250', 'DASHBOARD_IP = "127.0.0.1"', 'DASHBOARD_PORT = 26251', '',
].join('\n'));
if (!official) {
  writeFileSync(join(config, 'tools/catalog-sources.json'), JSON.stringify([{ source: `${base}/tools/catalog.json`, enabled: true }]));
  env.VOSU_TOOL_CATALOG_TEST_SOCKET = `127.0.0.1:${catalogServer.port}`;
}
const vosuBinary = resolve(options.vosu);
const vosux = join(work, 'vosux');
symlinkSync(vosuBinary, vosux);
const daemonLog = Bun.file(join(work, 'daemon.log')).writer();
const daemon = spawn(vosuBinary, ['--update=false'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', (chunk) => daemonLog.write(chunk));
daemon.stderr.on('data', (chunk) => daemonLog.write(chunk));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, what, timeout = 60000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
let csrf = '';
async function dashboard(path, init = {}) {
  const response = await fetch(DASHBOARD + path, {
    ...init,
    headers: { Origin: DASHBOARD, 'X-Vosu-CSRF': csrf, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${body}`);
  return body.startsWith('{') || body.startsWith('[') ? JSON.parse(body) : body;
}
const post = (path, data = {}) => dashboard(path, { method: 'POST', body: JSON.stringify(data) });
/** Runs `vosux` asynchronously: the catalog stand-in lives in this process. */
async function cli(...args) {
  const run = Bun.spawn([vosux, ...args], { cwd: work, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (status !== 0) throw new Error(`vosux ${args.join(' ')}: ${stderr || stdout}`);
  return stdout;
}

// ── Game stand-in ───────────────────────────────────────────────────────
// No osu! client runs here. Pages that follow the game get a selected demo
// map through Playwright routes: the `/websocket/v2/subscribe` stream (song
// select, the map, no mods), `/json/v2`, the map's file and the skin report
// of lazer's built-in Argon (render-core's original drawing). Audio and
// background are absent, as the demo maps have neither.
const MODES = { osu: [0, 'osu'], taiko: [1, 'taiko'], fruits: [2, 'fruits'], mania: [3, 'mania'] };
const ARGON = { client: 'lazer', name: 'Argon', files: false, builtin: 'argon', base: 'argon', entries: [], truncated: false };
const TRIANGLES = { ...ARGON, name: 'Triangles', builtin: 'triangles', base: 'triangles' };
function gameState(map, time) {
  const [number, name] = MODES[map.ruleset];
  return {
    client: 'lazer',
    state: { number: 5, name: 'selectSong' },
    beatmap: {
      checksum: map.md5, artist: '18-LAB', title: map.title, version: map.version, mapper: 'vosu tools',
      mode: { number, name }, time: { live: time, rate: 1, running: false },
    },
    settings: {
      mode: { number, name },
      mania: { scrollSpeed: 24, scrollSpeedValue: 24, scrollTime: 11485 / 24, scrollDirection: { number: 1, name: 'down' }, timingBasedNoteColouring: false },
      skin: { ignoreBeatmapSkins: false },
      visual: { snakingInSliders: true, snakingOutSliders: true, hitLighting: true, beatmapColours: true, hitAnimations: true, comboColourNormalisation: 0.2 },
    },
    play: { source: null, mods: { array: [], name: 'NM', number: 0, rate: 1 }, combo: { current: 0, max: 0 }, hits: { 0: 0, 50: 0, 100: 0, 300: 0 } },
    folders: { skin: null },
  };
}
const pointer = (doc, path) => path.split('/').slice(1)
  .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  .reduce((value, key) => (value != null && typeof value === 'object' ? value[key] : undefined), doc);
async function selectMap(page, map, time = 0, skin = ARGON) {
  const doc = gameState(map, time);
  await page.routeWebSocket(/\/websocket\/v2\/subscribe$/, (ws) => {
    ws.onMessage((message) => {
      const values = [];
      JSON.parse(String(message)).forEach((path, index) => {
        const value = pointer(doc, path);
        if (value !== undefined) values.push([index, value]);
      });
      ws.send(JSON.stringify([0, 1, values]));
    });
  });
  await page.route(/\/json\/v2$/, (route) => route.fulfill({ json: doc }));
  await page.route(/\/files\/beatmap\/file(\?.*)?$/, (route) => route.fulfill({ body: map.text, contentType: 'text/plain; charset=utf-8' }));
  await page.route(/\/files\/beatmap\/(audio|background)(\?.*)?$/, (route) => route.fulfill({ status: 404, body: '' }));
  await page.route(/\/files\/skin\/$/, (route) => route.fulfill({ json: skin }));
}

/** A tool backend outside vosu, given the selected demo map as its host
 *  context by a stand-in host (the shape of tools/practice/tests/smoke.py);
 *  `route` sends a page's `/tools/<id>/api/` requests to it. */
async function standaloneBackend(id, map) {
  const token = createHash('sha256').update(`${id}${Date.now()}${Math.random()}`).digest('hex');
  const settings = (await dashboard(`/api/tools/${id}/settings`)).values ?? {};
  const context = {
    client: 'lazer', songs_dir: songs, osu_dir: null,
    skin: { name: 'Argon', folder: null, files: false, builtin: 'argon', base: 'argon' },
    beatmap: { checksum: map.md5, mode: map.ruleset, folder: map.folder, file: map.file, audio: null, background: null },
  };
  const host = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (request.headers.get('x-vosu-tool-token') !== token) return new Response('unauthorized', { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === '/tools/_host/v1/context') return Response.json(context);
      if (path === '/tools/_host/v1/settings') return Response.json(settings);
      return Response.json({ error: 'not available in the stand-in host' }, { status: 404 });
    },
  });
  const data = join(work, `standalone-${id}`);
  mkdirSync(join(data, 'data'), { recursive: true });
  mkdirSync(join(data, 'cache'), { recursive: true });
  const service = Bun.spawn([join(env.XDG_DATA_HOME, `vosu/tools/${id}/bin/vosu-${id}`)], {
    env: {
      ...env, VOSU_TOOL_PROTOCOL: '1', VOSU_TOOL_ID: id, VOSU_TOOL_TOKEN: token, VOSU_URL: `http://127.0.0.1:${host.port}`,
      VOSU_TOOL_DATA_DIR: join(data, 'data'), VOSU_TOOL_CACHE_DIR: join(data, 'cache'), VOSU_TOOL_INTERFACE: 'service',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(join(data, 'service.log')),
  });
  const reader = service.stdout.getReader();
  let ready = '';
  while (!ready.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${id} backend exited before it was ready`);
    ready += new TextDecoder().decode(value);
  }
  const port = Number(/^vosu-tool-ready (\d+)/.exec(ready)?.[1]);
  if (!port) throw new Error(`${id} backend: unexpected handshake ${ready}`);
  return {
    async route(page) {
      await page.route(new RegExp(`/tools/${id}/api/`), async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: `http://127.0.0.1:${port}/${url.pathname.split('/api/')[1]}${url.search}`,
          headers: { ...route.request().headers(), 'x-vosu-tool-token': token },
        });
        await route.fulfill({ response });
      });
    },
    async stop() {
      service.stdin.end();
      await Promise.race([service.exited, sleep(8000)]);
      service.kill();
      host.stop(true);
    },
  };
}

// ── Skins drawn by render-core ──────────────────────────────────────────
// render-core's built-in looks (packages/render-core/src/builtin.ts) are
// original Canvas 2D drawings; exported as stable skin folders they give
// Skin studio a library without third-party skins.
const SKINS = [['legacy', 'classic look'], ['triangles', 'Triangles look'], ['argon', 'Argon look']];
async function exportSkins(context) {
  const entry = join(work, 'skin-export.ts');
  writeFileSync(entry, `import { builtinSkin } from ${JSON.stringify(join(ROOT, 'packages/render-core/src/builtin.ts'))};
globalThis.exportSkin = async (name) => {
  const skin = builtinSkin(name);
  const files = [];
  for (const [asset, bitmap] of skin.assets) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    files.push([asset, skin.pixelScale?.get(asset) ?? 1, btoa(text)]);
  }
  return { files, sections: [...skin.sections] };
};`);
  const build = await Bun.build({ entrypoints: [entry], target: 'browser' });
  if (!build.success) throw new AggregateError(build.logs, 'skin export bundle failed');
  const page = await context.newPage();
  await page.setContent('<!doctype html><title>skin export</title>');
  await page.addScriptTag({ content: await build.outputs[0].text(), type: 'module' });
  await page.waitForFunction(() => typeof globalThis.exportSkin === 'function');
  for (const [name, look] of SKINS) {
    const { files, sections } = await page.evaluate((name) => globalThis.exportSkin(name), name);
    const folder = join(skins, `18-LAB Demo - ${look}`);
    for (const [asset, scale, data] of files) {
      const file = join(folder, `${asset}${scale === 2 ? '@2x' : ''}.png`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
    }
    const ini = [];
    for (const [section, blocks] of sections)
      for (const block of blocks) {
        ini.push(`[${section}]`);
        const values = section === 'General' ? { ...block, Name: `18-LAB Demo · ${look}`, Author: '18-LAB' } : block;
        for (const [key, value] of Object.entries(values)) ini.push(`${key}: ${value}`);
        ini.push('');
      }
    writeFileSync(join(folder, 'skin.ini'), ini.join('\r\n'));
  }
  await page.close();
}

// ── Capture ─────────────────────────────────────────────────────────────
const report = [];
let browser, context;
async function tab() {
  const page = await context.newPage();
  page.on('pageerror', (error) => log('page error:', error.message));
  return page;
}
const launch = async (id, query = '') =>
  (await post(`/api/tools/${id}/launch`, { theme: 'dark' })).url.replace('/#', `/${query}#`);
async function settle(page, ms = 1500) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(ms);
}
/** Saves the viewport as WebP (encoded by Chromium) and records its size. */
async function save(page, name, description) {
  const png = await page.screenshot({ type: 'png' });
  writeFileSync(join(work, `${name}.png`), png);
  const encoder = await context.newPage();
  const webp = await encoder.evaluate(async ({ data, quality }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/webp', quality).split(',')[1];
  }, { data: png.toString('base64'), quality: 0.9 });
  await encoder.close();
  const file = join(out, `${name}.webp`);
  writeFileSync(file, Buffer.from(webp, 'base64'));
  report.push({ file: basename(file), bytes: statSync(file).size, description });
  log(`${basename(file)} ${(statSync(file).size / 1024).toFixed(0)} KiB: ${description}`);
}
async function setSettings(id, values) {
  await post(`/api/tools/${id}/settings`, Object.entries(values).map(([uniqueID, value]) => ({ uniqueID, value })));
}

/** Synthetic mapsets for the downloader: no real map, mapper or set id. */
function sampleSets() {
  const status = ['ranked', 'loved', 'ranked', 'qualified', 'ranked', 'approved'];
  return Array.from({ length: 14 }, (_, i) => ({
    id: 9_000_001 + i,
    artist: '18-LAB Sample',
    title: `Sample set ${String(i + 1).padStart(2, '0')}`,
    creator: `sample-${'abc'[i % 3]}`,
    status: status[i % status.length],
    owned: false,
    downloaded: i === 1,
    beatmaps: ['Easy', 'Normal', 'Hard', 'Insane'].slice(0, 2 + (i % 3)).map((version, d) => ({
      difficulty_rating: Math.round((1.9 + d * 0.55 + (i % 4) * 0.12) * 100) / 100,
      version, mode_int: 0, total_length: 84 + ((i * 17) % 90), checksum: null,
    })),
  }));
}
function sampleJobs(sets) {
  const job = (set, state, progress, total) => ({
    id: `sample-${set.id}`, set, state, progress, message: '', bytes: Math.round(total * progress), total,
    sha256: state === 'done' ? '0'.repeat(64) : null, imported_to: null,
  });
  return [job(sets[1], 'done', 1, 4_718_592), job(sets[4], 'running', 0.42, 6_920_601), job(sets[7], 'queued', 0, 5_347_737)];
}

const SHOTS = {
  async tools() {
    const page = await tab();
    await page.goto(DASHBOARD + '/tools', { waitUntil: 'networkidle' });
    await settle(page);
    await save(page, 'tools', `Dashboard Tools page after installing every tool from the official catalog (${catalog.tools.map((t) => `${t.id} ${t.version}`).join(', ')}); no game attached`);
  },
  async 'map-preview'() {
    const page = await tab();
    // 39.05 s (the 0.8× section): a fading circle, the next circle and a
    // ticked slider with their approach circles, in lazer's Triangles look.
    await selectMap(page, maps.osu, 39050, TRIANGLES);
    await page.goto(await launch('map-preview', '?presentation=bitmap'));
    await page.waitForFunction(() => {
      const follow = document.querySelector('#follow-status')?.textContent ?? '';
      return follow && !follow.startsWith('Connecting') && document.querySelector('#skin-name')?.textContent !== '—';
    }, null, { timeout: 60000 });
    if ((await page.locator('#controls-toggle').getAttribute('aria-expanded')) !== 'true') await page.locator('#controls-toggle').click();
    await settle(page, 4000);
    await save(page, 'map-preview', 'Map preview following a selected demo map (osu!) with the built-in Triangles look');
  },
  async practice() {
    const backend = await standaloneBackend('practice', maps.osu);
    try {
      const page = await tab();
      await selectMap(page, maps.osu);
      await backend.route(page);
      const timeline = page.waitForResponse((response) => response.url().includes('/v1/timeline') && response.ok());
      await page.goto(await launch('practice'));
      await page.locator('#title').filter({ hasText: '18-LAB' }).waitFor({ timeout: 60000 });
      const duration = (await (await timeline).json()).duration_ms;
      // A 1.25× rate, Mirror and one kept section, the preview inside it.
      await page.locator('input[name="rate"]').fill('1.25');
      await page.locator('input[name="rate"]').dispatchEvent('input');
      await page.getByRole('button', { name: 'Mirror', exact: true }).click();
      await settle(page, 1500);
      const strip = await page.locator('#strip').boundingBox();
      const at = (fraction) => strip.x + strip.width * fraction;
      // Keep 0:20.5–0:39.3 (source time).
      await page.keyboard.down('Shift');
      await page.mouse.move(at(20500 / duration), strip.y + strip.height / 2);
      await page.mouse.down();
      await page.mouse.move(at(39300 / duration), strip.y + strip.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      // 30.1 s (the 0.9× section): circles and a ticked slider on screen.
      await page.mouse.click(at(30100 / duration), strip.y + strip.height / 2);
      await page.mouse.move(0, 0);
      await settle(page, 4000);
      await save(page, 'practice', 'osu! practice tool on a selected demo map (osu!): 1.25×, Mirror and one kept section');
    } finally {
      await backend.stop();
    }
  },
  async 'mania-ratings'() {
    await cli('mania-ratings', maps.mania.file, '--json');
    const page = await tab();
    await selectMap(page, maps.mania);
    await page.route(/\/tools\/mania-ratings\/api\/v1\/beatmap\/current/, (route) =>
      route.continue({ url: route.request().url().replace('/v1/beatmap/current', `/v1/beatmap/${maps.mania.md5}`) }));
    await page.goto(await launch('mania-ratings'));
    await page.locator('#dot:not([data-state="busy"])').waitFor({ timeout: 120000 });
    await settle(page, 3000);
    await save(page, 'mania-ratings', 'Mania ratings for a selected demo map (7K)');
  },
  async 'server-pp'() {
    // Two of the tool's example calculators (tests/fixtures/calculators) as
    // custom rows; the AssemblyScript one scores mania only.
    const custom = ['rosu_reference', 'rust_example'];
    const calculators = join(env.XDG_DATA_HOME, 'vosu/tool-data/server-pp/calculators');
    mkdirSync(calculators, { recursive: true });
    for (const id of custom)
      copyFileSync(join(ROOT, `tools/server-pp/tests/fixtures/calculators/${id}.wasm`), join(calculators, `${id}.wasm`));
    await post('/api/tools/server-pp/restart');
    await until(async () => (await dashboard('/api/tools/server-pp')).status === 'running', 'server-pp');
    // Each calculator caches the uploaded map for the page's checksum lookups.
    for (const server of ['akatsuki', 'mamestagram', ...custom]) await cli('server-pp', maps.osu.file, '--server', server, '--json');
    const page = await tab();
    await selectMap(page, maps.osu);
    await page.goto(await launch('server-pp'));
    await page.locator('input[name="acc"]').fill('98.5');
    await page.locator('input[name="misses"]').fill('2');
    await page.locator('input[name="misses"]').blur();
    await settle(page, 5000);
    await save(page, 'server-pp', 'Server pp calculator on a selected demo map (osu!): built-in profiles and two example custom calculators at 98.5%, 2 misses');
  },
  async 'replay-renderer'() {
    await setSettings('replay-renderer', { osu_dir: osuDir, skin: '18-LAB Demo - classic look' });
    const page = await tab();
    await selectMap(page, maps.osu);
    await page.goto(await launch('replay-renderer'));
    const add = page.getByRole('button', { name: /^Add .*'s replay$/ });
    await add.first().waitFor({ timeout: 60000 });
    for (let i = PLAYERS.length - 1; i >= 0; i--) {
      await add.nth(i).click();
      await sleep(1500);
    }
    await page.locator('#layout').selectOption('overlap');
    await settle(page, 1500);
    await page.locator('#seek').evaluate((seek) => {
      seek.value = '39050';
      seek.dispatchEvent(new Event('input'));
    });
    await settle(page, 6000);
    await save(page, 'replay-renderer', 'Replay renderer: three generated replays of a demo map in the Overlap layout');
  },
  async 'skin-studio'() {
    // A 7K demo mix on the Keymodes tab: the classic look as the base, with
    // its 7K notes and holds taken from the Triangles look (both exported
    // from render-core), the classic keys kept.
    await setSettings('skin-studio', { stable_skins_dir: skins, lazer_skins: false });
    const page = await tab();
    await page.goto(await launch('skin-studio'));
    await page.locator('#skins .skin', { hasText: /classic look/ }).first().click({ timeout: 60000 });
    await page.click('#use-base');
    await page.click('#tab-keymodes');
    await page.waitForSelector('#km-counts .km-count');
    await page.locator('#km-counts .km-count', { hasText: /^.*7K/ }).first().click();
    await page.waitForSelector('#km-grid .km-colhead:nth-of-type(7)');
    const ready = async () => {
      await sleep(500);
      await page.waitForFunction(() => !document.querySelector('#km-images .v-empty')?.textContent?.startsWith('Reading'));
    };
    const slot = (key) => page.locator(`#km-grid [data-key="${key}"]`).first();
    const triangles = await page.locator('#km-source option').evaluateAll((options) =>
      options.find((o) => /Triangles look/.test(o.textContent ?? ''))?.value);
    if (!triangles) throw new Error('Keymodes source list has no Triangles look');
    await page.selectOption('#km-source', triangles);
    await ready();
    // Each note role takes the Triangles image offered first for column 1
    // (the one its skin.ini uses there), then every column follows osu!'s
    // 1/2/S pattern.
    for (const key of ['NoteImage0', 'NoteImage0H', 'NoteImage0L', 'NoteImage0T']) {
      await slot(key).click();
      await ready();
      await page.locator('#km-images .km-tile').first().click();
      await sleep(300);
    }
    await page.click('#km-pattern');
    await sleep(500);
    await slot('NoteImage3').click();
    await ready();
    await settle(page, 4000);
    await save(page, 'skin-studio', 'Skin studio Keymodes tab: a 7K demo mix of the exported classic look with Triangles notes');
  },
  async downloader() {
    const page = await tab();
    await selectMap(page, maps.osu);
    // Mirror search results come from the osu! API or a mirror: synthetic
    // "Sample set" entries stand in for them, and for the download queue.
    const sample = sampleSets();
    await page.route(/\/tools\/downloader\/api\/v1\/search$/, (route) => route.fulfill({ json: { job: 'sample-search' } }));
    await page.route(/\/tools\/downloader\/api\/v1\/jobs\/sample-search$/, (route) => route.fulfill({
      json: {
        state: 'done', message: '', result: {
          beatmapsets: sample, hidden: 0, cursor_string: null,
          based_on: { checksum: maps.osu.md5, artist: '18-LAB', title: maps.osu.title, version: maps.osu.version, creator: 'vosu tools', stars: 2.44 },
        },
      },
    }));
    await page.route(/\/tools\/downloader\/api\/v1\/state$/, async (route) => {
      const state = await (await route.fetch()).json();
      state.queue = { paused: false, jobs: sampleJobs(sample) };
      await route.fulfill({ json: state });
    });
    await page.goto(await launch('downloader'));
    await page.locator('select[name="discovery"]').selectOption('similar');
    await page.locator('#search button[type="submit"]').click();
    await page.locator('#results tr').nth(3).waitFor({ timeout: 30000 });
    await settle(page, 2000);
    await save(page, 'downloader', 'Beatmap downloader with synthetic sample results and queue (sample data)');
  },
};

try {
  await until(async () => (await fetch(DASHBOARD + '/api/tools')).ok, 'vosu');
  csrf = JSON.parse(/<script[^>]*id="vosu-context"[^>]*>([\s\S]*?)<\/script>/.exec(await dashboard('/tools'))[1]).csrf;
  if (!official)
    await until(async () => {
      const view = await dashboard('/api/tools/catalog');
      return view.tools.length === catalog.tools.length && view.sources.every((source) => source.status === 'ok');
    }, 'the tool catalog');
  for (const tool of catalog.tools) {
    if (!(await fetch(`${DASHBOARD}/api/tools/${tool.id}`)).ok) await cli('--install', tool.id);
    await post(`/api/tools/${tool.id}/trust`);
  }
  if (official) {
    // vosu's default sources, as on a fresh install: every tool of the
    // official catalog, installed through the normal catalog flow.
    const view = await until(async () => {
      const view = await dashboard('/api/tools/catalog');
      return view.tools.some((tool) => tool.source === OFFICIAL) && view;
    }, 'the official catalog', 120000);
    for (const tool of view.tools.filter((tool) => tool.source === OFFICIAL))
      if (!(await fetch(`${DASHBOARD}/api/tools/${tool.id}`)).ok) await cli('--install', tool.id);
    for (const tool of view.tools.filter((tool) => tool.source === OFFICIAL)) {
      const installed = await dashboard(`/api/tools/${tool.id}`);
      if (installed.source !== 'official' || !installed.trusted)
        throw new Error(`${tool.id}: installed as ${installed.source}, trusted ${installed.trusted}`);
      catalog.tools.push(tool);
    }
  }
  log('installed', catalog.tools.map((t) => `${t.id} ${t.version}`).join(', '));
  browser = await chromium.launch({
    headless: true,
    env,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark' });
  await exportSkins(context);
  for (const [name, shoot] of Object.entries(SHOTS)) {
    // tools.webp must show what a real install shows (official, trusted), so
    // only the official-catalog mode captures it; that mode captures nothing else.
    if ((name === 'tools') !== official || (only && !only.has(name))) continue;
    log('capturing', name);
    try {
      await shoot();
    } catch (error) {
      // Leave what the pages showed next to the logs before giving up.
      for (const [index, page] of context.pages().entries())
        await page.screenshot({ path: join(work, `failed-${name}-${index}.png`) }).catch(() => {});
      log('failed pages saved under .screenshots/ in the run folder (use --keep)');
      throw error;
    }
    for (const page of context.pages()) await page.close();
  }
  writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  daemon.kill('SIGTERM');
  await Promise.race([new Promise((done) => daemon.once('exit', done)), sleep(20000)]);
  daemonLog.end();
  catalogServer.stop(true);
}
// The replay encoder's LZMA decoder keeps the event loop alive.
process.exit(0);
