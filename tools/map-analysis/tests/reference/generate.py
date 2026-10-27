#!/usr/bin/env python3
"""Run pinned, unmodified upstream calculators with native chart adapters."""
import json
import pathlib
import subprocess
root = pathlib.Path(__file__).resolve().parent
fixtures = root.parent / 'fixtures'
results = []
# Upstream limits: Quaver.API LaneToFinger 1K–10K; Interlude Layout 3K–10K.
supported = {'quaver': range(1, 11), 'interlude': range(3, 11)}
demos = sorted((fixtures / 'demo').glob('mania-*k.osu'), key=lambda p: int(p.stem[6:-1]))
for system in ('quaver', 'interlude'):
    charts = sorted(fixtures.glob('*.osu')) + [d for d in demos if int(d.stem[6:-1]) in supported[system]]
    for chart in charts:
        completed = subprocess.run(['dotnet', 'run', '--project', str(root / system), '--', str(chart)], check=True, capture_output=True, text=True)
        for line in completed.stdout.splitlines():
            if line.startswith('{'):
                result = json.loads(line)
                result.update(system=system, chart=str(chart.relative_to(fixtures)))
                results.append(result)
(fixtures / 'reference.json').write_text(json.dumps(results, separators=(',', ':')) + '\n')
