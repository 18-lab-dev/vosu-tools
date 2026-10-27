#!/usr/bin/env python3
"""Differential reference for "Interlude patterns".

Runs Interlude's unmodified pattern analysis (./upstream, ../interlude) through
the F# harness on the committed fixtures and writes
tests/fixtures/patterns-reference.json. With `--out FILE chart.osu ...` it writes
the reference for other charts (e.g. read-only copies of local charts) to FILE;
point VOSU_PATTERNS_REFERENCE at it and run
`cargo test -p vosu-mania-ratings --test patterns` to compare.
"""
import json
import pathlib
import subprocess
import sys

here = pathlib.Path(__file__).resolve().parent
fixtures = here.parents[1] / 'fixtures'


def run(chart):
    out = subprocess.run(['dotnet', 'run', '--project', str(here), '--', str(chart)],
                         check=True, capture_output=True, text=True).stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith('{')]


if sys.argv[1:2] == ['--out']:
    target, charts = pathlib.Path(sys.argv[2]), [pathlib.Path(c).resolve() for c in sys.argv[3:]]
    label = str
else:
    target = fixtures / 'patterns-reference.json'
    charts = [fixtures / 'cyclic.osu', fixtures / 'mixed7.osu'] + [fixtures / f'demo/mania-{k}k.osu' for k in range(3, 11)]
    label = lambda c: str(c.relative_to(fixtures))
results = []
for chart in charts:
    for result in run(chart):
        result['chart'] = label(chart)
        results.append(result)
target.write_text(json.dumps(results, separators=(',', ':')) + '\n')
print(f'{len(results)} results -> {target}')
