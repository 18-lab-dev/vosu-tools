#!/usr/bin/env python3
"""Headless CLI/service smoke on temporary copies. Never writes source Songs.
Run with --map <mania.osu> --map <taiko.osu> --map <osu.osu>.
This harness supplies host context via a stand-in; real-daemon checks are separate.
"""
import argparse
import difflib
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--map', type=Path, action='append', required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
TOKEN = 'practice-isolated-smoke'
context = {}
service_port = 0

def field(text, key, default=None):
    return next((line.split(':', 1)[1].strip() for line in text.splitlines() if line.startswith(key + ':')), default)

class Host(http.server.BaseHTTPRequestHandler):
    def request(self):
        if self.headers.get('X-Vosu-Tool-Token') != TOKEN:
            self.send_error(401)
            return
        if self.path == '/tools/_host/v1/context':
            body = json.dumps(context).encode()
            status = 200
        elif self.path.startswith('/tools/practice/api/'):
            connection = http.client.HTTPConnection('127.0.0.1', service_port, timeout=180)
            data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            connection.request(self.command, '/' + self.path.split('/api/', 1)[1], body=data,
                               headers={'X-Vosu-Tool-Token': TOKEN, 'Content-Type': 'application/json', 'X-Vosu-Caller': 'cli:practice'})
            response = connection.getresponse()
            status, body = response.status, response.read()
            connection.close()
        else:
            self.send_error(404)
            return
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = do_DELETE = request
    def log_message(self, *_):
        pass

host = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Host)
threading.Thread(target=host.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='practice-real-map-smoke-') as directory:
    temporary = Path(directory)
    environment = dict(os.environ)
    for variable in ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']:
        path = temporary / variable
        path.mkdir(mode=0o700)
        environment[variable] = str(path)
    environment.update(VOSU_TOOL_PROTOCOL='1', VOSU_TOOL_ID='practice', VOSU_TOOL_TOKEN=TOKEN,
                       VOSU_URL=f'http://127.0.0.1:{host.server_port}', VOSU_TOOL_DATA_DIR=str(temporary/'data'),
                       VOSU_TOOL_CACHE_DIR=str(temporary/'cache'), VOSU_TOOL_INTERFACE='service')
    binary = ROOT / 'target/debug/vosu-practice'
    with (args.evidence/'service.log').open('w') as log:
        service = subprocess.Popen([str(binary)], env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            ready = service.stdout.readline().strip()
            assert ready.startswith('vosu-tool-ready '), ready
            service_port = int(ready.split()[1])
            def cli(*arguments):
                result = subprocess.run([str(binary), 'cli', *arguments, '--json'], env=dict(environment,VOSU_TOOL_INTERFACE='cli'), capture_output=True, text=True, timeout=240)
                assert result.returncode == 0, (arguments, result.stderr, result.stdout)
                return json.loads(result.stdout)
            results=[]
            songs = temporary/'Songs'
            for source in args.map:
                original = source.read_bytes()
                text = original.decode('utf-8-sig')
                folder = songs/source.parent.name
                folder.mkdir(parents=True)
                chart = folder/source.name
                shutil.copy2(source, chart)
                audio_name = field(text,'AudioFilename')
                assert audio_name and '..' not in Path(audio_name).parts
                shutil.copy2(source.parent/audio_name, folder/audio_name)
                mode = int(field(text,'Mode','0'))
                context.update(client='stable', songs_dir=str(songs), beatmap={'checksum':hashlib.md5(original).hexdigest(),'mode':{0:'osu',1:'taiko',2:'fruits',3:'mania'}[mode], 'folder':str(folder),'file':str(chart),'audio':str(folder/audio_name),'background':None})
                combinations = {3:[('IN,MR,CS',0.9),('HO,RD,CS',1.1)],1:[('SW,CS',0.9),('RD,CS',1.1)],2:[('MR',0.9)],0:[('RD,MR,DA',0.9)]}[mode]
                for mods,rate in combinations:
                    entry = cli('--mods',mods,'--seed','1','--rate',str(rate))
                    output_path = next(Path(f['path']) for f in entry['files'] if f['path'].endswith('.osu'))
                    output = output_path.read_text()
                    assert 'BeatmapID:0' in output and output_path.is_relative_to(folder)
                    assert chart.read_bytes()==original and source.read_bytes()==original
                    section=''
                    objects=0
                    for line in output.splitlines():
                        if line.startswith('['): section=line
                        elif section=='[HitObjects]' and line.strip() and not line.startswith('//'):
                            parts=line.split(',');assert len(parts)>=5
                            int(parts[0]);int(parts[1]);int(parts[2]);int(parts[3]);objects+=1
                            if int(parts[3])&128: int(parts[5].split(':')[0])
                    name=f'mode{mode}-{mods.replace(",","-")}-{rate}'
                    diff=''.join(difflib.unified_diff(text.splitlines(True),output.splitlines(True),fromfile=source.name,tofile=output_path.name))
                    (args.evidence/(name+'.diff')).write_text(diff)
                    result={'source':str(source),'mods':mods,'rate':rate,'objects':objects,'entry':entry}
                    results.append(result)
                    print(json.dumps({k:v for k,v in result.items() if k!='entry'}),flush=True)
                    cli('delete',entry['id'])
                    assert not output_path.exists() and chart.read_bytes()==original
                if mode==3:
                    context['client']='lazer'
                    export=cli('--mods','HO,MR,CS','--rate','1.1')
                    archive=next(Path(f['path']) for f in export['files'] if f['path'].endswith('.osz'))
                    assert archive.is_file()
                    import zipfile
                    with zipfile.ZipFile(archive) as z:
                        assert any(n.endswith('.osu') for n in z.namelist())
                    cli('delete',export['id'])
                    assert source.read_bytes()==original
            assert cli('list')['maps']==[]
            (args.evidence/'real-map-results.json').write_text(json.dumps(results,indent=2))
            print('PASS: real map copies, combined transforms, parse checks, lazer export and safe deletion; source files unchanged')
        finally:
            service.stdin.close()
            service.wait(timeout=8)
            host.shutdown()
