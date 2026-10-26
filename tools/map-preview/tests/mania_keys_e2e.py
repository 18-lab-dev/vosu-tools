#!/usr/bin/env python3
"""Headless check that Map preview decodes mania skin images per key count.

Uses the stand-in vosu host from preview_e2e.py: the client's skin (lazer,
files available) is shown while the game moves from a 4K mania map to a 7K
one and back. Reports the GPU texture memory the page holds at each key
count and how long a switch takes from the map change to the new key
count's skin being installed (unthrottled), then repeats each switch with
skin files served late (250 ms, or twice a canvas capture on a slow
rasteriser) and screenshots the canvas throughout: while
the new key count loads the previous scene stays drawn, so every frame must
be the old scene or the finished new one (no built-in fallback flash).

Both maps are shown at the same game time MS (pick one where both have notes).

Run after `bun run build` in tools/map-preview/web:
  uv run --with playwright --with pillow python tools/map-preview/tests/mania_keys_e2e.py \
    MAP4K.osu MAP7K.osu MS SKIN_DIR EVIDENCE_DIR
Maps and the skin are read-only: everything is copied to a temporary folder first.
"""

import asyncio
import io
import json
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_e2e import CHROME, CHROME_ARGS, DIST, ORIGIN, PORT, QUERY, Game, Host, handler  # noqa: E402

