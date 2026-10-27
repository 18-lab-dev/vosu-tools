// Real tool services + real dashboard bundle; only vosu selection/bridge are
// deterministic test inputs. Run inside private net/PID namespaces, temp HOME
// and every XDG root (see README). Never targets a user's daemon or browser.
// bun tests/e2e.ts PLAYWRIGHT_MODULE THEME_DIR OUT_DIR
import {resolve,join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dir,'../../..');
const [modulePath,themeDir,out]=Bun.argv.slice(2);
if(!modulePath||!themeDir||!out)throw Error('provide Playwright module, vosu assets/server, evidence directory');
if(!process.env.MAP_ANALYSIS_SANDBOX)throw Error('run in documented private namespace sandbox');
await mkdir(out,{recursive:true});
const {chromium}=await import(modulePath);
const token='map-analysis-e2e-private';
let selected=join(import.meta.dir,'fixtures/demo/osu-4.osu'),mode='osu',played='osu',mods='NM',rate=1,optional=true;
const ports:Record<string,number>={};
const theme=await Bun.file(join(themeDir,'tokens.css')).text()+'\n'+await Bun.file(join(themeDir,'system.css')).text();
const bridge=`export const vosu={tool:{id:'map-analysis'},ready:Promise.resolve(),canWrite:true,dashboardUrl:'/',settings:async()=>({}),fetch:(path,init)=>fetch('/tools/map-analysis/api/'+path,init),subscribe:(fields,callback,status)=>{status('open');fetch('/test/selection').then(r=>r.json()).then(values=>callback([0,0,values.map((v,i)=>[i,v]),[]]));}};`;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url),path=url.pathname;
 if(path==='/json/v2')return Response.json({state:{number:1},beatmap:{mode:{name:mode}},settings:{mode:{name:played}},play:{mode:{name:played},mods:{name:mods,rate}}});
 if(path==='/test/selection')return Response.json([createHash('md5').update(await Bun.file(selected).arrayBuffer()).digest('hex'),0,rate,1,mods,{name:mode},{name:played},{name:played}]);
 if(path==='/tools/_host/v1/context')return Response.json({client:'lazer',songs_dir:import.meta.dir,beatmap:{checksum:createHash('md5').update(await Bun.file(selected).arrayBuffer()).digest('hex'),mode,folder:import.meta.dir,file:selected}});
 if(path==='/tools/_host/v1/bridge.js')return new Response(bridge,{headers:{'content-type':'text/javascript'}});
 if(path==='/tools/_host/v1/theme.css')return new Response(theme,{headers:{'content-type':'text/css'}});
 if(path.endsWith('/_settings'))return Response.json({values:{}});
 const proxy=/^\/tools\/([^/]+)\/api\/(.*)$/.exec(path);
 if(proxy){const [,id,route]=proxy;if(id==='server-pp'&&!optional)return Response.json({error:'optional tool disabled'},{status:404});
  if(!ports[id])return new Response('tool not started',{status:404});
  return fetch(`http://127.0.0.1:${ports[id]}/${route}${url.search}`,{method:request.method,headers:{'x-vosu-tool-token':token},body:request.method==='GET'?undefined:await request.arrayBuffer()});}
 const relative=path==='/'?'index.html':path.slice(1);
 if(relative.includes('..'))return new Response('invalid path',{status:400});
 const file=Bun.file(join(root,'tools/map-analysis/web/dist',relative));
 return await file.exists()?new Response(file):new Response('not found',{status:404});
}});
const children=[];
for(const id of ['server-pp','map-analysis']){
 const data=join(out,id);await mkdir(data,{recursive:true});
 const child=Bun.spawn([join(root,'target/debug',`vosu-${id}`)],{stdin:'pipe',stdout:'pipe',stderr:'inherit',env:{...process.env,VOSU_TOOL_PROTOCOL:'1',VOSU_TOOL_ID:id,VOSU_TOOL_TOKEN:token,VOSU_URL:server.url.origin,VOSU_TOOL_DATA_DIR:data,VOSU_TOOL_CACHE_DIR:data}});
 children.push(child);const reader=child.stdout.getReader();let line='';
 while(!line.includes('\n')){const {value,done}=await reader.read();if(done)throw Error(`${id} failed startup`);line+=new TextDecoder().decode(value);}
 ports[id]=Number(/vosu-tool-ready (\d+)/.exec(line)?.[1]);reader.releaseLock();
}
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const receipts=[];
try{
 for(const test of [
  {chart:'osu-4.osu',native:'osu',played:'osu'},
  {chart:'taiko-4.osu',native:'taiko',played:'taiko'},
  {chart:'fruits-4.osu',native:'fruits',played:'fruits'},
  {chart:'mania-7k.osu',native:'mania',played:'mania'},
  {chart:'osu-4.osu',native:'osu',played:'taiko'},
  {chart:'osu-4.osu',native:'osu',played:'fruits'},
  {chart:'osu-4.osu',native:'osu',played:'mania'},
 ]){
  selected=join(import.meta.dir,'fixtures/demo',test.chart);mode=test.native;played=test.played;
  for(const theme of ['dark','light'])for(const [width,height] of [[1920,1080],[1280,720]]){
   const page=await browser.newPage({viewport:{width,height}});const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
   await page.goto(server.url.origin);await page.locator('#title:not(:text("No map yet"))').waitFor({timeout:120000});
   await page.waitForFunction(()=>document.getElementById('live')?.textContent!=='Analysing');
   await page.evaluate((theme:string)=>document.documentElement.setAttribute('data-theme',theme),theme);
   if(errors.length)throw Error(errors.join('; '));
   const toast=await page.locator('#toast').textContent();if(await page.locator('#toast').isVisible())throw Error(toast??'unknown UI error');
   if(!await page.locator('#performance').textContent())throw Error('missing pp targets');
   const scroll=await page.evaluate(()=>({height:document.documentElement.scrollHeight,viewport:innerHeight,width:document.documentElement.scrollWidth,viewWidth:innerWidth}));
   if(scroll.height>height+1||scroll.width>width+1)throw Error(`page scroll ${JSON.stringify(scroll)}`);
   const name=`${test.native}-${test.played}-${theme}-${width}`;
   await page.screenshot({path:join(out,name+'.png')});receipts.push({name,scroll,errors});await page.close();
  }
 }
 optional=false;selected=join(import.meta.dir,'fixtures/demo/osu-4.osu');mode=played='osu';
 const response=await fetch(server.url+'tools/map-analysis/api/v1/beatmap/current?rate=1');const result=await response.json();
 if(!result.performance.reason||!Number.isFinite(result.stars))throw Error('optional dependency disabled broke analysis');
 const removed=await fetch(server.url+`tools/map-analysis/api/v1/beatmap/${result.checksum}/rates`);if(removed.status!==404)throw Error('removed rates route is still present');
 await Bun.write(join(out,'receipt.json'),JSON.stringify({real:['map-analysis service','server-pp service','dashboard bundle','vosu theme CSS'],mocked:['host selected-map context','bridge telemetry and settings'],receipts,optional:result.performance,removedRateRoute:removed.status},null,2));
}finally{await browser.close();for(const child of children){child.stdin.end();await child.exited;}server.stop();}
