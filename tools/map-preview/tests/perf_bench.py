#!/usr/bin/env python3
"""Render benchmark for Map preview on real maps and skins (headless Chromium).

Build the page, then run:
  (cd tools/map-preview/web && bunx vite build --config ../tests/perf/vite.config.ts --outDir /tmp/mp-perf-dist)
  uv run --with playwright python tools/map-preview/tests/perf_bench.py /tmp/mp-perf-dist SONGS SKINS [EVIDENCE_DIR] \
    [--mania-only] [--mania-map=MAP.osu@START_MS] [NAME=SKIN_DIR ...]

--query=css=1280x720 (or size=WxH) sizes the canvas like a stage of that CSS
size (shared playfieldSize rule) or exactly; the default is 1920x1080.
--query=backend=webgl2 (or webgpu) forces render-core's backend; joined with
&, query parameters combine (--query=backend=webgl2&css=1280x720).
NAME=SKIN_DIR adds a mania case with that skin folder; --mania-only skips the
other rulesets; --mania-map replaces the mania map. Draw calls per frame and the renderer's texture memory are
reported too.

Each case renders 600 measured frames at 1920x1080 (after 60 warm-up frames),
advancing 1/60 s per frame from a busy part of the map, and reports CPU time
per renderAt call, frame time (renderAt to GPU finished, p50/p99), and on
WebGPU the render pass time from timestamp queries. Skin load time covers
fetching and decoding every element (files) or drawing them (built-ins);
atlas time covers building and uploading the atlas until the GPU finished.
Texture memory is the skin atlas and frame table. Inputs are temp copies.
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


async def bench(cases, query=''):
    from playwright.async_api import async_playwright

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan',
                  '--disable-vulkan-surface', '--disable-gpu-vsync', '--disable-frame-rate-limit'])
        for ruleset, skin in cases:
            page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
            source = skin if skin.startswith('builtin:') else f'files:/skins/{skin[6:]}/'
            await page.goto(f'http://127.0.0.1:{PORT}/perf/?map=/maps/{ruleset}.osu&start={MAPS[ruleset][2]}&skin={source}{"&" + query if query else ""}')
            await page.wait_for_function('window.__perf', timeout=120000)
            result = await page.evaluate('window.__perf')
            assert 'error' not in result, result
            result.update({'ruleset': ruleset, 'skin': skin})
            results.append(result)
            gpu = result['gpuPass']
            print(f"{result['backend']:6} {ruleset:6} {skin:18} objects {result['objects']:5}  skin {result['skinMs']:7.1f} + atlas {result['atlasMs']:6.1f} ms  "
                  f"compile {result['compileMs']:6.1f} ms  cpu mean {result['cpu']['mean']:.3f} p95 {result['cpu']['p95']:.3f} ms  "
                  f"frame p50 {result['frame']['p50']:.2f} p99 {result['frame']['p99']:.2f} ms  "
                  f"gpu pass mean {gpu['mean'] if gpu else float('nan'):.3f} p95 {gpu['p95'] if gpu else float('nan'):.3f} ms  "
                  f"draws mean {result['drawCalls']['mean']:.1f} max {result['drawCalls']['max']}  "
                  f"textures {result['textureMB']:.0f} MB  canvas {result.get('canvas')}")
            await page.close()
        await browser.close()
    return results


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--') and '=' not in a]
    extra = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a and not a.startswith('--'))
    dist, songs, skins = map(Path, args[:3])
    evidence = Path(args[3]) if len(args) > 3 else Path('/tmp/vosu-r3-evidence/ToolMapPreview')
    override = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--mania-map=')), None)
    if override:
        path, _, start = override.rpartition('@')
        MAPS['mania'] = (str(Path(path).parent), Path(path).name, int(start))
    cases = [c for c in CASES if c[0] == 'mania' or '--mania-only' not in sys.argv]
    cases += [('mania', f'files:{name}') for name in extra]
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
        for key, folder in extra.items():
            copies[key] = temp / key
            shutil.copytree(folder, copies[key])
        server = serve(dist, maps, copies)
        try:
            query = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--query=')), '')
            results = asyncio.run(bench(cases, query))
        finally:
            server.shutdown()
    (evidence / 'perf.json').write_text(json.dumps(results, indent=2) + '\n')
    print(f'wrote {evidence / "perf.json"}')


if __name__ == '__main__':
    main()
