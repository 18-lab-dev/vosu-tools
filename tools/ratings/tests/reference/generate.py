#!/usr/bin/env python3
"""Run pinned, unmodified upstream calculators with native chart adapters."""
import json
import pathlib
import subprocess
root = pathlib.Path(__file__).resolve().parent
fixtures = root.parent / 'fixtures'
results = []
for system in ('quaver', 'interlude'):
    for chart in sorted(fixtures.glob('*.osu')):
        completed = subprocess.run(['dotnet', 'run', '--project', str(root / system), '--', str(chart)], check=True, capture_output=True, text=True)
        for line in completed.stdout.splitlines():
            if line.startswith('{'):
                result = json.loads(line)
                result.update(system=system, chart=chart.name)
                results.append(result)
(fixtures / 'reference.json').write_text(json.dumps(results, separators=(',', ':')) + '\n')
