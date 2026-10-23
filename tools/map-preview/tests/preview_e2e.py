#!/usr/bin/env python3
"""Headless end-to-end check of Map preview against a stand-in vosu host.

The stand-in serves the built UI under /tools/map-preview/, a minimal bridge
(with the round-3 `settings()` helper), `/tools/map-preview/_settings`, the
selected beatmap at `/files/beatmap/file`, and the skin contract
(`GET /files/skin/` report + `/files/skin/<path>` by filename). The
`/websocket/v2/subscribe` stream is played by the test through Playwright, so
it can move the game between song select, gameplay and replays, change maps
and skins, and drive the clock.

Run after `bun run build` in tools/map-preview/web:
  uv run --with playwright python tools/map-preview/tests/preview_e2e.py SONGS SKINS [EVIDENCE_DIR]
SONGS/SKINS are osu! stable folders (read-only; files are copied to a temp
dir first). Needs hardware WebGPU in headless Chromium (Vulkan).
"""
import asyncio
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'web/dist'
PORT = 25650
ORIGIN = f'http://127.0.0.1:{PORT}'
CHROME = Path.home() / '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
MAPS = {
    'osu': ('1230019 Hikiray - Zero Two (prod by Gotze)', 'Hikiray - Zero Two (prod. by Gotze) (Flexo123) [Insane].osu', 38000),
    'mania': ('2342790 Noma Nadeshiko - Sanzu no Kawa Ninngyou Gekijyou', 'Noma Nadeshiko - Sanzu no Kawa Ninngyou Gekijyou (ndglol) [Rice Fusion].osu', 52000),
    'taiko': ('1008969 xi - Blue Zenith', 'xi - Blue Zenith (Faputa) [Oni].osu', 40000),
    'catch': ('1314361 Jack Stauber (feat Sarah) - Doctor', 'Jack Stauber (feat. Sarah) - Doctor (MaryJane) [Cup].osu', 30000),
}
SKINS = {'ralsei': '- # {center} RALSEI 『ラルセイ』- FULL # - v2', 'staircase': '- Staircase!mania'}
# vosu's own design system (read-only), served like /tools/_host/v1/theme.css.
VOSU_ASSETS = Path(os.environ.get('VOSU_ASSETS', Path.home() / 'gh/vosu-ecosystem/vosu-wt/dev-1.2.0/assets/server'))

BRIDGE = """
const fragment = new URLSearchParams(location.hash.slice(1));
const theme = fragment.get('theme');
const colorScheme = ['dark', 'light'].includes(theme) ? theme : 'dark';
document.documentElement.dataset.theme = colorScheme;
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: {id: 'map-preview', name: 'Map preview', version: '0.2.0'},
  canWrite: false,
  dashboardUrl: 'http://127.0.0.1:25651',
  colorScheme,
  settings: async () => (await (await fetch('/tools/map-preview/_settings')).json()).values,
  fetch: () => Promise.reject(new Error('Map preview has no service')),
  subscribe(fields, onFrame, onStatus) {
    let socket, closed = false;
    const connect = () => {
      onStatus?.('connecting');
      socket = new WebSocket(new URL('/websocket/v2/subscribe', location.href.replace(/^http/, 'ws')));
      socket.onopen = () => { socket.send(JSON.stringify(fields)); onStatus?.('open'); };
      socket.onmessage = (event) => onFrame(JSON.parse(event.data));
      socket.onclose = () => { if (!closed) { onStatus?.('closed'); setTimeout(connect, 1000); } };
    };
    connect();
    return () => { closed = true; socket.close(); };
  },
});
"""


class Host:
    def __init__(self, maps: dict, skins: dict):
        self.maps = maps
        self.skins = {name: {p.relative_to(d).as_posix().lower(): p for p in d.rglob('*') if p.is_file()} for name, d in skins.items()}
        self.beatmap = 'osu'
        self.report = {'client': 'lazer', 'name': 'Argon', 'files': False, 'builtin': 'argon', 'base': 'argon'}
        self.skin = None
        self.settings = {}
        self.requests: list[str] = []


