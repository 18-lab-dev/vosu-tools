#!/usr/bin/env python3
"""Headless browser check of Map preview's skin sources against a stand-in host.

The stand-in serves the built UI under /tools/map-preview/, a minimal bridge,
the selected beatmap, and vosu's skin contract: `GET /files/skin/` reports
`{client, name, files, builtin}` and `/files/skin/<path>` serves the current
skin's files by filename (case-insensitive, subfolders allowed), the way vosu
serves lazer's realm file store. Scenarios switch between a lazer skin with
files, a lazer built-in skin, and an older vosu without the report.

Run after `bun run build` in tools/map-preview/web:
  uv run --with playwright python tools/map-preview/tests/skin_e2e.py MAP.osu AUDIO SKIN_DIR [EVIDENCE_DIR]
Needs hardware WebGPU in headless Chromium (Vulkan); verified on NVIDIA.
"""
import asyncio
import re
import json
import mimetypes
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

BRIDGE = """
const fragment = new URLSearchParams(location.hash.slice(1));
const theme = fragment.get('theme');
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: {id: 'map-preview', name: 'Map preview', version: '0.1.0'},
  canWrite: false,
  dashboardUrl: 'http://127.0.0.1:25651',
  colorScheme: ['dark', 'light'].includes(theme) ? theme
    : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  fetch: () => Promise.reject(new Error('Map preview has no service')),
  subscribe: () => () => {},
});
"""


class Host:
    def __init__(self, beatmap: Path, audio: Path, skin: Path):
        self.beatmap = beatmap.read_bytes()
        self.audio = audio.read_bytes()
        self.skin = {p.relative_to(skin).as_posix().lower(): p for p in skin.rglob('*') if p.is_file()}
        self.report = None
        self.report_status = 200
        self.requests: list[str] = []


