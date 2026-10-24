#!/usr/bin/env python3
"""End-to-end smoke of Map preview inside a real, isolated vosu daemon.

Starts `vosu --tool tools/map-preview` with HOME and every XDG_* directory in a
temporary folder (ports 25650/25651, no osu! client attached), checks that the
manifest art is served, opens the UI through real launch URLs in headless
Chromium, and verifies the app layout against vosu's own theme: in both
schemes at 1920×1080, 2560×1440, 1280×720 and 960×1080 the page never scrolls
and nothing overflows sideways, with the drawer closed and open. Later loads of
a scheme run without a launch code, as read-only tabs. With `--map=FILE`, a
copy of that .osu is opened in manual mode so the screenshots show a playfield.
"Use client skin" must explain the host's answer instead of doing nothing.

  unshare -rn sh -c 'ip link set lo up && uv run --offline --with playwright python \\
    tools/map-preview/tests/vosu_smoke.py VOSU [EVIDENCE_DIR] [--map=FILE] [--without-banner]'

`--without-banner` drops the manifest `banner` key for hosts that predate it.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from preview_e2e import CHROME, CONTROLS_KEY, playfield_unblocked, set_controls

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://127.0.0.1:25650'
SIZES = [(1920, 1080), (2560, 1440), (1280, 720), (960, 1080)]
FITS = '''() => {
    const out = [];
    for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 0.5) out.push(e.id || e.className || e.tagName);
    }
    return { scroll: document.scrollingElement.scrollHeight, height: innerHeight,
             wide: document.scrollingElement.scrollWidth, width: innerWidth, out };
}'''


def fetch(path, data=None, token=None):
    request = urllib.request.Request(ORIGIN + path, data=data, headers={'Content-Type': 'application/json'})
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers.get('Content-Type', ''), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Content-Type', ''), error.read()


async def browser_checks(launch, evidence: Path, map_file: Path | None):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    observed = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'])
        for theme in ('dark', 'light'):
            for index, (width, height) in enumerate(SIZES):
                # The OS preference is the opposite scheme: the launch hint must win.
                page = await browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1,
                                              color_scheme='light' if theme == 'dark' else 'dark')
                # Headless Chromium can answer the first requestAdapter() with null; harness-only retry.
                await page.add_init_script(
                    '{ const request = GPU.prototype.requestAdapter;'
                    ' GPU.prototype.requestAdapter = async function (o) {'
                    ' return (await request.call(this, o)) ?? request.call(this, o); }; }')
                page.on('pageerror', lambda error: errors.append(str(error)))
                # The first load of each scheme exchanges a launch code; later
                # loads have none and are read-only tabs.
                url = launch(theme) if index == 0 else f'{ORIGIN}/tools/map-preview/#theme={theme}'
                # Headless screenshots need the documented capture presentation.
                await page.goto(url.replace('/#', '/?presentation=bitmap#', 1))
                # The page follows whatever this isolated daemon sees (possibly a
                # running client it cannot read): it must settle on a stated status
                # and a skin with its source.
                await page.wait_for_function(
                    "!document.querySelector('#follow-status').textContent.startsWith('Connecting')"
                    " && document.querySelector('#skin-name').textContent !== '—'", timeout=30000)
                state = await page.evaluate('''() => ({
                    follow: document.querySelector('#follow-status').textContent,
                    dot: document.querySelector('#follow-dot').dataset.state ?? 'idle',
                    status: document.querySelector('#status').textContent,
                    skin: document.querySelector('#skin-name').textContent,
                    skinMessage: document.querySelector('#skin-message').textContent,
                    theme: document.documentElement.dataset.theme,
                    colorScheme: getComputedStyle(document.documentElement).colorScheme,
                    bar: document.querySelector('#bar').getBoundingClientRect().height,
                })''')
                state['canWrite'] = await page.evaluate(
                    "import('/tools/_host/v1/bridge.js').then(({ vosu }) => vosu.ready.then(() => vosu.canWrite))")
                assert state['theme'] == theme and theme in state['colorScheme'], state
                assert state['bar'] <= 48, state
                if map_file:
                    await page.locator('#map-file').set_input_files(str(map_file))
                    await page.wait_for_function("document.querySelector('#follow-status').textContent === 'Manual preview'"
                                                 " && document.querySelector('#mode').dataset.mode !== ''", timeout=30000)
                    await page.locator('#seek').evaluate(
                        "s => { s.value = String(Math.min(60000, Number(s.max) / 2)); s.dispatchEvent(new Event('input')); }")
                await page.wait_for_timeout(700)
                # The panel's open/closed choice persists across loads.
                stored = await page.evaluate(f"localStorage.getItem('{CONTROLS_KEY}')")
                expanded = await page.locator('#controls-toggle').get_attribute('aria-expanded')
                assert (expanded == 'true') == (stored == '1'), (stored, expanded)
                for drawer in ('closed', 'open'):
                    await set_controls(page, drawer == 'open')
                    if drawer == 'open':
                        assert await playfield_unblocked(page), f'controls cover the playfield at {width}'
                        if index == 0:
                            await page.locator('#current-skin').click()
                            await page.wait_for_function(
                                "!document.querySelector('#skin-panel').hasAttribute('aria-busy')", timeout=30000)
                            state['skinMessage'] = await page.locator('#skin-message').text_content()
                    await page.wait_for_timeout(300)
                    fit = await page.evaluate(FITS)
                    assert fit['scroll'] <= fit['height'], f'page scrolls at {width}x{height} {theme} {drawer}: {fit}'
                    assert fit['wide'] <= fit['width'] and not fit['out'], f'overflow at {width} {theme} {drawer}: {fit}'
                    await page.screenshot(path=str(evidence / f'real-vosu-{theme}-{width}x{height}-{drawer}.png'))
                observed[f'{theme}-{width}x{height}'] = state
                await page.close()
        await browser.close()
    assert not errors, errors
    return observed


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    options = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    vosu = Path(args[0]).resolve()
    evidence = Path(args[1]) if len(args) > 1 else Path('/tmp/vosu-r4-evidence/Style-map-preview')
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='map-preview-vosu-smoke-') as directory:
        temp = Path(directory)
        map_file = None
        if 'map' in options:
            map_file = temp / 'map.osu'
            shutil.copy(options['map'], map_file)
        env = dict(os.environ)
        env['HOME'] = str(temp)
        for key, folder in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache'),
                            ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'runtime')]:
            env[key] = str(temp / folder)
            (temp / folder).mkdir(mode=0o700)
        env.pop('DISPLAY', None)
        env.pop('WAYLAND_DISPLAY', None)
        config = temp / 'config/vosu'
        config.mkdir()
        (config / 'vosu.toml').write_text(
            'ENABLE_AUTOUPDATE = false\nOPEN_DASHBOARD_ON_STARTUP = false\nSTART_AT_LOGIN = false\n'
            'SERVER_IP = "127.0.0.1"\nSERVER_PORT = 25650.0\nDASHBOARD_IP = "127.0.0.1"\nDASHBOARD_PORT = 25651.0\n')
        tool = ROOT
        if '--without-banner' in sys.argv:
            tool = temp / 'map-preview'
            shutil.copytree(ROOT, tool, ignore=shutil.ignore_patterns('node_modules', 'tests'))
            manifest = tool / 'tool.toml'
            manifest.write_text(''.join(l for l in manifest.read_text().splitlines(True) if not l.startswith('banner')))
        log = (evidence / 'real-vosu-daemon.log').open('w')
        daemon = subprocess.Popen([str(vosu), '--tool', str(tool)], cwd=temp, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            broker = temp / 'runtime/vosu/broker.json'
            deadline = time.monotonic() + 30
            while not broker.exists():
                if daemon.poll() is not None:
                    raise RuntimeError('daemon exited; see real-vosu-daemon.log')
                if time.monotonic() > deadline:
                    raise TimeoutError('broker not ready')
                await asyncio.sleep(0.1)
            await asyncio.sleep(1)
            status, kind, icon = fetch('/tools/map-preview/_icon')
            assert status == 200 and 'svg' in kind and icon == (ROOT / 'art/icon.svg').read_bytes(), (status, kind)
            art = {'icon': status}
            if '--without-banner' not in sys.argv:
                status, kind, banner = fetch('/tools/map-preview/_banner')
                assert status == 200 and 'svg' in kind and banner == (ROOT / 'art/banner.svg').read_bytes(), (status, kind)
                art['banner'] = status
            status, kind, body = fetch('/tools/_host/v1/theme.css')
            assert status == 200 and 'css' in kind and b'.v-app' in body, (status, kind)
            status, kind, body = fetch('/files/skin/')
            skin_report = json.loads(body) if status == 200 and 'json' in kind else None
            status, kind, body = fetch('/tools/map-preview/_settings')
            settings = json.loads(body) if status == 200 and 'json' in kind else {'status': status}
            token = json.loads(broker.read_text())['token']

            def launch(theme: str) -> str:
                status, _, body = fetch('/tools/_host/v1/cli/map-preview/open',
                                        data=json.dumps({'theme': theme}).encode(), token=token)
                assert status == 200, (status, body)
                return json.loads(body)['url']

            observed = await browser_checks(launch, evidence, map_file)
            result = {'vosu': str(vosu), 'art': art, 'skin_report': skin_report, 'settings_route': settings,
                      'pages': observed}
            (evidence / 'real-vosu-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
            print('PASS', json.dumps(result)[:1200])
        finally:
            daemon.terminate()
            daemon.wait(10)


if __name__ == '__main__':
    asyncio.run(main())
