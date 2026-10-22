#!/usr/bin/env python3
"""Isolated real-vos u API/CLI smoke plus headless mocked-selected-state captures.
Run with: uv run --with playwright python tools/ratings/tests/smoke.py VOSU MAP OVERLAY_FOLDER
The v2 and current-map browser fixtures use REAL service output, not invented ratings.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path('/tmp/vosu-tools-evidence/ratings')
ORIGIN = 'http://127.0.0.1:25450'

def request(path, data=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(ORIGIN + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)

async def browser_checks(url, map_rating, timeline):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless=True, args=['--disable-gpu'])
        page = await browser.new_page(viewport={'width': 1440, 'height': 1440}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        # No game is attached to this isolated daemon. Mock only selected state.
        await page.route('**/v1/beatmap/current?*', lambda route: route.fulfill(json=map_rating))
        await page.route('**/tools/_host/v1/context', lambda route: route.fulfill(json={'beatmap': {'title': 'Noma Nadeshiko — Rice Fusion'}}))
        await page.goto(url)
        await page.get_by_text('Analysis ready', exact=False).wait_for(timeout=90000)
        await page.screenshot(path=str(EVIDENCE / 'analysis.png'), full_page=True)
        await page.locator('#timeline-caption').filter(has_text='Dotted line = whole-map MSD').wait_for()
        await page.locator('#system').select_option('etterna-native')
        await page.locator('#timeline-caption').filter(has_text='base-adjusted').wait_for(timeout=90000)
        await page.screenshot(path=str(EVIDENCE / 'analysis-native-strain.png'),full_page=True)
        await page.locator('#system').select_option('etterna')
        await page.locator('#timeline-caption').filter(has_text='Dotted line = whole-map MSD').wait_for(timeout=90000)
        await page.locator('#start').fill('90')
        await page.locator('#end').fill('135')
        await page.locator('#section').click()
        await page.locator('#section-result').filter(has_text='Etterna').wait_for(timeout=90000)
        await page.screenshot(path=str(EVIDENCE / 'section.png'), full_page=True)
        await page.close()
        overlay = await browser.new_page(viewport={'width':1920,'height':1080},device_scale_factor=1)
        overlay.on('pageerror', lambda error: errors.append(str(error)))
        await overlay.route('**/v1/beatmap/current?*', lambda route: route.fulfill(json=map_rating))
        sockets = []
        async def socket(ws):
            sockets.append(ws)
            ws.on_message(lambda message: ws.send(json.dumps([0,1,[[0,map_rating['checksum']],[1,0],[2,1],[3,5]]])))
        await overlay.route_web_socket('**/websocket/v2/subscribe', socket)
        await overlay.goto(ORIGIN + '/ratings-timeline/')
        await overlay.locator('#message').filter(has_text='LOCAL MSD').wait_for(timeout=90000)
        await overlay.screenshot(path=str(EVIDENCE / 'overlay-song-select-1920x1080.png'),omit_background=True)
        sockets[0].send(json.dumps([1,2,[[1,95000],[3,2]],[]]))
        await overlay.locator('#mode').filter(has_text='IN PLAY').wait_for()
        await overlay.screenshot(path=str(EVIDENCE / 'overlay-in-play-1920x1080.png'),omit_background=True)
        # Missing-tool state must be explicit, never a fake curve.
        await overlay.route('**/tools/ratings/api/**', lambda route: route.fulfill(status=404,json={'error':'not installed'}))
        sockets[0].send(json.dumps([1,3,[[2,1.1]],[]]))
        await overlay.locator('#message').filter(has_text='install Ratings').wait_for()
        await overlay.screenshot(path=str(EVIDENCE / 'overlay-unavailable-1920x1080.png'),omit_background=True)
        assert not errors, errors
        await browser.close()

async def main():
    vosu, original, overlay = map(Path, sys.argv[1:4])
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='vosu-ratings-smoke-') as directory:
        temp = Path(directory)
        env = dict(os.environ)
        env['HOME'] = str(temp)
        for key,folder in [('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_CACHE_HOME','cache'),('XDG_STATE_HOME','state'),('XDG_RUNTIME_DIR','runtime')]:
            env[key] = str(temp / folder)
            (temp/folder).mkdir(mode=0o700)
        env.pop('DISPLAY',None)
        env.pop('WAYLAND_DISPLAY',None)
        config = temp/'config/vosu'
        config.mkdir()
        static = temp/'static'
        shutil.copytree(overlay,static/'ratings-timeline')
        (config/'vosu.toml').write_text(f'ENABLE_AUTOUPDATE = false\nOPEN_DASHBOARD_ON_STARTUP = false\nSTART_AT_LOGIN = false\nSERVER_IP = "127.0.0.1"\nSERVER_PORT = 25450.0\nDASHBOARD_IP = "127.0.0.1"\nDASHBOARD_PORT = 25451.0\nSTATIC_FOLDER_PATH = "{static}"\n')
        chart = temp/'Rice Fusion.osu'
        shutil.copyfile(original,chart)
        log = (EVIDENCE/'daemon.log').open('w')
        daemon = subprocess.Popen([str(vosu),'--tool',str(ROOT/'tools/ratings')],cwd=temp,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            deadline=time.monotonic()+30
            broker=temp/'runtime/vosu/broker.json'
            while not broker.exists():
                if daemon.poll() is not None: raise RuntimeError('daemon exited; see daemon.log')
                if time.monotonic()>deadline: raise TimeoutError('broker not ready')
                await asyncio.sleep(.1)
            async def cli(*arguments):
                process=await asyncio.create_subprocess_exec(str(vosu),'x','ratings',*map(str,arguments),cwd=temp,env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                out,err=await asyncio.wait_for(process.communicate(),90)
                if process.returncode: raise RuntimeError(err.decode())
                return json.loads(out)
            rating=await cli(chart,'--json')
            assert rating['msd']['overall']>0 and rating['quaver']>0 and rating['interlude']>0
            md5=rating['checksum']
            api=request(f'/tools/ratings/api/v1/beatmap/{md5}?rate=1&systems=etterna,quaver,interlude')
            assert api['msd']==rating['msd']
            rates=request(f'/tools/ratings/api/v1/beatmap/{md5}/rates?step=0.05')
            assert len(rates['rates'])==31
            path=f'/tools/ratings/api/v1/beatmap/{md5}/timeline?rate=1&system=etterna&window=12&hop=1'
            started=time.perf_counter()
            timeline=request(path)
            cold_ms=(time.perf_counter()-started)*1000
            started=time.perf_counter()
            warm=request(path)
            warm_ms=(time.perf_counter()-started)*1000
            assert timeline == warm
            assert timeline['mode']=='local_msd' and timeline['window']==12 and timeline['hop']==1
            assert abs(timeline['overall']-rating['msd']['overall'])<0.0001
            timings={'cold_http_ms':cold_ms,'warm_http_ms':warm_ms,'samples':len(timeline['points']),'window_chart_seconds':12,'hop_chart_seconds':1,'build':'debug','chart':'Rice Fusion','notes':rating['notes']}
            (EVIDENCE/'timings.json').write_text(json.dumps(timings,indent=2))
            print('Local MSD timeline timing:',json.dumps(timings))
            section=request(f'/tools/ratings/api/v1/beatmap/{md5}/section?start=90&end=135&rate=1')
            assert section['rating']['notes']<rating['notes']
            for args in [('--rates',),('--timeline',),('--section','1:30-2:15')]:
                result=await cli(chart,*args,'--json')
                assert result
            token=json.loads(broker.read_text())['token']
            url=request('/tools/_host/v1/cli/ratings/open',data=b'{}',token=token)['url']
            await browser_checks(url,rating,timeline)
            (EVIDENCE/'api.json').write_text(json.dumps({'map':rating,'rates':rates,'section':section,'timeline_metadata':{k:v for k,v in timeline.items() if k!='points'},'timeline_points':len(timeline['points']),'mocked_browser_fields':['selected current-map response','v2 selected fields'],'real_daemon':str(vosu)},indent=2))
            print('PASS: real daemon map/rates/timeline/section API and CLI; installed overlay; analysis/section and song-select/in-play/unavailable screenshots',EVIDENCE)
        finally:
            daemon.terminate()
            try: daemon.wait(timeout=10)
            except subprocess.TimeoutExpired: daemon.kill();daemon.wait()
            log.close()

asyncio.run(main())
