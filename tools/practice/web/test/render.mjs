// Headless UI render check for the practice tool against its real service.
//
//   bun tools/practice/web/test/render.mjs <playwright index.mjs> <evidence dir> <stable .osu>
//
// A stand-in host (127.0.0.1:25250, the practice test port) serves web/dist, a
// bridge module with the protocol-v1 surface (fragment `theme=` → colorScheme,
// `session=1` → write session), host context and the tool API proxy, which, like
// vosu, refuses [api].write routes without a UI session. The service runs from
// target/debug with isolated HOME/XDG_* on a temporary copy of the map folder, so
// the source Songs folder is never written. Screenshots: both schemes at 1440 and
// 390 px, read-only pages, and an expanded <select> for the native-control audit.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [playwrightModule, evidence, source] = process.argv.slice(2);
if (!playwrightModule || !evidence || !source) throw new Error('Usage: render.mjs <playwright index.mjs> <evidence dir> <stable .osu>');
const { chromium } = await import(playwrightModule);
const root = path.resolve(import.meta.dir, '../../../..');
const dist = path.join(root, 'tools/practice/web/dist');
const manifest = await readFile(path.join(root, 'tools/practice/tool.toml'), 'utf8');
const routes = Object.fromEntries(['read', 'write'].map((kind) => [kind, JSON.parse(manifest.match(new RegExp(`^${kind} = (\\[.*\\])$`, 'm'))[1])]));
const TOKEN = 'practice-render-check';
const SESSION = 'practice-render-session';
await mkdir(evidence, { recursive: true });

const temporary = await mkdtemp(path.join(tmpdir(), 'practice-render-'));
const environment = { ...process.env };
for (const variable of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
  environment[variable] = path.join(temporary, variable);
  await mkdir(environment[variable], { mode: 0o700 });
}
const songs = path.join(temporary, 'Songs');
const folder = path.join(songs, path.basename(path.dirname(source)));
await mkdir(folder, { recursive: true });
const text = await readFile(source, 'utf8');
const field = (key) => text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1];
const audio = field('AudioFilename');
const chart = path.join(folder, path.basename(source));
await cp(source, chart);
await cp(path.join(path.dirname(source), audio), path.join(folder, audio));
const original = await readFile(source);
const checksum = new Bun.CryptoHasher('md5').update(original).digest('hex');
const mode = { 0: 'osu', 1: 'taiko', 2: 'fruits', 3: 'mania' }[Number(field('Mode') ?? 0)];
const context = { client: 'stable', songs_dir: songs, osu_dir: null, skin: null,
  beatmap: { checksum, mode, folder, file: chart, audio: path.join(folder, audio), background: null } };

let servicePort = 0;
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
  subscribe() { return () => {}; },
});`;
const host = Bun.serve({
  hostname: '127.0.0.1',
  port: 25250,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/tools/_host/v1/context') {
      return request.headers.get('X-Vosu-Tool-Token') === TOKEN ? Response.json(context) : new Response(null, { status: 401 });
    }
    if (url.pathname === '/tools/_host/v1/bridge.js') return new Response(bridge, { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname.startsWith('/tools/practice/api/')) {
      const route = '/' + url.pathname.slice('/tools/practice/api/'.length);
      // Same classification as vosu: GET/HEAD on a read prefix is a read; else a write prefix needs the UI session.
      const matches = (prefixes) => prefixes.some((prefix) => route === prefix || route.startsWith(prefix + '/'));
      const read = ['GET', 'HEAD'].includes(request.method) && matches(routes.read);
      if (!read && !matches(routes.write)) return new Response(null, { status: 404 });
      if (!read && request.headers.get('X-Vosu-Tool-Session') !== SESSION) return Response.json({ error: 'write session required' }, { status: 403 });
      return fetch(`http://127.0.0.1:${servicePort}${route}${url.search}`, {
        method: request.method, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        headers: { 'X-Vosu-Tool-Token': TOKEN, 'Content-Type': 'application/json', 'X-Vosu-Caller': 'ui:practice' },
      });
    }
    if (url.pathname.startsWith('/tools/practice/')) {
      const relative = url.pathname.slice('/tools/practice/'.length) || 'index.html';
      const file = Bun.file(path.join(dist, path.normalize(relative)));
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  },
});

Object.assign(environment, {
  VOSU_TOOL_PROTOCOL: '1', VOSU_TOOL_ID: 'practice', VOSU_TOOL_TOKEN: TOKEN, VOSU_URL: 'http://127.0.0.1:25250',
  VOSU_TOOL_DATA_DIR: path.join(temporary, 'data'), VOSU_TOOL_CACHE_DIR: path.join(temporary, 'cache'), VOSU_TOOL_INTERFACE: 'service',
});
const service = spawn(path.join(root, 'target/debug/vosu-practice'), [], { env: environment, stdio: ['pipe', 'pipe', 'inherit'] });
const firstLine = await new Promise((resolve) => createInterface({ input: service.stdout }).once('line', resolve));
if (!firstLine.startsWith('vosu-tool-ready ')) throw new Error(`service not ready: ${firstLine}`);
servicePort = Number(firstLine.split(' ')[1]);

