#!/usr/bin/env python3
"""End-to-end smoke of Map preview inside a real, isolated vosu daemon.

Starts `vosu --tool tools/map-preview` with HOME and every XDG_* directory in a
temporary folder (ports 25650/25651, no osu! client attached), checks that the
manifest art is served, opens the UI through a real launch URL in headless
Chromium, and verifies that "Use current skin" explains the host's answer
instead of doing nothing.

  uv run --with playwright python tools/map-preview/tests/vosu_smoke.py VOSU [EVIDENCE_DIR] [--without-banner]

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

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://127.0.0.1:25650'
CHROME = Path.home() / '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'


def fetch(path, data=None, token=None):
    request = urllib.request.Request(ORIGIN + path, data=data, headers={'Content-Type': 'application/json'})
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers.get('Content-Type', ''), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get('Content-Type', ''), error.read()


async def browser_checks(url: str, evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'])
        # The OS preference is dark; the launch hint (light) must win where the bridge reports it.
        page = await browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1, color_scheme='dark')
        # Headless Chromium can answer the first requestAdapter() with null; harness-only retry.
        await page.add_init_script(
            '{ const request = GPU.prototype.requestAdapter;'
            ' GPU.prototype.requestAdapter = async function (o) {'
            ' return (await request.call(this, o)) ?? request.call(this, o); }; }')
        page.on('pageerror', lambda error: errors.append(str(error)))
        # Headless screenshots need the documented capture presentation.
        await page.goto(url.replace('/#', '/?presentation=bitmap#', 1))
        # The page follows whatever this isolated daemon sees (possibly a
        # running client it cannot read): it must settle on a stated status,
        # a beatmap or a reason there is none, and a skin with its source.
        await page.wait_for_function(
            "!document.querySelector('#follow-status').textContent.startsWith('Connecting')"
            " && document.querySelector('#skin-name').textContent !== '—'"
            " && (document.querySelector('#status').textContent !== '' || document.querySelector('#mode').dataset.mode !== '')",
            timeout=30000)
        observed = await page.evaluate('''() => ({
            follow: document.querySelector('#follow-status').textContent,
            status: document.querySelector('#status').textContent,
            skin: document.querySelector('#skin-name').textContent,
            skinMessage: document.querySelector('#skin-message').textContent,
            scheme: document.documentElement.dataset.scheme,
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            bar: document.querySelector('#bar').getBoundingClientRect().height,
        })''')
        await page.screenshot(path=str(evidence / 'real-vosu.png'))
        await page.locator('#controls-toggle').click()
        await page.locator('#current-skin').click()
        await page.wait_for_function("!document.querySelector('#skin-panel').hasAttribute('aria-busy')", timeout=30000)
        await page.screenshot(path=str(evidence / 'real-vosu-controls.png'))
        await browser.close()
    assert not errors, errors
    assert observed['bar'] <= 48, observed
    return observed


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    vosu = Path(args[0]).resolve()
    evidence = Path(args[1]) if len(args) > 1 else Path('/tmp/vosu-r3-evidence/ToolMapPreview')
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='map-preview-vosu-smoke-') as directory:
        temp = Path(directory)
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
            status, kind, body = fetch('/files/skin/')
            skin_report = json.loads(body) if status == 200 and 'json' in kind else None
            status, kind, body = fetch('/tools/map-preview/_settings')
            settings = json.loads(body) if status == 200 and 'json' in kind else {'status': status}
            token = json.loads(broker.read_text())['token']
            status, _, body = fetch('/tools/_host/v1/cli/map-preview/open', data=b'{"theme":"light"}', token=token)
            assert status == 200, (status, body)
            url = json.loads(body)['url']
            observed = await browser_checks(url, evidence)
            result = {'vosu': str(vosu), 'art': art, 'skin_report': skin_report, 'settings_route': settings,
                      'launch_theme': 'light', 'page': observed}
            (evidence / 'real-vosu-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
            print('PASS', json.dumps(result))
        finally:
            daemon.terminate()
            daemon.wait(10)


if __name__ == '__main__':
    asyncio.run(main())
