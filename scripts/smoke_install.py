#!/usr/bin/env python3
"""Install actual release packages in a fully isolated vosu test-harness daemon."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, ProxyHandler, build_opener

DASHBOARD = 'http://127.0.0.1:25151'
OVERLAY = 'http://127.0.0.1:25150'
READ_ROUTES = {'practice': '/v1/generated', 'ratings': '/v1/beatmap/current',
               'replay-renderer': '/v1/presets', 'server-pp': '/v1/servers',
               'skin-editor': '/v1/skins', 'downloader': '/v1/state'}


def http(path, *, dashboard=True, method='GET', data=None, headers=None):
    request = Request((DASHBOARD if dashboard else OVERLAY) + path,
                      data=None if data is None else json.dumps(data).encode(), method=method,
                      headers={**({'Content-Type': 'application/json'} if data is not None else {}), **(headers or {})})
    opener = build_opener(ProxyHandler({}))
    try:
        response = opener.open(request, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.read().decode(), response.headers.get('Content-Type', '')


def wait_for(callback, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = callback()
            if result:
                return result
        except (URLError, ConnectionError):
            pass
        time.sleep(0.05)
    raise AssertionError('timed out waiting for isolated vosu')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vosu', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True, help='directory containing generated tool catalog and ZIPs')
    parser.add_argument('--overlays', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, default=Path('/tmp/vosu-tools-evidence/integration'))
    parser.add_argument('--playwright-module', type=Path)
    parser.add_argument('--browser-cache', type=Path)
    args = parser.parse_args()
    binary = args.vosu.resolve(strict=True)
    args.evidence.mkdir(parents=True, exist_ok=True)
    report = {'tools': [], 'overlays': [], 'ports': [25150, 25151]}
    with tempfile.TemporaryDirectory(prefix='vosu-packaged-integration-') as temporary:
        root = Path(temporary)
        environment = dict(os.environ)
        for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'):
            environment.pop(key, None)
        for key, directory in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                               ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'runtime')]:
            path = root / directory
            path.mkdir(mode=0o700)
            environment[key] = str(path)
        if args.browser_cache:
            environment['PLAYWRIGHT_BROWSERS_PATH'] = str(args.browser_cache.resolve())
        served = root / 'served'
        served.mkdir()
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SimpleHTTPRequestHandler, directory=str(served)))
        port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        catalogs = {}
        for kind, directory in [('tools', args.tools), ('overlays', args.overlays)]:
            destination = served / kind
            destination.mkdir()
            original = json.loads((directory / 'catalog.json').read_text())
            catalog = json.loads(json.dumps(original))
            for entry in catalog.get(kind, []):
                packages = entry['packages'].values() if kind == 'tools' else [entry['package']]
                for package in packages:
                    filename = package['url'].rsplit('/', 1)[1]
                    shutil.copyfile(directory / filename, destination / filename)
                    package['url'] = f'http://tools.invalid:{port}/{kind}/{filename}'
            (destination / 'catalog.json').write_text(json.dumps(catalog))
            catalogs[kind] = catalog
        config = root / 'config/vosu'
        (config / 'tools').mkdir(parents=True)
        (config / 'vosu.toml').write_text('''ENABLE_AUTOUPDATE = false
OPEN_DASHBOARD_ON_STARTUP = false
SERVER_IP = "127.0.0.1"
SERVER_PORT = 25150
DASHBOARD_IP = "127.0.0.1"
DASHBOARD_PORT = 25151
ALLOWED_IPS = "127.0.0.1,localhost,absolute"
''')
        (config / 'tools/catalog-sources.json').write_text(json.dumps([{'source': f'http://tools.invalid:{port}/{kind}/catalog.json', 'enabled': True} for kind in ['tools', 'overlays']]))
        environment['VOSU_TOOL_CATALOG_TEST_SOCKET'] = f'127.0.0.1:{port}'
        launcher = root / 'vosux'
        launcher.symlink_to(binary)
        with (args.evidence / 'daemon.log').open('w') as log:
            daemon = subprocess.Popen([str(binary), '--update=false'], cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            try:
                wait_for(lambda: http('/api/tools')[0] == 200)
                status, page, _ = http('/tools')
                assert status == 200
                context = json.loads(re.search(r'<script[^>]*id="vosu-context"[^>]*>(.*?)</script>', page, re.S).group(1))
                headers = {'Origin': DASHBOARD, 'X-Vosu-CSRF': context['csrf']}
                def post(path, data=None):
                    status, body, _ = http(path, method='POST', data=data or {}, headers=headers)
                    assert status == 200, (path, status, body)
                    return json.loads(body)
                def cli(*arguments):
                    result = subprocess.run([str(launcher), *arguments], cwd=root, env=environment, text=True, capture_output=True, timeout=120)
                    assert result.returncode == 0, (arguments, result.stdout, result.stderr)
                    return result.stdout
                status, body, _ = http('/api/tools/catalog')
                assert status == 200
                catalog = json.loads(body)
                assert len(catalog['tools']) == len(catalogs['tools']['tools'])
                assert all(source['status'] == 'ok' for source in catalog['sources'])
                for tool in catalogs['tools']['tools']:
                    identity = tool['id']
                    status, body, _ = http('/api/tools/' + identity)
                    installation = 'dependency'
                    if status != 200:
                        installation = cli('--install', identity).strip()
                    view = json.loads(http('/api/tools/' + identity)[1])
                    assert view['version'] == tool['version'] and view['source'] == 'user' and not view['trusted']
                    post('/api/tools/' + identity + '/trust')
                    report['tools'].append({'id': identity, 'version': tool['version'], 'package_size': next(iter(tool['packages'].values()))['size'], 'installation': installation})
                for tool, item in zip(catalogs['tools']['tools'], report['tools']):
                    identity = tool['id']
                    if 'service' in tool['interfaces']:
                        post('/api/tools/' + identity + '/start')
                        view = json.loads(http('/api/tools/' + identity)[1])
                        assert view['status'] == 'running' and view['process']['pid']
                        item['service_pid'] = view['process']['pid']
                        route = READ_ROUTES.get(identity)
                        if route is None:
                            # New services must nominate a real read route rather
                            # than accepting an arbitrary prefix as a smoke test.
                            raise ValueError(f'add an integration read route for {identity}')
                        read_headers = {}
                        if 'ui' in tool['interfaces']:
                            launch = post('/api/tools/' + identity + '/launch', {'theme': 'dark'})
                            code = re.search(r'vosu-launch=([^&]+)', launch['url']).group(1)
                            session_status, session_body, _ = http('/tools/_host/v1/session', dashboard=False, method='POST', data={'tool': identity, 'code': code})
                            assert session_status == 200, session_body
                            read_headers['X-Vosu-Tool-Session'] = json.loads(session_body)['session']
                        status, body, content_type = http('/tools/' + identity + '/api' + route, dashboard=False, headers=read_headers)
                        assert status in (200, 400, 404, 409, 422, 503) and 'json' in content_type, (identity, status, body)
                        item['read_route'] = route
                        item['read_status'] = status
                        item['read_response'] = json.loads(body)
                    if 'cli' in tool['interfaces']:
                        help_text = cli(identity, '--help')
                        assert help_text.strip()
                        (args.evidence / (identity + '-help.txt')).write_text(help_text)
                        item['cli_help'] = 'exit 0'
                for overlay in catalogs['overlays'].get('overlays', []):
                    job = post('/api/tools/catalog/overlays/' + overlay['id'] + '/install', {'install_tools': True})['job_id']
                    def complete():
                        result = json.loads(http('/api/tools/catalog/jobs/' + job)[1])
                        assert result['status'] != 'failed', result
                        return result if result['status'] == 'completed' else None
                    wait_for(complete)
                    status, body, _ = http('/' + overlay['id'] + '/', dashboard=False)
                    assert status == 200 and body
                    report['overlays'].append({'id': overlay['id'], 'package_size': overlay['package']['size'], 'http_status': status})
                if args.playwright_module:
                    ui_tools = [tool['id'] for tool in catalogs['tools']['tools'] if 'ui' in tool['interfaces']]
                    subprocess.run(['node', str(Path(__file__).with_name('smoke_browser.mjs')), str(args.playwright_module.resolve()), str(args.evidence.resolve()), *ui_tools], env=environment, cwd=root, check=True, timeout=180)
                    report['ui_tools'] = ui_tools
                daemon.send_signal(signal.SIGTERM)
                assert daemon.wait(timeout=20) == 0
            finally:
                if daemon.poll() is None:
                    daemon.terminate()
                    try:
                        daemon.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait()
                server.shutdown()
    (args.evidence / 'integration.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
