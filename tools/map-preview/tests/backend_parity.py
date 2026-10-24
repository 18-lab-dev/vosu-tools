#!/usr/bin/env python3
"""render-core backend parity: the same scenes drawn by WebGPU and WebGL2.

Build the page, then run (headless Chromium, hardware GPU):
  (cd tools/map-preview/web && bunx vite build --config ../tests/parity/vite.config.ts --outDir /tmp/mp-parity-dist)
  uv run --with playwright --with pillow --with numpy --with scikit-image \\
    python tools/map-preview/tests/backend_parity.py /tmp/mp-parity-dist EVIDENCE_DIR [NAME=SKIN_DIR ...]

Every demo map (osu!, taiko, catch, mania 4K and 7K) at a busy time, with
each built-in look and every NAME=SKIN_DIR skin (read-only; served as is),
with judgements and replay-style input, is drawn by both backends into an
offscreen target cleared transparent (raw RGBA, alpha compared too) and on a
visible canvas. Each pair must reach SSIM >= 0.99; the captures, a diff and
parity.json land in EVIDENCE_DIR. Finally each backend's device or context is
lost on purpose: the playfield must redraw the same frame on a new canvas.
"""
import asyncio
import base64
import io
import json
import mimetypes
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preview_e2e import CHROME  # noqa: E402

PORT = 25652
THRESHOLD = 0.99
SCENES = [('osu', 2260), ('osu', 5500), ('taiko', 5200), ('fruits', 4500), ('mania-4k', 4500), ('mania-7k', 4500)]
BUILTINS = ['argon', 'triangles', 'legacy']
WIDTH, HEIGHT = 1280, 720


