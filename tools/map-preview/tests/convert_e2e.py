#!/usr/bin/env python3
"""Headless check that Map preview shows osu! maps converted as the client plays them.

Uses the stand-in vosu host from preview_e2e.py with a real osu! map (copied
to a temp dir first). The game's ruleset and mods are driven through the v2
subscription; the object counts asserted below are what osu!lazer's own
converter produces for this map (packages/ruleset-convert/test/reference),
so the page is shown to render lazer's conversion, key count and Dual Stages.

Run after `bun run build` in tools/map-preview/web:
  uv run --with playwright python tools/map-preview/tests/convert_e2e.py SONGS [EVIDENCE_DIR]
"""
import asyncio
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from preview_e2e import CHROME, CHROME_ARGS, DIST, MAPS, ORIGIN, PORT, QUERY, Game, Host, handler, playfield_unblocked, set_controls

# osu!lazer 2026.1005.0 converting Hikiray - Zero Two [Insane] (oracle output).
LAZER = {'taiko': 777, 'mania': (893, 7), 'mania4K': (784, 4), 'maniaDS': (881, 14)}


async def checks(host: Host, evidence: Path):
    from playwright.async_api import async_playwright

    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=CHROME_ARGS)

        async def open_page(game: Game, theme='dark', width=1920, height=1080):
            page = await browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            # Headless Chromium can answer the first requestAdapter() with null; harness-only retry.
            await page.add_init_script(
                '{ const request = GPU.prototype.requestAdapter;'
                ' GPU.prototype.requestAdapter = async function (o) {'
                ' return (await request.call(this, o)) ?? request.call(this, o); }; }')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('console', lambda m: m.type == 'error' and 'status of 404' not in m.text
                    and 'external Instance reference' not in m.text and errors.append(m.text))
            await page.route_web_socket('**/websocket/v2/subscribe', game.route)
            await page.goto(f'{ORIGIN}/tools/map-preview/?{QUERY}#theme={theme}')
            return page

        async def shows(page, selector, text, timeout=30000):
            try:
                await page.wait_for_function('([s, t]) => document.querySelector(s)?.textContent.includes(t)',
                                             arg=[selector, text], timeout=timeout)
            except Exception:
                await page.screenshot(path=str(evidence / 'failed-step.png'))
                actual = await page.locator(selector).text_content()
                raise AssertionError(f'{selector} should contain {text!r}, has {actual!r}; errors {errors}')

        async def converted(page) -> bool:
            return await page.locator('#mode').evaluate('m => "convert" in m.dataset')

        async def playfield(page):
            await page.wait_for_timeout(700)
            return await page.locator('canvas').screenshot()

        game = Game()
        page = await open_page(game)
        await shows(page, '#title', 'Hikiray')
        await shows(page, '#mode', 'osu!')
        assert not await converted(page)
        original = await playfield(page)

        # 1. The client plays the osu! map in taiko: lazer's hits, drum rolls and swells.
        game.set('/settings/mode/number', 1)
        await shows(page, '#mode', 'taiko')
        await shows(page, '#detail', f"{LAZER['taiko']} objects · converted from osu!")
        assert await converted(page)
        taiko = await playfield(page)
        await page.screenshot(path=str(evidence / 'follow-taiko-convert-1920x1080.png'))

        # 2. Mania: lazer's key count, then a key mod, then Dual Stages.
        game.set('/settings/mode/number', 3)
        count, keys = LAZER['mania']
        await shows(page, '#detail', f'{count} objects · {keys}K · converted from osu!')
        mania = await playfield(page)
        await page.screenshot(path=str(evidence / 'follow-mania-convert-7K-1920x1080.png'))
        game.set('/play/mods/array', [{'acronym': '4K'}])
        count, keys = LAZER['mania4K']
        await shows(page, '#detail', f'{count} objects · {keys}K')
        await page.screenshot(path=str(evidence / 'follow-mania-convert-4K-1920x1080.png'))
        game.set('/play/mods/array', [{'acronym': 'DS'}])
        count, keys = LAZER['maniaDS']
        await shows(page, '#detail', f'{count} objects · {keys}K')
        await set_controls(page, True)
        assert await page.locator('#ruleset').input_value() == '3'
        assert await page.locator('#ruleset').is_disabled()
        assert await page.locator('#dual').is_checked()
        await shows(page, '#keys', 'Automatic (7K)')
        assert await page.locator('#dual ~ .v-help').get_attribute('data-tip') == 'Drawn as one wide stage.'
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(evidence / 'follow-mania-convert-DS-drawer-1920x1080.png'))
        await page.keyboard.press('Escape')

        # 3. Catch with Hard Rock: the same objects, lazer's fruits and offsets.
        game.set('/play/mods/array', [{'acronym': 'HR'}])
        game.set('/settings/mode/number', 2)
        await shows(page, '#mode', 'catch')
        assert await converted(page)
        catch = await playfield(page)
        await page.screenshot(path=str(evidence / 'follow-catch-convert-HR-1920x1080.png'))
        assert len({original, taiko, mania, catch}) == 4, 'each ruleset must render differently'

        # 4. Manual preview: the drawer chooses the ruleset and the key count.
        game.set('/play/mods/array', [])
        await page.locator('#map-file').set_input_files(str(host.maps['osu']))
        await shows(page, '#follow-status', 'Manual preview')
        # The ruleset last followed carries over; the drawer can change it.
        await shows(page, '#mode', 'catch')
        await set_controls(page, True)
        assert not await page.locator('#ruleset').is_disabled()
        assert await page.locator('#keys').is_disabled()
        await page.locator('#ruleset').select_option('3')
        count, keys = LAZER['mania']
        await shows(page, '#detail', f'{count} objects · {keys}K')
        assert await page.locator('#cs').is_disabled(), 'CS must not re-key a mania convert'
        await page.locator('#keys').select_option('4')
        count, keys = LAZER['mania4K']
        await shows(page, '#detail', f'{count} objects · {keys}K')
        await page.locator('#seek').evaluate("s => { s.value = '38000'; s.dispatchEvent(new Event('input')); }")
        await page.wait_for_timeout(700)
        await page.screenshot(path=str(evidence / 'manual-mania-convert-4K-drawer-1920x1080.png'))
        # Changes apply live beside the panel, which never covers the playfield.
        assert await playfield_unblocked(page)
        await page.locator('#ruleset').select_option('1')
        await shows(page, '#detail', f"{LAZER['taiko']} objects")
        assert await page.locator('#keys').is_disabled()
        await page.close()

        # 5. Light scheme, narrow width: the drawer's ruleset section stays usable.
        page = await open_page(game, 'light', 760, 900)
        game.set('/settings/mode/number', 3)
        await shows(page, '#detail', 'converted from osu!')
        await set_controls(page, True)
        await page.locator('#ruleset-heading').scroll_into_view_if_needed()
        await page.wait_for_timeout(700)
        scroll = await page.evaluate('[document.documentElement.scrollWidth, innerWidth]')
        assert scroll[0] <= scroll[1], f'horizontal overflow: {scroll}'
        await page.screenshot(path=str(evidence / 'follow-mania-convert-light-760x900.png'))
        await page.close()
        await browser.close()
    assert not errors, errors


def main():
    songs = Path(sys.argv[1])
    evidence = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('/tmp/vosu-r3-evidence/ToolMapPreview-converts')
    evidence.mkdir(parents=True, exist_ok=True)
    if not (DIST / 'index.html').is_file():
        sys.exit('Build the UI first: (cd tools/map-preview/web && bun run build)')
    with tempfile.TemporaryDirectory(prefix='map-preview-convert-e2e-') as directory:
        folder, name, _ = MAPS['osu']
        copy = Path(directory) / 'osu.osu'
        shutil.copy(songs / folder / name, copy)
        host = Host({'osu': copy}, {})
        server = ThreadingHTTPServer(('127.0.0.1', PORT), handler(host))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            asyncio.run(checks(host, evidence))
        finally:
            server.shutdown()
    print(f'map preview convert e2e passed; screenshots in {evidence}')


if __name__ == '__main__':
    main()
