#!/usr/bin/env python3
"""Render benchmark for Map preview on real maps and skins (headless Chromium).

Build the page, then run:
  (cd tools/map-preview/web && bunx vite build --config ../tests/perf/vite.config.ts --outDir /tmp/mp-perf-dist)
  uv run --with playwright python tools/map-preview/tests/perf_bench.py /tmp/mp-perf-dist SONGS SKINS [EVIDENCE_DIR]

Each case renders 600 measured frames at 1920x1080 (after 60 warm-up frames),
advancing 1/60 s per frame from a busy part of the map, and reports CPU time
per renderAt call, submit-to-GPU-done latency, and the GPU render pass time
from timestamp queries. Skin load time covers fetching and decoding every
element (files) or drawing them (built-ins). Inputs are temp copies.
"""
import asyncio
import json
import mimetypes
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_e2e import CHROME, MAPS, SKINS  # noqa: E402

PORT = 25650
CASES = [
    ('osu', 'builtin:argon'), ('osu', 'builtin:triangles'), ('osu', 'builtin:legacy'), ('osu', 'files:ralsei'),
    ('mania', 'builtin:argon'), ('mania', 'builtin:triangles'), ('mania', 'builtin:legacy'), ('mania', 'files:staircase'),
    ('taiko', 'builtin:argon'), ('taiko', 'builtin:legacy'), ('catch', 'builtin:argon'), ('catch', 'builtin:legacy'),
]


def serve(dist: Path, maps: dict, skins: dict):
    lookup = {name: {p.relative_to(d).as_posix().lower(): p for p in d.rglob('*') if p.is_file()} for name, d in skins.items()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            file = None
            if path.startswith('/perf/'):
                candidate = (dist / (path.removeprefix('/perf/') or 'index.html')).resolve()
                file = candidate if dist.resolve() in candidate.parents and candidate.is_file() else None
            elif path.startswith('/maps/'):
                file = maps.get(path.removeprefix('/maps/').removesuffix('.osu'))
            elif path.startswith('/skins/'):
                name, _, rest = path.removeprefix('/skins/').partition('/')
                file = lookup.get(name, {}).get(rest.lower())
            if not file:
                self.send_response(404)
                self.end_headers()
                return
            body = file.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def bench():
    from playwright.async_api import async_playwright

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
                  '--disable-vulkan-surface', '--disable-gpu-vsync', '--disable-frame-rate-limit'])
        for ruleset, skin in CASES:
            page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
            source = skin if skin.startswith('builtin:') else f'files:/skins/{skin[6:]}/'
            await page.goto(f'http://127.0.0.1:{PORT}/perf/?map=/maps/{ruleset}.osu&start={MAPS[ruleset][2]}&skin={source}')
            await page.wait_for_function('window.__perf', timeout=120000)
            result = await page.evaluate('window.__perf')
            assert 'error' not in result, result
            result.update({'ruleset': ruleset, 'skin': skin})
            results.append(result)
            gpu = result['gpuPass']
            print(f"{ruleset:6} {skin:18} objects {result['objects']:5}  skin {result['skinMs']:7.1f} ms  compile {result['compileMs']:6.1f} ms  "
                  f"cpu mean {result['cpu']['mean']:.3f} p95 {result['cpu']['p95']:.3f} ms  "
                  f"gpu pass mean {gpu['mean'] if gpu else float('nan'):.3f} p95 {gpu['p95'] if gpu else float('nan'):.3f} ms  "
                  f"submit→done p95 {result['submitToGpuDone']['p95']:.2f} ms")
            await page.close()
        await browser.close()
    return results


def main():
    dist, songs, skins = map(Path, sys.argv[1:4])
    evidence = Path(sys.argv[4]) if len(sys.argv) > 4 else Path('/tmp/vosu-r3-evidence/ToolMapPreview')
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='map-preview-perf-') as directory:
        temp = Path(directory)
        maps = {}
        for ruleset, (folder, name, _) in MAPS.items():
            maps[ruleset] = temp / f'{ruleset}.osu'
            shutil.copy(songs / folder / name, maps[ruleset])
        copies = {}
        for key, folder in SKINS.items():
            copies[key] = temp / key
            shutil.copytree(skins / folder, copies[key])
        server = serve(dist, maps, copies)
        try:
            results = asyncio.run(bench())
        finally:
            server.shutdown()
    (evidence / 'perf.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'wrote {evidence / "perf.json"}')


if __name__ == '__main__':
    main()
