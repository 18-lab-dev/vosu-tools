#!/usr/bin/env python3
"""render-core slider bodies on a real rasteriser, against osu!lazer.

The CPU golden test (packages/render-core/test/sliderBody.test.ts) checks the
arithmetic; this checks what a GPU, or SwiftShader, actually draws. Build the
backend parity page, then run:
  (cd tools/map-preview/web && bunx vite build --config ../tests/parity/vite.config.ts --outDir /tmp/mp-parity-dist)
  uv run --with playwright python tools/map-preview/tests/slider_bodies_e2e.py /tmp/mp-parity-dist EVIDENCE_DIR

Each of the 72 golden slider bodies (tight S curves, loops, repeats; CS 4 and
6; a skin's slider colours and the classic skin; fully shown, snaking in while
fading in, and snaking out) is drawn by both backends at
1920x1080 and compared per pixel with lazer's, rebuilt from the fixture: the
body's mean error must stay under 2/255 and its 99th percentile under 16/255.
MAP_PREVIEW_RASTERISER=swiftshader runs Chromium on SwiftShader (no GPU), as
machines without one and the Replay renderer's headless exports do; otherwise
the hardware GPU is used. Results land in EVIDENCE_DIR/slider-bodies.json.
"""
import asyncio
import json
import mimetypes
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_e2e import CHROME, CHROME_ARGS, SWIFTSHADER  # noqa: E402

PORT = 25653
MEAN, P99 = 2, 16


def serve(dist: Path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            candidate = (dist / (path.removeprefix('/parity/') or 'index.html')).resolve()
            if not path.startswith('/parity/') or dist.resolve() not in candidate.parents or not candidate.is_file():
                self.send_response(404)
                self.end_headers()
                return
            body = candidate.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def run() -> dict:
    from playwright.async_api import async_playwright
    results = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=str(CHROME), headless=True, args=CHROME_ARGS)
        for backend in ('webgpu', 'webgl2'):
            page = await browser.new_page()
            errors: list[str] = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.add_init_script(
                '{ const r = GPU.prototype.requestAdapter; GPU.prototype.requestAdapter = '
                'async function (o) { return (await r.call(this, o)) ?? r.call(this, o); }; }')
            await page.goto(f'http://127.0.0.1:{PORT}/parity/?backend={backend}')
            await page.wait_for_function('window.__ready', timeout=120000)
            ready = await page.evaluate('window.__ready')
            assert ready.get('backend') == backend, f'{backend}: {ready}'
            results[backend] = await page.evaluate('window.__bodies()')
            assert not errors, errors
            await page.close()
        await browser.close()
    return results


def main():
    dist, evidence = Path(sys.argv[1]), Path(sys.argv[2])
    evidence.mkdir(parents=True, exist_ok=True)
    server = serve(dist)
    try:
        results = asyncio.run(run())
    finally:
        server.shutdown()
    (evidence / 'slider-bodies.json').write_text(json.dumps(results, indent=2) + '\n')
    failed = []
    for backend, cases in results.items():
        assert len(cases) == 72, f'{backend}: {len(cases)} cases'
        for c in cases:
            print(f"{backend:7} {c['name']:30} {c['pixels']:7} px  mean {c['mean']:5.2f}  p99 {c['p99']:3}  max {c['max']:3}")
            if c['pixels'] < 2000 or c['mean'] >= MEAN or c['p99'] >= P99:
                failed.append(f"{backend} {c['name']}")
    if failed:
        raise SystemExit(f'slider bodies differ from lazer: {", ".join(failed)}')
    rasteriser = 'SwiftShader' if SWIFTSHADER else 'the GPU'
    print(f'slider bodies e2e passed on {rasteriser}: 72 cases x 2 backends; evidence in {evidence}')


if __name__ == '__main__':
    main()