const report = { map: path.basename(source), checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
const browser = await chromium.launch({ headless: true });
const pageUrl = 'http://127.0.0.1:25250/tools/practice/';
async function open(context, fragment, width) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
  await page.goto(`${pageUrl}#${fragment}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('access')?.dataset.state !== 'pending');
  await page.waitForFunction(() => document.getElementById('title')?.textContent !== 'Waiting for osu! context');
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}
try {
  // Write session: generate one copy through the UI, then capture both schemes and widths.
  {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const { page, errors } = await open(context, 'theme=dark&session=1', 1440);
    await page.locator('.mod', { hasText: 'Mirror' }).filter({ has: page.locator(`input[value="MR"]:not([disabled])`) }).click();
    await page.click('#generate');
    await page.waitForFunction(() => document.querySelector('#generated .copy'), null, { timeout: 600_000 });
    check('write session generates a copy through the UI', true, await page.locator('#generated .copy h3').first().textContent());
    check('source map unchanged', Buffer.compare(original, await readFile(source)) === 0 && Buffer.compare(original, await readFile(chart)) === 0);
    check('no page errors during generation', errors.length === 0, errors);
    await context.close();
  }
  for (const scheme of ['dark', 'light']) {
    for (const width of [1440, 390]) {
      // The browser preference is the opposite scheme, so the page must follow vosu.colorScheme.
      const context = await browser.newContext({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { page, errors } = await open(context, `theme=${scheme}&session=1`, width);
      await page.locator('.mod', { has: page.locator('input[value="DT"]') }).click();
      await page.locator('.mod', { has: page.locator('input[value="MR"]:not([disabled])') }).click();
      await page.click('#preview-button');
      await page.waitForSelector('#preview dl');
      const state = await page.evaluate(() => ({
        scheme: document.documentElement.dataset.scheme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        readout: document.getElementById('rate-readout').textContent,
        fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      check(`${scheme} ${width}: follows vosu.colorScheme over browser preference`, state.scheme === scheme && state.colorScheme === scheme, state);
      check(`${scheme} ${width}: DT at rate 1 reads as its default`, state.readout === '1.50×', state.readout);
      check(`${scheme} ${width}: bundled fonts loaded`, ['Bricolage Grotesque Variable', 'Instrument Sans Variable', 'DM Mono'].every((f) => state.fonts.includes(f)), [...new Set(state.fonts)]);
      check(`${scheme} ${width}: no horizontal overflow`, !state.overflow);
      check(`${scheme} ${width}: no page errors`, errors.length === 0, errors);
      // Clicking scrolled the page; capture from the top so the sticky rail sits in place.
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `${evidence}/practice-${scheme}-${width}.png`, fullPage: true });
      if (width === 1440) {
        // Native-control audit: the select's own colours and the option list colours.
        const audit = await page.evaluate(() => {
          const select = document.querySelector('select[name=mirror]');
          const option = select.options[0];
          const css = (element) => { const s = getComputedStyle(element); return { color: s.color, background: s.backgroundColor, colorScheme: s.colorScheme }; };
          return { select: css(select), option: css(option), number: css(document.querySelector('input[name=seed]')) };
        });
        const differs = (x) => x.color !== x.background && !x.background.endsWith(', 0)');
        check(`${scheme}: native controls carry scheme and opaque colours`, [audit.select, audit.option, audit.number].every((x) => x.colorScheme === scheme && differs(x)), audit);
        await page.locator('select[name=mirror]').evaluate((select) => { select.size = 3; });
        await page.locator('select[name=mirror]').screenshot({ path: `${evidence}/practice-${scheme}-select-options.png` });
      }
      await context.close();
    }
    // Read-only page (a reload without a launch): write controls disabled, write routes refused.
    const context = await browser.newContext({ colorScheme: scheme });
    const { page, errors } = await open(context, `theme=${scheme}`, 1440);
    const readOnly = await page.evaluate(async () => ({
      access: document.getElementById('access').textContent,
      disabled: ['generate', 'save', 'preview-button'].map((id) => document.getElementById(id).disabled),
      deletes: [...document.querySelectorAll('#generated button')].map((b) => b.disabled),
    }));
    check(`${scheme}: read-only disables every write control`, readOnly.disabled.every(Boolean) && readOnly.deletes.length > 0 && readOnly.deletes.every(Boolean), readOnly);
    check(`${scheme}: read-only page has no errors`, errors.length === 0, errors);
    await page.screenshot({ path: `${evidence}/practice-${scheme}-1440-readonly.png`, fullPage: true });
    await context.close();
  }
  // Older bridges without colorScheme fall back to the browser preference.
  for (const preference of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: preference });
    const { page } = await open(context, '', 1440);
    const scheme = await page.evaluate(() => document.documentElement.dataset.scheme);
    check(`no colorScheme → prefers-color-scheme ${preference}`, scheme === preference, scheme);
    await context.close();
  }
} finally {
  await writeFile(`${evidence}/render.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  service.stdin.end();
  await new Promise((resolve) => service.once('exit', resolve));
  host.stop(true);
  await rm(temporary, { recursive: true, force: true });
}
if (report.checks.some((c) => !c.ok)) process.exit(1);