def serve(dist: Path, skins: dict):
    lookup = {name: {p.relative_to(d).as_posix().lower(): p for p in d.rglob('*') if p.is_file()} for name, d in skins.items()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            file = None
            if path.startswith('/parity/'):
                candidate = (dist / (path.removeprefix('/parity/') or 'index.html')).resolve()
                file = candidate if dist.resolve() in candidate.parents and candidate.is_file() else None
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


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    return float(structural_similarity(a, b, channel_axis=2, data_range=255))


async def run(skins: dict, evidence: Path) -> list:
    from playwright.async_api import async_playwright

    sources = [(b, f'builtin:{b}') for b in BUILTINS] + [(name, f'files:/skins/{name}/') for name in skins]
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=str(CHROME), headless=True,
            args=['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan',
                  '--enable-features=Vulkan', '--disable-vulkan-surface'])
        pages = {}
        for backend in ('webgpu', 'webgl2'):
            page = await browser.new_page(viewport={'width': WIDTH, 'height': HEIGHT})
            errors = []
            # Headless Chromium can answer the first requestAdapter with null (as in preview_e2e).
            await page.add_init_script('{ const request = GPU.prototype.requestAdapter; GPU.prototype.requestAdapter = '
                                       'async function (o) { return (await request.call(this, o)) ?? request.call(this, o); }; }')
            page.on('pageerror', lambda e, errors=errors: errors.append(str(e)))
            await page.goto(f'http://127.0.0.1:{PORT}/parity/?backend={backend}')
            await page.wait_for_function('window.__ready', timeout=60000)
            ready = await page.evaluate('window.__ready')
            assert 'error' not in ready and ready['backend'] == backend, (backend, ready, errors)
            pages[backend] = page
        for label, source in sources:
            for scene, time in SCENES:
                name = f'{scene}-{time}-{label}'
                drawn = {}
                for backend, page in pages.items():
                    out = await page.evaluate('(spec) => window.__render(spec)', {
                        'demo': scene, 'time': time, 'skin': source, 'width': WIDTH, 'height': HEIGHT})
                    raw = np.frombuffer(base64.b64decode(out['offscreen']), np.uint8).reshape(HEIGHT, WIDTH, 4)
                    shown = np.asarray(Image.open(io.BytesIO(base64.b64decode(out['canvas'].split(',', 1)[1]))).convert('RGB'))
                    drawn[backend] = (raw, shown, out['textureMB'])
                    Image.fromarray(raw, 'RGBA').save(evidence / f'{name}-{backend}-offscreen.png')
                    Image.fromarray(shown).save(evidence / f'{name}-{backend}-canvas.png')
                (a_raw, a_shown, a_mb), (b_raw, b_shown, b_mb) = drawn['webgpu'], drawn['webgl2']
                diff = np.abs(a_shown.astype(int) - b_shown.astype(int)).max(axis=2)
                Image.fromarray(np.clip(diff * 8, 0, 255).astype(np.uint8)).save(evidence / f'{name}-diff-x8.png')
                result = {
                    'scene': name,
                    'offscreen_ssim': round(ssim(a_raw, b_raw), 5),
                    'canvas_ssim': round(ssim(a_shown, b_shown), 5),
                    'max_channel_diff': int(diff.max()),
                    'pixels_over_8': int((diff > 8).sum()),
                    'alpha_ssim': round(float(structural_similarity(a_raw[..., 3], b_raw[..., 3], data_range=255)), 5),
                    'textureMB': {'webgpu': a_mb, 'webgl2': b_mb},
                    'drawn_pixels': int((a_raw[..., 3] > 0).sum()),
                }
                results.append(result)
                print(f"{name:40} offscreen {result['offscreen_ssim']:.4f}  canvas {result['canvas_ssim']:.4f}  "
                      f"alpha {result['alpha_ssim']:.4f}  max diff {result['max_channel_diff']:3}  >8: {result['pixels_over_8']}", flush=True)
        # A lost device or context (a GPU reset): the playfield rebuilds itself on
        # a fresh canvas and draws the same frame again.
        for backend, page in pages.items():
            recovery = await page.evaluate('window.__lose()')
            shown = [np.asarray(Image.open(io.BytesIO(base64.b64decode(recovery.pop(k).split(',', 1)[1]))).convert('RGB'))
                     for k in ('before', 'after')]
            for k, image in zip(('before', 'after'), shown):
                Image.fromarray(image).save(evidence / f'recovery-{backend}-{k}.png')
            recovery.update({'backend_before': backend, 'canvas_ssim': round(ssim(*shown), 5),
                             'drawn': int((shown[1].max(axis=2) > 16).sum())})
            print(f"lost {backend}: {recovery}", flush=True)
            assert recovery['canvasReplaced'] and recovery['canvas_ssim'] >= THRESHOLD and recovery['drawn'], recovery
            results.append({'scene': f'recovery-{backend}', **recovery})
        for page in pages.values():
            await page.close()
        await browser.close()
    return results


def main():
    args = [a for a in sys.argv[1:] if '=' not in a]
    dist, evidence = Path(args[0]), Path(args[1])
    skins = {k: Path(v) for k, v in (a.split('=', 1) for a in sys.argv[1:] if '=' in a)}
    if not (dist / 'index.html').is_file():
        sys.exit('Build the parity page first (see the module docstring)')
    evidence.mkdir(parents=True, exist_ok=True)
    server = serve(dist, skins)
    try:
        results = asyncio.run(run(skins, evidence))
    finally:
        server.shutdown()
    (evidence / 'parity.json').write_text(json.dumps(results, indent=2) + '\n')
    failing = [r for r in results if 'drawn_pixels' in r and (min(r['offscreen_ssim'], r['canvas_ssim']) < THRESHOLD or r['drawn_pixels'] == 0)]
    assert not failing, f'{len(failing)} scene(s) below SSIM {THRESHOLD}: {[r["scene"] for r in failing]}'
    print(f'backend parity passed: {len(results)} scenes, SSIM >= {THRESHOLD}; evidence in {evidence}')


if __name__ == '__main__':
    main()