def handler(host: Host):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body: bytes, kind='application/octet-stream'):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            host.requests.append(path)
            if path == '/tools/_host/v1/bridge.js':
                return self.send(200, BRIDGE.encode(), 'text/javascript')
            if path == '/tools/_host/v1/theme.css':
                css = (VOSU_ASSETS / 'tokens.css').read_bytes() + b'\n' + (VOSU_ASSETS / 'system.css').read_bytes()
                return self.send(200, css, 'text/css')
            if path.startswith('/assets/') and path.endswith('.woff2'):
                font = VOSU_ASSETS / path.removeprefix('/assets/')
                if font.is_file():
                    return self.send(200, font.read_bytes(), 'font/woff2')
            if path == '/tools/map-preview/_settings':
                return self.send(200, json.dumps({'values': host.settings}).encode(), 'application/json')
            if path.startswith('/tools/map-preview/'):
                relative = path.removeprefix('/tools/map-preview/') or 'index.html'
                file = (DIST / relative).resolve()
                if DIST.resolve() in file.parents and file.is_file():
                    return self.send(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                return self.send(404, b'not found', 'text/plain')
            if path == '/files/beatmap/file':
                return self.send(200, host.maps[host.beatmap].read_bytes(), 'text/plain; charset=utf-8')
            if path == '/files/skin/':
                return self.send(200, json.dumps(host.report).encode(), 'application/json')
            if path.startswith('/files/skin/'):
                name = unquote(path.removeprefix('/files/skin/')).lower()
                files = host.skins.get(host.skin) if host.report.get('files') else None
                file = files.get(name) if files else None
                if file:
                    return self.send(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                return self.send(404, b'{"error":"not found"}', 'application/json')
            return self.send(404, b'not found', 'text/plain')

    return Handler


class Game:
    """The v2 subscription the page sees; `set` sends an update frame."""

    def __init__(self):
        self.values = {
            '/client': 'lazer', '/state/number': 5, '/beatmap/checksum': 'osu', '/beatmap/mode/number': 0,
            '/beatmap/time': {'live': 38000, 'rate': 1, 'running': False}, '/settings/mode/number': 0,
            '/settings/mania': {'scrollSpeed': 24, 'scrollSpeedValue': 24.0, 'scrollDirection': {'number': 1, 'name': 'down'}},
            '/settings/skin/ignoreBeatmapSkins': False,
            '/settings/visual': {'hitLighting': True, 'beatmapColours': True, 'snakingInSliders': True, 'snakingOutSliders': True},
            '/play/mods/array': [], '/play/source': None, '/folders/skin': 'Argon',
        }
        self.sockets = []
        self.revision = 1

    async def route(self, ws):
        state = {'pointers': None}
        self.sockets.append((ws, state))

        def received(message):
            state['pointers'] = json.loads(message)
            ws.send(json.dumps([0, self.revision, [[i, self.values[p]] for i, p in enumerate(state['pointers']) if p in self.values]]))

        ws.on_message(received)
        ws.on_close(lambda *_: self.sockets.remove((ws, state)))

    def set(self, pointer, value):
        self.revision += 1
        self.values[pointer] = value
        for ws, state in self.sockets:
            if state['pointers'] and pointer in state['pointers']:
                ws.send(json.dumps([1, self.revision, [[state['pointers'].index(pointer), value]], []]))


async def checks(host: Host, osk: Path, evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'])

        async def open_page(game: Game, theme='dark', width=1920, height=1080):
            page = await browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            # Headless Chromium can answer the first requestAdapter() with null;
            # the second request succeeds. Harness-only retry.
            await page.add_init_script(
                '{ const request = GPU.prototype.requestAdapter;'
                ' GPU.prototype.requestAdapter = async function (o) {'
                ' return (await request.call(this, o)) ?? request.call(this, o); }; }')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda m: m.type == 'error' and 'status of 404' not in m.text
                    and 'external Instance reference' not in m.text and errors.append(m.text))
            await page.route_web_socket('**/websocket/v2/subscribe', game.route)
            # Headless screenshots cannot see a canvas's direct WebGPU swapchain;
            # the documented bitmap presentation exists for capture environments.
            await page.goto(f'{ORIGIN}/tools/map-preview/?presentation=bitmap#theme={theme}')
            return page

        async def shows(page, selector, text, timeout=30000):
            try:
                await page.wait_for_function('([s, t]) => document.querySelector(s)?.textContent.includes(t)',
                                             arg=[selector, text], timeout=timeout)
            except Exception:
                await page.screenshot(path=str(evidence / 'failed-step.png'))
                actual = await page.locator(selector).text_content()
                raise AssertionError(f'{selector} should contain {text!r}, has {actual!r}; errors {errors}')

        async def settle(page, ms=600):
            await page.wait_for_timeout(ms)

        async def playfield(page):
            return await page.locator('canvas').screenshot()

        game = Game()
        page = await open_page(game)
        # 1. Opens straight into the current map at the current time.
        await shows(page, '#title', 'Hikiray')
        await shows(page, '#follow-status', 'lazer · song select')
        await shows(page, '#skin-name', 'Argon')
        await shows(page, '#time', '0:38.000')
        bar = await page.locator('#bar').bounding_box()
        stage = await page.locator('#stage').bounding_box()
        assert bar['height'] <= 48 and stage['height'] >= 1080 - 48, (bar, stage)
        await settle(page)
        await page.screenshot(path=str(evidence / 'osu-argon-1920x1080.png'))
        shots = {'osu-argon': await playfield(page)}

        # 2. Built-in looks follow the client's skin.
        for builtin, label in [('argon-pro', 'Argon Pro'), ('triangles', 'Triangles'), ('legacy', 'osu! (classic)')]:
            host.report = {'client': 'lazer', 'name': label, 'files': False, 'builtin': builtin, 'base': builtin}
            game.set('/folders/skin', label)
            await shows(page, '#skin-name', label)
            await settle(page)
            await page.screenshot(path=str(evidence / f'osu-{builtin}-1920x1080.png'))
            shots[f'osu-{builtin}'] = await playfield(page)
        # A legacy user skin served by filename, missing elements from the classic look.
        host.report = {'client': 'lazer', 'name': 'Ralsei', 'files': True, 'builtin': None, 'base': 'legacy'}
        host.skin = 'ralsei'
        game.set('/folders/skin', 'Ralsei')
        await shows(page, '#skin-source', 'lazer · current skin')
        await settle(page)
        await page.screenshot(path=str(evidence / 'osu-ralsei-1920x1080.png'))
        shots['osu-ralsei'] = await playfield(page)
        # Argon Pro differs from Argon only in slider body opacity and spinners.
        distinct = [shots[k] for k in ('osu-argon', 'osu-triangles', 'osu-legacy', 'osu-ralsei')]
        assert len(set(distinct)) == len(distinct), 'each skin family must render differently'

        # 3. Map changes follow the game, across rulesets and skins.
        for ruleset, mode in [('mania', 3), ('taiko', 1), ('catch', 2)]:
            host.beatmap = ruleset
            for builtin, label in [('argon', 'Argon'), ('triangles', 'Triangles'), ('legacy', 'osu! (classic)')]:
                host.report = {'client': 'lazer', 'name': label, 'files': False, 'builtin': builtin, 'base': builtin}
                game.set('/folders/skin', f'{label}-{ruleset}')
                game.set('/beatmap/time', {'live': MAPS[ruleset][2], 'rate': 1, 'running': False})
                game.set('/beatmap/mode/number', mode)
                game.set('/beatmap/checksum', ruleset)
                await shows(page, '#mode', ['osu!', 'taiko', 'catch', 'mania'][mode])
                await shows(page, '#skin-name', label)
                await settle(page)
                await page.screenshot(path=str(evidence / f'{ruleset}-{builtin}-1920x1080.png'))
            if ruleset == 'mania':
                host.report = {'client': 'stable', 'name': 'Staircase', 'files': True, 'builtin': None, 'base': None}
                host.skin = 'staircase'
                game.set('/folders/skin', 'Staircase')
                await shows(page, '#skin-source', 'stable · current skin')
                await settle(page)
                await page.screenshot(path=str(evidence / 'mania-staircase-1920x1080.png'))
                # Scroll direction up from the client.
                game.set('/settings/mania', {'scrollSpeed': 24, 'scrollSpeedValue': 24.0, 'scrollDirection': {'number': 0, 'name': 'up'}})
                await settle(page)
                await page.screenshot(path=str(evidence / 'mania-staircase-scroll-up.png'))
                game.set('/settings/mania', {'scrollSpeed': 24, 'scrollSpeedValue': 24.0, 'scrollDirection': {'number': 1, 'name': 'down'}})

        # 4. The live clock advances with the client (rate 1.5, running).
        host.beatmap = 'osu'
        host.report = {'client': 'lazer', 'name': 'Argon', 'files': False, 'builtin': 'argon', 'base': 'argon'}
        game.set('/folders/skin', 'Argon')
        game.set('/beatmap/mode/number', 0)
        game.set('/beatmap/checksum', 'osu')
        await shows(page, '#title', 'Hikiray')
        live = 20000
        for _ in range(10):
            live += 150
            game.set('/beatmap/time', {'live': live, 'rate': 1.5, 'running': True})
            await page.wait_for_timeout(100)
        seen = await page.locator('#time').text_content()
        minutes, rest = seen.split(':')
        shown = int(minutes) * 60000 + float(rest) * 1000
        assert 21300 <= shown <= 21900, seen

        # 5. Hidden during the user's own gameplay; visible for replays.
        game.set('/beatmap/time', {'live': 38000, 'rate': 1, 'running': False})
        game.set('/play/source', 'player')
        game.set('/state/number', 2)
        await page.locator('#hidden-state').wait_for(state='visible')
        assert await page.locator('canvas').evaluate('c => getComputedStyle(c).visibility') == 'hidden'
        await page.screenshot(path=str(evidence / 'hidden-while-playing-1920x1080.png'))
        game.set('/play/source', 'replay')
        await page.locator('#hidden-state').wait_for(state='hidden')
        await shows(page, '#follow-status', 'watching a replay')
        await settle(page)
        await page.screenshot(path=str(evidence / 'watching-replay-1920x1080.png'))
        game.set('/play/source', None)  # provenance lost during play: hide
        await page.locator('#hidden-state').wait_for(state='visible')
        game.set('/state/number', 7)
        await page.locator('#hidden-state').wait_for(state='hidden')

        # 6. Constant Speed is never applied; mods from the client are.
        game.set('/play/mods/array', [{'acronym': 'HD'}, {'acronym': 'CS'}])
        await settle(page)
        await page.locator('#controls-toggle').click()
        await page.screenshot(path=str(evidence / 'controls-open-1920x1080.png'))
        assert await page.locator('#mods input[value=HD]').is_disabled()
        assert await page.locator('#mods input[value=HD]').is_checked()
        await page.keyboard.press('Escape')
        assert not await page.locator('#controls').is_visible()
        assert await page.locator('#controls-toggle').get_attribute('aria-expanded') == 'false'

        # 7. Manual preview: open an .osu file, then follow the game again.
        await page.locator('#map-file').set_input_files(str(host.maps['taiko']))
        await shows(page, '#follow-status', 'Manual preview')
        assert await page.locator('#transport').is_visible()
        # Audio starts muted; the toggle is remembered for this tool.
        assert await page.locator('#mute').get_attribute('aria-pressed') == 'true'
        await page.locator('#mute').click()
        assert await page.locator('#mute').get_attribute('aria-pressed') == 'false'
        assert await page.evaluate("localStorage.getItem('vosu-tools:map-preview:muted')") == '0'
        await page.locator('#mute').click()
        assert await page.evaluate("localStorage.getItem('vosu-tools:map-preview:muted')") == '1'
        await page.locator('#seek').evaluate("s => { s.value = '40000'; s.dispatchEvent(new Event('input')); }")
        await settle(page)
        await page.screenshot(path=str(evidence / 'manual-taiko-1920x1080.png'))
        await page.locator('#follow').click()
        await shows(page, '#title', 'Hikiray')
        assert not await page.locator('#transport').is_visible()

        # 8. .osk skins still load, over the classic look.
        await page.locator('#skin-osk').set_input_files(str(osk))
        await shows(page, '#skin-source', '.osk file')
        await page.close()

        # 9. Settings from the dashboard: playfield-only view, forced Triangles.
        host.settings = {'show_bar': False, 'skin': 'triangles', 'show_progress': True}
        page = await open_page(game, 'dark', 1920, 1080)
        await shows(page, '#skin-name', 'Triangles')
        assert not await page.locator('#bar').is_visible()
        await settle(page)
        await page.screenshot(path=str(evidence / 'settings-playfield-only-1920x1080.png'))
        await page.close()
        host.settings = {}

        # 10. App layout: the page never scrolls and nothing overflows sideways,
        # in both schemes at the four required sizes (drawer closed and open),
        # and still fits horizontally at phone width.
        fits = '''() => {
            const out = [];
            for (const e of document.querySelectorAll('body *')) {
                const r = e.getBoundingClientRect();
                if (r.width && r.right > innerWidth + 0.5) out.push(e.id || e.className || e.tagName);
            }
            return { scroll: document.scrollingElement.scrollHeight, height: innerHeight,
                     wide: document.scrollingElement.scrollWidth, width: innerWidth, out };
        }'''
        sizes = [(1920, 1080), (2560, 1440), (1280, 720), (960, 1080), (390, 800)]
        for theme in ('dark', 'light'):
            for width, height in sizes:
                page = await open_page(game, theme, width, height)
                await shows(page, '#title', 'Hikiray')
                await settle(page)
                for drawer in ('closed', 'open'):
                    if drawer == 'open':
                        await page.locator('#controls-toggle').click()
                        await settle(page, 300)
                    fit = await page.evaluate(fits)
                    if width > 390:
                        assert fit['scroll'] <= fit['height'], f'page scrolls at {width}x{height} {theme} {drawer}: {fit}'
                    assert fit['wide'] <= fit['width'] and not fit['out'], f'horizontal overflow at {width} {theme} {drawer}: {fit}'
                    await page.screenshot(path=str(evidence / f'layout-{theme}-{width}x{height}-{drawer}.png'))
                await page.close()
        await browser.close()
    assert not errors, errors



def main():
    songs, skins = Path(sys.argv[1]), Path(sys.argv[2])
    evidence = Path(sys.argv[3]) if len(sys.argv) > 3 else Path('/tmp/vosu-r3-evidence/ToolMapPreview')
    evidence.mkdir(parents=True, exist_ok=True)
    if not (DIST / 'index.html').is_file():
        sys.exit('Build the UI first: (cd tools/map-preview/web && bun run build)')
    with tempfile.TemporaryDirectory(prefix='map-preview-e2e-') as directory:
        temp = Path(directory)
        maps = {}
        for ruleset, (folder, name, _) in MAPS.items():
            maps[ruleset] = temp / f'{ruleset}.osu'
            shutil.copy(songs / folder / name, maps[ruleset])
        skin_dirs = {}
        for key, folder in SKINS.items():
            skin_dirs[key] = temp / key
            shutil.copytree(skins / folder, skin_dirs[key])
        osk = temp / 'Ralsei.osk'
        with zipfile.ZipFile(osk, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(skin_dirs['ralsei'].rglob('*')):
                if file.is_file():
                    archive.write(file, file.relative_to(skin_dirs['ralsei']).as_posix())
        host = Host(maps, skin_dirs)
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler(host))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            asyncio.run(checks(host, osk, evidence))
        finally:
            server.shutdown()
    print(f'map preview e2e passed; screenshots in {evidence}')


if __name__ == '__main__':
    main()
