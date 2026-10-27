#!/usr/bin/env python3
"""Differential reference for Prism (mania-tracker, MIT).

Fetches the pinned upstream Prism workspace from GitHub, checks that every
vendored file in vendor/prism is byte-identical to it, builds driver.rs against
the pristine copy and writes tests/fixtures/prism-reference.json (on Windows
prism-reference-windows.json) for the committed fixtures. Extra .osu paths (e.g. read-only copies of local charts) are
written to FILE instead; point VOSU_PRISM_REFERENCE at it and run
`cargo test -p vosu-map-analysis --test prism` to compare our adapter:

    python3 generate.py [--out FILE chart.osu ...]
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

REPO, REVISION = 'aleju03/mania-hub', '9ab23951357831a0dbbc48da20dd2140f22bd850'
CRATES = ('jsmath', 'chart-parser', 'dan-core', 'prism')
here = pathlib.Path(__file__).resolve().parent
tool = here.parents[2]
vendor = tool.parents[1] / 'vendor/prism'
fixtures = tool / 'tests/fixtures'


def fetch(path):
    url = f'https://raw.githubusercontent.com/{REPO}/{REVISION}/{path}'
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def pristine(dest):
    with urllib.request.urlopen(f'https://api.github.com/repos/{REPO}/git/trees/{REVISION}?recursive=1', timeout=60) as r:
        tree = json.load(r)['tree']
    wanted = [e['path'] for e in tree if e['type'] == 'blob' and (
        e['path'] == 'algorithms/prism/Cargo.toml'
        or any(e['path'].startswith(f'algorithms/prism/crates/{c}/') for c in CRATES))]
    for path in wanted:
        data = fetch(path)
        relative = path.removeprefix('algorithms/prism/')
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        if (vendor / relative).read_bytes() != data:
            raise SystemExit(f'vendored file differs from upstream: {relative}')
    return dest


def build(workspace_crates, target):
    project = target / 'driver'
    (project / 'src').mkdir(parents=True, exist_ok=True)
    main = (here / 'driver.rs').read_text()
    if os.name == 'nt':
        # Upstream jsmath declares POSIX clock_gettime, which MSVC lacks; link
        # the same shim the tool uses (src/windows_clock.rs).
        shim = (tool / 'src/windows_clock.rs').resolve().as_posix()
        main += f'\n#[path = "{shim}"]\nmod windows_clock;\n'
    (project / 'src/main.rs').write_text(main)
    (project / 'Cargo.toml').write_text(
        '[package]\nname = "prism-reference"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n'
        f'[dependencies]\nprism = {{ path = "{workspace_crates.as_posix()}/prism" }}\n'
        f'chart-parser = {{ path = "{workspace_crates.as_posix()}/chart-parser" }}\n')
    subprocess.run(['cargo', 'build', '--release', '--quiet', '--manifest-path', str(project / 'Cargo.toml'),
                    '--target-dir', str(project / 'target')], check=True)
    return project / 'target/release' / ('prism-reference.exe' if os.name == 'nt' else 'prism-reference')


def run(binary, chart):
    out = subprocess.run([str(binary), str(chart)], check=True, capture_output=True, text=True).stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith('{')]


with tempfile.TemporaryDirectory() as temp:
    temp = pathlib.Path(temp)
    upstream = build(pristine(temp / 'upstream') / 'crates', temp)
    if sys.argv[1:2] == ['--out']:
        target, charts, label = pathlib.Path(sys.argv[2]), [pathlib.Path(c).resolve() for c in sys.argv[3:]], str
    else:
        charts = [fixtures / 'cyclic.osu', fixtures / 'mixed7.osu'] + [fixtures / f'demo/mania-{k}k.osu' for k in range(5, 10)]
        # The C runtime's pow (glibc vs. the MSVC UCRT) moves some values by a
        # few ULP, so Windows has its own reference.
        name = 'prism-reference-windows.json' if os.name == 'nt' else 'prism-reference.json'
        target, label = fixtures / name, lambda c: c.relative_to(fixtures).as_posix()
    results = []
    for chart in charts:
        for result in run(upstream, chart):
            result['chart'] = label(chart)
            results.append(result)
    target.write_text(json.dumps(results, separators=(',', ':')) + '\n')
    print(f'{len(results)} results -> {target}')
