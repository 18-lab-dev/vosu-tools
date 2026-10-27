#!/usr/bin/env python3
"""Reference for slider and spinner objects in native mania charts: what
osu! (lazer) 2026.1005.0-lazer plays.

Runs the lazer oracle of packages/ruleset-convert (test/reference: lazer's own
LegacyBeatmapDecoder and ManiaBeatmapConverter through GetPlayableBeatmap) on
each chart and writes the converted notes and holds. Build the oracle once
(needs the .NET 10 SDK and a ppy/osu checkout at 2026.1005.0-lazer):

    dotnet build -c Release -o /tmp/oracle-bin -p:OsuSource=/path/to/osu \
        packages/ruleset-convert/test/reference
    python3 generate.py --oracle /tmp/oracle-bin/oracle.dll [--dotnet PATH] \
        [--out FILE chart.osu ...]

Without --out it writes tests/fixtures/lazer-reference.json for the committed
fixtures in tests/fixtures/objects. With --out, extra .osu paths (e.g.
read-only copies of local charts) go to FILE; point VOSU_LAZER_REFERENCE at it
and run `cargo test -p vosu-map-analysis --test playable`. Every chart is
copied to a temporary folder first; the originals are only read.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile

here = pathlib.Path(__file__).resolve().parent
fixtures = here.parents[1] / 'fixtures'

parser = argparse.ArgumentParser()
parser.add_argument('--oracle', required=True)
parser.add_argument('--dotnet', default='dotnet')
parser.add_argument('--out')
parser.add_argument('charts', nargs='*')
args = parser.parse_args()

charts = [pathlib.Path(c) for c in args.charts] if args.out else sorted((fixtures / 'objects').glob('*.osu'))
results = []
with tempfile.TemporaryDirectory() as temp:
    for chart in charts:
        copy = pathlib.Path(temp) / 'chart.osu'
        shutil.copyfile(chart, copy)
        out = subprocess.run([args.dotnet, args.oracle, 'mania', str(copy), ''], check=True, capture_output=True, text=True).stdout
        played = json.loads(out)
        results.append({
            'chart': str(chart) if args.out else str(chart.relative_to(fixtures)),
            'columns': played['columns'],
            'objects': [[o['t'], o['e'], o['c'], o['k']] for o in played['objects']],
        })
target = pathlib.Path(args.out) if args.out else fixtures / 'lazer-reference.json'
target.write_text(json.dumps(results, separators=(',', ':')) + '\n')
print(f'{len(results)} charts -> {target}')
