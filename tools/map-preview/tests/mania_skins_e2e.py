#!/usr/bin/env python3
"""Headless screenshots of legacy mania skins in Map preview, up- and downscroll.

Uses the stand-in vosu host from preview_e2e.py: the game follows a 4K and a
7K mania map at a moment with held notes, the client's skin is served by
filename (lazer, files available), and the client's scroll direction flips.
Every page must show the skin, render without errors, and draw a playfield
that differs between the two directions.

Run after `bun run build` in tools/map-preview/web:
  uv run --with playwright python tools/map-preview/tests/mania_skins_e2e.py \
    MAP4K.osu@MS MAP7K.osu@MS EVIDENCE_DIR NAME=SKIN_DIR...
Maps and skins are read-only: everything is copied to a temporary folder first.
"""

import asyncio
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_e2e import CHROME, DIST, ORIGIN, PORT, QUERY, Game, Host, handler  # noqa: E402


async def capture(host: Host, maps: dict, skins: list[str], evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'])
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        await page.add_init_script(
            '{ const request = GPU.prototype.requestAdapter;'
            ' GPU.prototype.requestAdapter = async function (o) {'
            ' return (await request.call(this, o)) ?? request.call(this, o); }; }')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda m: m.type == 'error' and 'status of 404' not in m.text
                and 'external Instance reference' not in m.text and errors.append(m.text))
        page.on('requestfailed', lambda r: errors.append(f'{r.failure} {r.url}'))
        game = Game()
        await page.route_web_socket('**/websocket/v2/subscribe', game.route)
        await page.goto(f'{ORIGIN}/tools/map-preview/?{QUERY}#theme=dark')

        async def shows(selector, text, timeout=60000):
            await page.wait_for_function('([s, t]) => document.querySelector(s)?.textContent.includes(t)',
                                         arg=[selector, text], timeout=timeout)

        shots = []
        for key, (_, time) in maps.items():
            host.beatmap = key
            game.set('/beatmap/time', {'live': time, 'rate': 1, 'running': False})
            game.set('/beatmap/mode/number', 3)
            game.set('/settings/mode/number', 3)
            game.set('/beatmap/checksum', key)
            await shows('#mode', 'mania')
            for skin in skins:
                host.skin = skin
                host.report = {'client': 'lazer', 'name': skin, 'files': True, 'builtin': None, 'base': 'legacy'}
                game.set('/folders/skin', f'{skin}-{key}')
                await shows('#skin-name', skin)
                await shows('#skin-source', 'lazer · current skin')
                frames = []
                for number, direction in [(1, 'down'), (0, 'up')]:
                    game.set('/settings/mania', {'scrollSpeed': 24, 'scrollSpeedValue': 24.0,
                                                 'scrollDirection': {'number': number, 'name': direction}})
                    await page.wait_for_timeout(900)
                    name = f'{key}-{skin}-{direction}scroll-1920x1080.png'
                    await page.screenshot(path=str(evidence / name))
                    frames.append(await page.locator('canvas').screenshot())
                    shots.append(name)
                assert frames[0] != frames[1], f'{skin} {key}: scroll direction must change the playfield'
        await browser.close()
    assert not errors, errors
    return shots


def main():
    map_args, evidence, skin_args = sys.argv[1:3], Path(sys.argv[3]), sys.argv[4:]
    evidence.mkdir(parents=True, exist_ok=True)
    if not (DIST / 'index.html').is_file():
        sys.exit('Build the UI first: (cd tools/map-preview/web && bun run build)')
    with tempfile.TemporaryDirectory(prefix='map-preview-mania-skins-') as directory:
        temp = Path(directory)
        maps, paths = {}, {}
        for key, arg in zip(('4k', '7k'), map_args):
            source, time = arg.rsplit('@', 1)
            paths[key] = temp / f'{key}.osu'
            shutil.copy(source, paths[key])
            maps[key] = (paths[key], float(time))
        skins = {}
        for arg in skin_args:
            name, folder = arg.split('=', 1)
            skins[name] = temp / name
            shutil.copytree(folder, skins[name])
        host = Host(paths, skins)
        host.beatmap = '4k'
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler(host))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            shots = asyncio.run(capture(host, maps, list(skins), evidence))
        finally:
            server.shutdown()
    print(f'mania skins e2e passed: {len(shots)} screenshots in {evidence}')


if __name__ == '__main__':
    main()