def handler(host: Host):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body: bytes, kind='application/octet-stream'):
            # Media elements only seek within resources served with byte ranges.
            span = re.fullmatch(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
            total = len(body)
            if status == 200 and span:
                start = int(span[1])
                end = int(span[2]) if span[2] else total - 1
                body = body[start:end + 1]
                status = 206
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Accept-Ranges', 'bytes')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{start + len(body) - 1}/{total}')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            host.requests.append(path)
            if path == '/tools/_host/v1/bridge.js':
                return self.send(200, BRIDGE.encode(), 'text/javascript')
            if path.startswith('/tools/map-preview/'):
                relative = path.removeprefix('/tools/map-preview/') or 'index.html'
                file = (DIST / relative).resolve()
                if DIST.resolve() in file.parents and file.is_file():
                    kind = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
                    return self.send(200, file.read_bytes(), kind)
                return self.send(404, b'not found', 'text/plain')
            if path == '/files/beatmap/file':
                return self.send(200, host.beatmap, 'text/plain; charset=utf-8')
            if path == '/files/beatmap/audio':
                return self.send(200, host.audio, 'audio/mpeg')
            if path == '/files/skin/':
                if host.report_status != 200:
                    return self.send(host.report_status, b'not found', 'text/plain')
                return self.send(200, json.dumps(host.report).encode(), 'application/json')
            if path.startswith('/files/skin/'):
                name = unquote(path.removeprefix('/files/skin/')).lower()
                file = host.skin.get(name) if host.report and host.report.get('files') else None
                if file:
                    return self.send(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
                return self.send(404, b'{"error":"not found"}', 'application/json')
            return self.send(404, b'not found', 'text/plain')

    return Handler


async def browser_checks(host: Host, skin_dir: Path, evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME),
            headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'],
        )

        async def open_page(theme: str, width=1440, height=980):
            page = await browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            # Headless Chromium can answer the very first requestAdapter() with
            # null ("A valid external Instance reference no longer exists");
            # the second request succeeds. Harness-only retry.
            await page.add_init_script(
                '{ const request = GPU.prototype.requestAdapter;'
                ' GPU.prototype.requestAdapter = async function (options) {'
                ' return (await request.call(this, options)) ?? request.call(this, options); }; }')
            page.on('pageerror', lambda error: errors.append(str(error)))
            # Skins lack many optional elements; those probes are expected 404s.
            page.on('console', lambda message: message.type == 'error'
                    and 'status of 404' not in message.text
                    and 'external Instance reference' not in message.text
                    and errors.append(message.text))
            # Headless screenshots cannot see a canvas's direct WebGPU swapchain;
            # the documented bitmap presentation exists for capture environments.
            await page.goto(f'{ORIGIN}/tools/map-preview/?presentation=bitmap#theme={theme}')
            try:
                await page.locator('#mode[data-mode="0"]').wait_for(timeout=30000)
            except Exception:
                await page.screenshot(path=str(evidence / 'failed-load.png'))
                raise AssertionError(f"map did not load: {await page.locator('#status').inner_text()!r} {errors}")
            return page

        async def seek(page, ms: int):
            await page.evaluate(
                """ms => { const s = document.querySelector('#seek'); s.value = String(ms);
                s.dispatchEvent(new Event('input')); }""",
                ms,
            )
            await page.wait_for_timeout(400)

        async def shows(page, selector: str, text: str, timeout=60000):
            try:
                await page.wait_for_function(
                    '([s, t]) => document.querySelector(s)?.textContent.includes(t)', arg=[selector, text], timeout=timeout)
            except Exception:
                await page.screenshot(path=str(evidence / 'failed-step.png'))
                actual = await page.locator(selector).text_content()
                raise AssertionError(f'{selector} should contain {text!r}, has {actual!r}; errors {errors}')

        # 1. lazer current skin with files: loaded by filename from the host.
        host.report = {'client': 'lazer', 'name': 'Ralsei', 'files': True, 'builtin': None}
        host.requests.clear()
        page = await open_page('dark')
        await shows(page, '#skin-source', 'lazer · current skin')
        served = [r for r in host.requests if r.startswith('/files/skin/') and r != '/files/skin/']
        assert '/files/skin/' in host.requests, host.requests
        assert any(r.lower() == '/files/skin/skin.ini' for r in served), served
        assert any('hitcircle' in r.lower() for r in served), served
        assert await page.locator('#skin-name').inner_text() == 'Ralsei'
        assert await page.evaluate("getComputedStyle(document.documentElement).colorScheme") == 'dark'
        await seek(page, 38000)
        await page.screenshot(path=str(evidence / 'lazer-current-skin-dark.png'))
        skinned = await page.locator('canvas').screenshot()

        # 2. lazer built-in skin: defaults, said plainly.
        host.report = {'client': 'lazer', 'name': 'Argon', 'files': False, 'builtin': 'argon'}
        await page.locator('#current-skin').click()
        await shows(page, '#skin-message', 'lazer built-in skin “Argon”: using default elements')
        assert await page.locator('#skin-name').inner_text() == 'Default elements'
        await seek(page, 38000)
        await page.screenshot(path=str(evidence / 'lazer-builtin-fallback-dark.png'))
        defaults = await page.locator('canvas').screenshot()
        assert defaults != skinned, 'the playfield must change from the lazer skin to default elements'

        # 3. vosu reports the skin's files as unavailable.
        host.report = {'client': 'lazer', 'name': 'Ralsei', 'files': False, 'builtin': None}
        await page.locator('#current-skin').click()
        await shows(page, '#skin-message', 'vosu reports that the files of “Ralsei” are unavailable')

        # 4. Older vosu without the skin report.
        host.report_status = 404
        await page.locator('#current-skin').click()
        await shows(page, '#skin-message', 'does not report the current skin')
        await page.screenshot(path=str(evidence / 'older-vosu-fallback-dark.png'))
        host.report_status = 200

        # 5. .osk file, wrapped in a folder as some exporters do.
        osk = skin_dir.parent / 'Ralsei.osk'
        with zipfile.ZipFile(osk, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(skin_dir.rglob('*')):
                if file.is_file():
                    archive.write(file, 'Ralsei/' + file.relative_to(skin_dir).as_posix())
        await page.locator('#skin-osk').set_input_files(str(osk))
        await shows(page, '#skin-source', '.osk file')
        await shows(page, '#skin-message', 'Loaded “Ralsei”')
        await seek(page, 38000)
        await page.screenshot(path=str(evidence / 'osk-skin-dark.png'))
        assert await page.locator('canvas').screenshot() != defaults, 'the .osk skin must reach the playfield'
        await page.close()

        # 6. Light scheme follows the dashboard hint, with the lazer skin.
        host.report = {'client': 'lazer', 'name': 'Ralsei', 'files': True, 'builtin': None}
        page = await open_page('light')
        await shows(page, '#skin-source', 'lazer · current skin')
        assert await page.evaluate("getComputedStyle(document.documentElement).colorScheme") == 'light'
        await page.locator('#mods label', has_text='Hidden').click()
        await seek(page, 38000)
        await page.screenshot(path=str(evidence / 'lazer-current-skin-light.png'))
        await page.close()

        # 7. Narrow layout, light.
        page = await open_page('light', 760, 1400)
        await shows(page, '#skin-source', 'lazer · current skin')
        await seek(page, 52000)
        await page.screenshot(path=str(evidence / 'narrow-light.png'), full_page=True)
        await page.close()
        await browser.close()
    assert not errors, errors


def main():
    beatmap, audio, skin = map(Path, sys.argv[1:4])
    evidence = Path(sys.argv[4]) if len(sys.argv) > 4 else Path('/tmp/vosu-r2-evidence/ToolMapPreview')
    evidence.mkdir(parents=True, exist_ok=True)
    if not (DIST / 'index.html').is_file():
        sys.exit('Build the UI first: (cd tools/map-preview/web && bun run build)')
    with tempfile.TemporaryDirectory(prefix='map-preview-skin-e2e-') as directory:
        # Work on copies; never serve the user's osu! folders directly.
        temp = Path(directory)
        skin_copy = temp / 'skin'
        shutil.copytree(skin, skin_copy)
        shutil.copy(beatmap, temp / 'map.osu')
        shutil.copy(audio, temp / 'audio')
        host = Host(temp / 'map.osu', temp / 'audio', skin_copy)
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler(host))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            asyncio.run(browser_checks(host, skin_copy, evidence))
        finally:
            server.shutdown()
    print(f'skin e2e passed; screenshots in {evidence}')


if __name__ == '__main__':
    main()