def distance(a: bytes, b: bytes) -> float:
    """Mean absolute difference (0-255) of two screenshots, on a 192 px wide greyscale copy."""
    from PIL import Image, ImageChops, ImageStat

    def small(png: bytes):
        image = Image.open(io.BytesIO(png)).convert('L')
        return image.resize((192, max(1, image.height * 192 // image.width)))
    return ImageStat.Stat(ImageChops.difference(small(a), small(b))).mean[0]


# Live GPU texture memory and when skin atlases are built: the atlas is the
# sampled rgba8unorm array texture; render-core's frame table (rgba32float,
# 16 bytes a texel) is sampled too but is not an atlas.
TRACKING = '''{
  const live = new Map();
  window.__atlases = [];
  window.__textureMB = () => [...live.values()].reduce((a, b) => a + b, 0) / 2 ** 20;
  const create = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (descriptor) {
    const texture = create.call(this, descriptor);
    const size = [...descriptor.size];
    const texel = descriptor.format === "rgba32float" ? 16 : 4;
    live.set(texture, size[0] * (size[1] ?? 1) * (size[2] ?? 1) * texel);
    if (descriptor.usage & GPUTextureUsage.TEXTURE_BINDING && descriptor.format === "rgba8unorm")
      window.__atlases.push({ at: performance.now(), layers: size[2] ?? 1, size });
    return texture;
  };
  const destroy = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function () {
    live.delete(this);
    return destroy.call(this);
  };
  const request = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = async function (o) {
    return (await request.call(this, o)) ?? request.call(this, o);
  };
}'''


async def run(host: Host, time: float, skin: str, evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    result = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=CHROME_ARGS)
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        await page.add_init_script(TRACKING)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda m: m.type == 'error' and 'status of 404' not in m.text
                and 'external Instance reference' not in m.text and errors.append(m.text))
        game = Game()
        await page.route_web_socket('**/websocket/v2/subscribe', game.route)
        host.skin = skin
        host.report = {'client': 'lazer', 'name': skin, 'files': True, 'builtin': None, 'base': 'legacy'}
        host.beatmap = '4k'
        game.set('/folders/skin', skin)
        game.set('/beatmap/time', {'live': time, 'rate': 1, 'running': False})
        game.set('/beatmap/mode/number', 3)
        game.set('/settings/mode/number', 3)
        game.set('/beatmap/checksum', '4k')
        await page.goto(f'{ORIGIN}/tools/map-preview/?{QUERY}#theme=dark')

        async def shows(selector, text, timeout=60000):
            await page.wait_for_function('([s, t]) => document.querySelector(s)?.textContent.includes(t)',
                                         arg=[selector, text], timeout=timeout)

        async def settle():
            # The skin's atlas count stops changing once the key count is loaded.
            previous = -1
            while True:
                await page.wait_for_timeout(700)
                count = await page.evaluate('window.__atlases.length')
                if count == previous:
                    return
                previous = count

        await shows('#skin-source', 'lazer · current skin')
        await shows('#detail', '4K')
        await settle()
        result['4k'] = {'textureMB': await page.evaluate('window.__textureMB()')}
        await page.screenshot(path=str(evidence / '4k-1920x1080.png'))

        async def switch(key: str):
            atlases = await page.evaluate('window.__atlases.length')
            start = await page.evaluate('performance.now()')
            host.beatmap = key
            game.set('/beatmap/checksum', key)
            frames = []
            while True:
                frames.append(await page.locator('canvas').screenshot())
                built = await page.evaluate(f'window.__atlases.slice({atlases})')
                detail = await page.evaluate("document.querySelector('#detail').textContent")
                if built and key.upper() in detail:
                    break
                assert len(frames) < 400, f'switch to {key} never finished'
            await settle()
            return built[0]['at'] - start, len(built), frames

        # Each skin file is held long enough for several canvas captures to
        # land inside the switch, also on a slow rasteriser (SwiftShader).
        began = asyncio.get_running_loop().time()
        await page.locator('canvas').screenshot()
        hold = max(0.25, 2 * (asyncio.get_running_loop().time() - began))

        async def slow(route):
            await asyncio.sleep(hold)
            await route.continue_()

        for key, other in [('7k', '4k'), ('4k', '7k'), ('7k', '4k'), ('4k', '7k')]:
            throttled = 'switchMs' in result.get(f'{other}->{key}', {})
            old = await page.locator('canvas').screenshot()
            if throttled:
                await page.route('**/files/skin/**', slow)
            ms, built, frames = await switch(key)
            if throttled:
                await page.unroute('**/files/skin/**', slow)
            new = await page.locator('canvas').screenshot()
            name = f'{other}->{key}'
            if not throttled:
                result[name] = {'switchMs': ms, 'atlasesBuilt': built}
                result[key] = {'textureMB': await page.evaluate('window.__textureMB()')}
                await page.screenshot(path=str(evidence / f'{key}-after-{other}-1920x1080.png'))
                continue
            # Every frame while the slow switch loads is the old scene or the new
            # one (animated elements such as receptors may differ slightly).
            def kind(frame: bytes) -> str:
                to_old, to_new = distance(frame, old), distance(frame, new)
                if min(to_old, to_new) > 1.0:
                    return 'other'
                return 'old' if to_old <= to_new else 'new'
            kinds = [kind(f) for f in frames]
            (evidence / f'switch-{other}-{key}-old.png').write_bytes(old)
            (evidence / f'switch-{other}-{key}-new.png').write_bytes(new)
            for i, (frame, kind) in enumerate(zip(frames, kinds)):
                (evidence / f'switch-{other}-{key}-{i:03d}-{kind}.png').write_bytes(frame)
            result[name].update({'throttledSwitchMs': ms, 'framesDuringSwitch': len(frames),
                                 'oldFrames': kinds.count('old'), 'otherFrames': kinds.count('other')})
            assert 'other' not in kinds, f'{name}: a frame showed neither scene'
            assert kinds.count('old') > 1, f'{name}: the throttled switch was not observed'
        await browser.close()
    assert not errors, errors
    return result


def main():
    map_args, time = sys.argv[1:3], float(sys.argv[3])
    skin_dir, evidence = Path(sys.argv[4]), Path(sys.argv[5])
    evidence.mkdir(parents=True, exist_ok=True)
    if not (DIST / 'index.html').is_file():
        sys.exit('Build the UI first: (cd tools/map-preview/web && bun run build)')
    with tempfile.TemporaryDirectory(prefix='map-preview-mania-keys-') as directory:
        temp = Path(directory)
        paths = {}
        for key, source in zip(('4k', '7k'), map_args):
            paths[key] = temp / f'{key}.osu'
            shutil.copy(source, paths[key])
        skin = 'skin'
        shutil.copytree(skin_dir, temp / skin)
        host = Host(paths, {skin: temp / skin})
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler(host))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            result = asyncio.run(run(host, time, skin, evidence))
        finally:
            server.shutdown()
    (evidence / 'mania-keys.json').write_text(json.dumps(result, indent=2) + '\n')
    print('mania keys e2e passed:', json.dumps(result))


if __name__ == '__main__':
    main()
