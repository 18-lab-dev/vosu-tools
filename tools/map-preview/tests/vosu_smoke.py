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


async def browser_checks(url: str, evidence: Path, skin_report):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=str(CHROME), headless=True)
        # The OS preference is dark; the launch hint (light) must win where the bridge reports it.
        page = await browser.new_page(viewport={'width': 1440, 'height': 980}, device_scale_factor=1, color_scheme='dark')
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(url)
        # No osu! client is attached, so there is no selected beatmap either.
        await page.wait_for_function("document.querySelector('#status').textContent.includes('No selected beatmap')", timeout=30000)
        expected = ('No osu! client is connected' if skin_report is not None
                    else 'does not report the current skin')
        await page.wait_for_function(
            '([t]) => document.querySelector("#skin-message").textContent.includes(t)', arg=[expected], timeout=30000)
        scheme = await page.evaluate('document.documentElement.dataset.scheme')
        color_scheme = await page.evaluate('getComputedStyle(document.documentElement).colorScheme')
        await page.screenshot(path=str(evidence / 'real-vosu-light.png'))
        await page.locator('#current-skin').click()
        await page.wait_for_function(
            '([t]) => document.querySelector("#skin-message").textContent.includes(t)', arg=[expected], timeout=30000)
        await browser.close()
    assert not errors, errors
    return scheme, color_scheme


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    vosu = Path(args[0]).resolve()
    evidence = Path(args[1]) if len(args) > 1 else Path('/tmp/vosu-r2-evidence/ToolMapPreview')
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
            token = json.loads(broker.read_text())['token']
            status, _, body = fetch('/tools/_host/v1/cli/map-preview/open', data=b'{"theme":"light"}', token=token)
            assert status == 200, (status, body)
            url = json.loads(body)['url']
            scheme, color_scheme = await browser_checks(url, evidence, skin_report)
            result = {'vosu': str(vosu), 'art': art, 'skin_report': skin_report, 'launch_theme': 'light',
                      'data_scheme': scheme, 'color_scheme': color_scheme}
            (evidence / 'real-vosu-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
            print('PASS', json.dumps(result))
        finally:
            daemon.terminate()
            daemon.wait(10)


if __name__ == '__main__':
    asyncio.run(main())
