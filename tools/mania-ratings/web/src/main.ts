import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
type Rating = {checksum:string;title:string;artist:string;version:string;rate:number;keys:number;notes:number;msd:Record<string,number>|null;interlude:number|null;quaver:number|null;stars:number|null;unsupported:string|null;dan:{label:string;value:number}|null};
type Point = {time:number;value:number;nps:number};
type Timeline = {duration:number;units:string;mode?:string;overall?:number;window:number;hop:number;points:Point[]};
type RatePoint = {rate:number;msd:{overall:number}|null};
const SYSTEMS = ['etterna','etterna-native','quaver','interlude','osu','nps'] as const;
type System = typeof SYSTEMS[number];
type Settings = {follow_game:boolean;show_etterna:boolean;show_quaver:boolean;show_interlude:boolean;show_osu:boolean;show_reform:boolean;timeline_system:System;local_window:number;local_hop:number;strain_window:number;strain_hop:number;rate_step:string};
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const input = (id:string) => $<HTMLInputElement>(id);
const status = (message:string,state:'busy'|'ready'|'warn'|'error'='ready') => {const el=$('status');el.textContent=message;el.title=message;el.dataset.state=state;};
const fmt = (n:number|null|undefined) => n == null ? '—' : n.toFixed(2);
const lightQuery = matchMedia('(prefers-color-scheme: light)');
// The dashboard's mode wins; older bridges lack colorScheme, so follow the OS.
document.documentElement.dataset.scheme = vosu.colorScheme ?? (lightQuery.matches ? 'light' : 'dark');

// Effective settings: bridge helper, then the UI-readable route, then schema defaults.
const flag=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
const bounded=(value:unknown,fallback:number,min:number,max:number)=>{const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:fallback;};
function normalize(v:Record<string,unknown>={}):Settings {
 return {
  follow_game:flag(v.follow_game,true),show_etterna:flag(v.show_etterna,true),show_quaver:flag(v.show_quaver,true),
  show_interlude:flag(v.show_interlude,true),show_osu:flag(v.show_osu,true),show_reform:flag(v.show_reform,true),
  timeline_system:SYSTEMS.find(s=>s===v.timeline_system)??'etterna',
  local_window:bounded(v.local_window,12,.1,60),local_hop:bounded(v.local_hop,1,.05,60),
  strain_window:bounded(v.strain_window,1,.1,60),strain_hop:bounded(v.strain_hop,.25,.05,60),
  rate_step:['0.05','0.1','0.25'].includes(String(v.rate_step))?String(v.rate_step):'0.05',
 };
}
async function loadSettings():Promise<Settings> {
 try{if(vosu.settings)return normalize(await vosu.settings());}catch{/* older host: try the route */}
 try{
  const response=await fetch(`/tools/${encodeURIComponent(vosu.tool.id)}/_settings`,{credentials:'omit'});
  const body:unknown=response.ok?await response.json():undefined;
  if(body&&typeof body==='object'&&'values' in body&&body.values&&typeof body.values==='object')return normalize(Object.fromEntries(Object.entries(body.values)));
 }catch{/* defaults below */}
 return normalize();
}

let settings=normalize();
let rating:Rating|undefined, timeline:Timeline|undefined, curve:RatePoint[]|undefined, selection:number|undefined, generation=0;
let pendingFile:File|undefined, fileName:string|undefined, follow=true, timelineTouched=false, analysedKey='', pending:number|undefined;
const live={connected:false,connecting:true,checksum:'',rate:1,mods:'',state:-1,time:0,mode:''};
const app=document.querySelector<HTMLElement>('.app')!;
const canvas=$<HTMLCanvasElement>('timeline'), density=$<HTMLCanvasElement>('density');

// Canvas cannot read light-dark() tokens, so resolve them through a probe.
const probe=document.createElement('i');probe.hidden=true;document.body.append(probe);
function paint(token:string){probe.style.color=`var(--${token})`;return getComputedStyle(probe).color;}
const MONO='"Martian Mono", ui-monospace, monospace';
const labelSize=()=>Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize)*.68);

async function api<T>(path:string,init?:RequestInit):Promise<T> {
 const response = await vosu.fetch(path,init);
 const result = await response.json();
 if(!response.ok) throw Error(result.error || `Mania ratings unavailable (${response.status})`);
 return result as T;
}
function setLive(){
 const el=$('live');
 const state=!live.connected?(live.connecting?'connecting':'offline'):!follow?'manual':live.state===2?'playing':'live';
 el.dataset.state=state;
 el.textContent={connecting:'Connecting',offline:'Offline',manual:'Manual',playing:'In play',live:'Live'}[state];
 el.title=state==='manual'?'Not following the game; press Follow game to resume':state==='offline'?'vosu telemetry disconnected; the bridge reconnects automatically':state==='connecting'?'Connecting to vosu telemetry':'Following the map and rate selected in osu!';
 $('follow').setAttribute('aria-pressed',String(follow));
 const mods=$('mods');mods.hidden=!live.mods||live.mods==='NM';mods.textContent=live.mods;
}
function cards(r:Rating) {
 const target=$('summary'); target.replaceChildren();
 const rows:[string,boolean,string,number|null|undefined,string][]=[
  ['etterna',settings.show_etterna,'Etterna',r.msd?.overall,'MSD · MINACALC 527'],['quaver',settings.show_quaver,'Quaver',r.quaver,'DIFFICULTY'],
  ['interlude',settings.show_interlude,'Interlude',r.interlude,'PHYSICAL'],['osu',settings.show_osu,'osu!mania',r.stars,'STARS · REFERENCE'],
 ];
 for(const [system,shown,label,value,unit] of rows) {
  if(!shown)continue;
  const card=document.createElement('article'); card.dataset.system=system;
  const name=document.createElement('h3'); name.textContent=label;
  const number=document.createElement('strong'); number.textContent=fmt(value);
  const caption=document.createElement('small'); caption.textContent=unit;
  card.append(name,number,caption);target.append(card);
 }
 if(settings.show_reform){
  const card=document.createElement('article');card.dataset.system='reform';card.className='reform';
  const name=document.createElement('h3');name.textContent='Reform estimate';
  const number=document.createElement('strong');number.textContent=r.dan?r.dan.label:'—';
  const caption=document.createElement('small');caption.textContent=r.dan?`${fmt(r.dan.value)} · EXPERIMENTAL, NOT A CERTIFICATION`:'OUTSIDE CALIBRATION OR UNSUPPORTED KEYS';
  card.append(name,number,caption);target.append(card);
 }
 $('skills').replaceChildren();
 const skills=Object.entries(r.msd||{}).filter(([key])=>key!=='overall');
 const top=skills.filter(([key])=>key!=='stamina').reduce<[string,number]|undefined>((best,entry)=>!best||entry[1]>best[1]?entry:best,undefined);
 for(const [name,value] of skills) {
  const row=document.createElement('div'); row.className=name===top?.[0]?'skill top':'skill';
  const label=document.createElement('span');label.textContent=name.replace('speed',' speed');
  const bar=document.createElement('meter');bar.min=0;bar.max=Math.max(30,...Object.values(r.msd||{}));bar.value=value;
  const number=document.createElement('b');number.textContent=fmt(value);row.append(label,bar,number);$('skills').append(row);
 }
}
function frame(element:Element){return element.parentElement as HTMLElement;}
function draw(target:HTMLCanvasElement,points:Point[],field:'value'|'nps',range?:[number,number]) {
 const rect=frame(target).getBoundingClientRect(),dpr=devicePixelRatio||1;
 target.width=Math.max(1,Math.round(rect.width*dpr));target.height=Math.max(1,Math.round(rect.height*dpr));
 const ctx=target.getContext('2d')!;ctx.scale(dpr,dpr);
 const w=rect.width,h=rect.height,size=labelSize(),peak=Math.max(1,...points.map(p=>p[field])),duration=timeline?.duration||1;
 const local=field==='value'&&timeline?.mode==='local_msd';
 const max=local?Math.max(40,Math.ceil(Math.max(peak,timeline?.overall||0)/10)*10):peak;
 const top=size+6,bottom=size+10,plot=Math.max(1,h-top-bottom),y=(v:number)=>h-bottom-v/max*plot;
 const ink=paint('ink'),muted=paint('muted'),surface=paint('surface'),bands=[0,1,2,3,4].map(i=>paint(`band-${i}`)),nps=paint('sys-nps');
 const playing=live.state===2&&follow&&rating?.checksum===live.checksum;
 ctx.clearRect(0,0,w,h);ctx.font=`400 ${size}px ${MONO}`;ctx.lineWidth=1;
 // Data-aligned rules: every 10 MSD in local mode (the colour band edges), quarters otherwise.
 const steps=local?Array.from({length:max/10-1},(_,i)=>(i+1)*10):[1,2,3].map(i=>i*max/4);
 ctx.strokeStyle=paint('rule-strong');ctx.globalAlpha=.7;
 for(const v of steps){const ly=Math.round(y(v))+.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();}
 for(const p of points){
  const x=p.time/duration*w,bar=Math.max(1,(timeline?.hop||1)/duration*w);
  ctx.globalAlpha=playing&&p.time>live.time?.35:1;
  ctx.fillStyle=field==='nps'?nps:bands[p.value<10?0:p.value<20?1:p.value<30?2:p.value<40?3:4];
  ctx.fillRect(x,y(p[field]),bar,p[field]/max*plot);
 }
 ctx.globalAlpha=1;
 // Labels sit on a paper chip so they stay legible over dense bars.
 const chip=(text:string,x:number,baseline:number,color:string)=>{const width=ctx.measureText(text).width;ctx.fillStyle=surface;ctx.globalAlpha=.85;ctx.fillRect(x-3,baseline-size,width+6,size+4);ctx.globalAlpha=1;ctx.fillStyle=color;ctx.fillText(text,x,baseline);};
 for(const v of steps)chip(local?String(v):v.toFixed(1),5,Math.max(top,y(v)-4),muted);
 if(local&&timeline?.overall!==undefined){
  const ly=y(timeline.overall);ctx.setLineDash([3,4]);ctx.strokeStyle=ink;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();ctx.setLineDash([]);
  const label=`MAP ${timeline.overall.toFixed(2)} MSD`;
  chip(label,Math.max(5,w-ctx.measureText(label).width-8),Math.max(top,ly-6),ink);
 }
 ctx.fillStyle=muted;
 const clock=(s:number)=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
 const end=clock(duration);
 ctx.fillText(`0:00 · ${local?`0–${max} MSD · `:''}peak ${peak.toFixed(1)}`,5,h-5);ctx.fillText(end,w-ctx.measureText(end).width-6,h-5);
 if(range){
  const x0=range[0]/duration*w,x1=range[1]/duration*w;
  ctx.fillStyle=paint('pen');ctx.globalAlpha=.16;ctx.fillRect(x0,0,x1-x0,h);ctx.globalAlpha=1;
  ctx.strokeStyle=paint('pen');ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,h);ctx.moveTo(x1,0);ctx.lineTo(x1,h);ctx.stroke();
 }
 if(playing){
  const x=Math.max(0,Math.min(w,live.time/duration*w));
  ctx.strokeStyle=ink;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
  chip(clock(Math.max(0,live.time)),Math.min(w-50,x+6),top,ink);
 }
}
function svg<K extends keyof SVGElementTagNameMap>(tag:K,attributes:Record<string,string|number>,text?:string) {
 const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
 if(text!==undefined)node.textContent=text;
 return node;
}
function rateCurve() {
 const target=$('curve'),ladder=$('ladder');target.replaceChildren();ladder.replaceChildren();
 if(!curve)return;
 // Drawn in CSS pixels so labels keep their size whatever the cell's aspect.
 const rect=frame(target).getBoundingClientRect(),w=Math.max(1,rect.width),h=Math.max(1,rect.height),size=labelSize();
 target.setAttribute('viewBox',`0 0 ${w} ${h}`);
 const max=Math.max(1,...curve.map(p=>p.msd?.overall||0));
 const left=size*2.6,right=w-size*2,top=size*1.2,base=h-size*2.2;
 const x=(rate:number)=>left+(rate-.5)/1.5*(right-left),y=(v:number)=>base-v/max*(base-top);
 for(const fraction of [.25,.5,.75,1]){
  const value=max*fraction;
  target.append(svg('line',{class:'grid',x1:left,x2:right,y1:y(value),y2:y(value)}),svg('text',{x:6,y:y(value)+size/3,'font-size':size},value.toFixed(0)));
 }
 if(!follow&&live.connected&&live.rate>=.5&&live.rate<=2)target.append(svg('line',{class:'game',x1:x(live.rate),x2:x(live.rate),y1:top,y2:base}));
 target.append(svg('polyline',{class:'trace',points:curve.map(p=>`${x(p.rate)},${y(p.msd?.overall||0)}`).join(' ')}));
 const every=Math.max(1,Math.round(.25/(curve[1]?.rate-curve[0]?.rate||.25)));
 for(const r of curve.filter((_,i)=>i%every===0))target.append(svg('text',{x:x(r.rate),y:h-size*.7,'text-anchor':'middle','font-size':size},`${r.rate.toFixed(2)}×`));
 const current=rating&&curve.find(p=>Math.abs(p.rate-rating!.rate)<1e-6);
 if(current?.msd)target.append(svg('circle',{class:'marker',cx:x(current.rate),cy:y(current.msd.overall),r:size*.4}));
 // Five curve steps centred on the analysed rate (nearest step when off-grid).
 const analysed=rating?.rate??1,nearest=curve.reduce((best,p,i)=>Math.abs(p.rate-analysed)<Math.abs(curve![best].rate-analysed)?i:best,0);
 const first=Math.max(0,Math.min(curve.length-5,nearest-2));
 for(const p of curve.slice(first,first+5)){
  const item=document.createElement('li'),value=document.createElement('b');
  item.textContent=`${p.rate.toFixed(2)}×`;value.textContent=fmt(p.msd?.overall);item.append(value);
  if(Math.abs(p.rate-analysed)<1e-6)item.setAttribute('aria-current','true');
  ladder.append(item);
 }
}
function redraw(){
 for(const element of [canvas,density,$('curve')])frame(element).dataset.state=rating?'ready':'empty';
 if(timeline){draw(canvas,timeline.points,'value');draw(density,timeline.points,'nps');}
 rateCurve();
}
function applyTimelineDefaults(system:System){
 const local=system==='etterna';
 input('window').value=String(local?settings.local_window:settings.strain_window);
 input('hop').value=String(local?settings.local_hop:settings.strain_hop);
}
async function loadTimeline(id:number) {
 if(!rating)return;
 const system=$<HTMLSelectElement>('system').value;
 const t=await api<Timeline>(`v1/beatmap/${rating.checksum}/timeline?rate=${rating.rate}&system=${system}&window=${input('window').value}&hop=${input('hop').value}`);
 if(id!==generation)return;
 timeline=t;redraw();
 $('timeline-caption').textContent=`${t.units} · ${t.window}s ${t.mode==='local_msd'?'centred, reset-context ':''}window / ${t.hop}s hop / no smoothing · chart-time axis. ${t.mode==='local_msd'?'Dotted = whole-map MSD. Bands <10 / 10–20 / 20–30 / 30–40 / 40+. ':''}Drag a phrase to rate it.`;
}
function selectedRate(){return follow?live.rate:Number(input('rate').value);}
// Following: the game's selection. Manual: a newly opened file, else the chart on
// screen re-rated by checksum (its bytes are cached by the service).
async function analyze() {
 const id=++generation,file=pendingFile,rate=selectedRate(),shown=!follow?rating:undefined;
 pendingFile=undefined;
 if(!(rate>=.5&&rate<=2)){app.classList.toggle('stale',Boolean(rating));status(`Rate ${rate.toFixed(2)}× is outside the supported 0.50–2.00× range${rating?'; showing the last analysis':''}.`,'warn');return;}
 if(!file&&!shown&&!live.checksum){status(live.connected?'No beatmap selected in osu!. Pick an osu!mania chart in song select.':'Waiting for vosu telemetry…','warn');return;}
 input('rate').value=rate.toFixed(2);
 status(file?`Calculating ${file.name}…`:'Calculating native models…','busy');
 try {
  const r=await api<Rating>(file?`v1/calculate?rate=${rate}`:shown?`v1/beatmap/${shown.checksum}?rate=${rate}`:`v1/beatmap/current?rate=${rate}`,file?{method:'POST',body:await file.arrayBuffer()}:undefined);
  if(id!==generation)return;
  if(r.unsupported){
   const mode=live.mode&&live.mode!=='mania'&&!file?` (selected map ruleset: ${live.mode})`:'';
   app.classList.toggle('stale',Boolean(rating));
   const reason=r.unsupported.charAt(0).toUpperCase()+r.unsupported.slice(1);
   status(`${reason}${mode}.${rating?` Showing the last analysed chart: ${rating.title} [${rating.version}].`:''}`,'warn');
   return;
  }
  fileName=file?file.name:shown?.checksum===r.checksum?fileName:undefined;
  rating=r;analysedKey=follow?`${r.checksum}:${rate}`:'';app.classList.remove('stale');cards(r);
  $('title').textContent=fileName ?? `${r.artist} — ${r.title} [${r.version}]`;$('title').title=$('title').textContent!;
  $('meta').textContent=`${r.keys}K · ${r.notes.toLocaleString()} notes · ${r.rate.toFixed(2)}× · ${fileName?'local file':follow?'selected in osu!':'manual'} · md5 ${r.checksum.slice(0,10)}…`;
  await loadTimeline(id);
  const result=await api<{rates:RatePoint[]}>(`v1/beatmap/${r.checksum}/rates?step=${settings.rate_step}`);
  if(id!==generation)return;curve=result.rates;rateCurve();
  status('Analysis ready · each model has its own scale; values are not comparable across systems.');
 }catch(e){if(id===generation){app.classList.toggle('stale',Boolean(rating));status(String(e),'error');}}
}
function schedule(delay=250){window.clearTimeout(pending);pending=window.setTimeout(()=>void analyze(),delay);}
async function refreshSettings(){
 const next=await loadSettings(),systemChanged=next.timeline_system!==settings.timeline_system;
 settings=next;
 if(!timelineTouched&&(systemChanged||$<HTMLSelectElement>('system').value!==settings.timeline_system)){$<HTMLSelectElement>('system').value=settings.timeline_system;}
 if(!timelineTouched)applyTimelineDefaults(settings.timeline_system);
 if(rating)cards(rating);
}
function section() {
 if(!rating)return;
 const r0=rating;
 void api<{rating:Rating}>(`v1/beatmap/${r0.checksum}/section?start=${input('start').value}&end=${input('end').value}&rate=${r0.rate}`)
  .then(result=>{const r=result.rating;$('section-result').textContent=`Etterna ${fmt(r.msd?.overall)} · Quaver ${fmt(r.quaver)} · Interlude ${fmt(r.interlude)} · ${fmt(r.stars)} ★ (reset context)`;})
  .catch(e=>{$('section-result').textContent=String(e);});
}

// Live telemetry: selected map, rate, mods and play position.
const FIELDS=['/beatmap/checksum','/beatmap/time/live','/play/mods/rate','/state/number','/play/mods/name','/beatmap/mode/name'];
// The bridge owns the socket and its reconnect backoff; vosu 1.2.0 bridges report
// the connection through onStatus, older ones only deliver frames.
function connect(){
 const values:unknown[]=[];
 vosu.subscribe(FIELDS,message=>{
  if(!Array.isArray(message))return;
  if(message[0]===2){status(`Telemetry: ${String(message[2])}`,'error');return;}
  if(message[0]!==0&&message[0]!==1)return;
  if(!live.connected){live.connected=true;live.connecting=false;}
  if(message[0]===0)values.length=0;
  if(Array.isArray(message[2]))for(const change of message[2])if(Array.isArray(change)&&typeof change[0]==='number')values[change[0]]=change[1];
  if(Array.isArray(message[3]))for(const i of message[3])if(typeof i==='number')delete values[i];
  const wasPlaying=live.state===2,previousRate=live.rate;
  live.checksum=typeof values[0]==='string'?values[0]:'';live.time=Number(values[1]??0)/1000;
  const rate=Number(values[2]??1);live.rate=Number.isFinite(rate)&&rate>0?Math.round(rate*20)/20:1;
  live.state=Number(values[3]??-1);live.mods=typeof values[4]==='string'?values[4]:'';live.mode=typeof values[5]==='string'?values[5]:'';
  setLive();
  if(follow&&`${live.checksum}:${live.rate}`!==analysedKey){analysedKey=`${live.checksum}:${live.rate}`;void refreshSettings().then(()=>schedule());}
  // Only the time-based plots move during play; the curve moves only for the manual-mode game-rate marker.
  if(timeline&&(live.state===2||wasPlaying)){draw(canvas,timeline.points,'value');draw(density,timeline.points,'nps');}
  if(!follow&&live.rate!==previousRate)rateCurve();
 },state=>{live.connected=state==='open';live.connecting=state==='connecting';setLive();});
}

canvas.addEventListener('pointerdown',e=>{if(!timeline)return;selection=position(e);canvas.setPointerCapture(e.pointerId);});
function position(e:PointerEvent){const rect=canvas.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*(timeline?.duration||0);}
canvas.addEventListener('pointermove',e=>{if(selection!==undefined&&timeline)draw(canvas,timeline.points,'value',[Math.min(selection,position(e)),Math.max(selection,position(e))]);});
canvas.addEventListener('pointerup',e=>{if(selection===undefined)return;const a=Math.min(selection,position(e)),b=Math.max(selection,position(e));selection=undefined;input('start').value=a.toFixed(2);input('end').value=b.toFixed(2);section();});
$('section').onclick=section;
$('follow').onclick=()=>{
 follow=!follow;
 if(follow){pendingFile=undefined;input('file').value='';}
 setLive();if(follow){analysedKey=`${live.checksum}:${live.rate}`;schedule(0);}else rateCurve();
};
input('file').onchange=()=>{const file=input('file').files?.[0];if(!file)return;pendingFile=file;follow=false;setLive();schedule(0);};
input('rate').onchange=()=>{follow=false;setLive();schedule(0);};
for(const id of ['window','hop'])$(id).onchange=()=>{timelineTouched=true;void loadTimeline(generation).catch(e=>status(String(e),'error'));};
$('system').onchange=()=>{
 timelineTouched=true;applyTimelineDefaults($<HTMLSelectElement>('system').value as System);
 void loadTimeline(generation).catch(e=>status(String(e),'error'));
};
const resize=new ResizeObserver(redraw);
for(const element of [canvas,density,$('curve')])resize.observe(frame(element));
// Canvas text needs the bundled mono face; repaint once it has loaded.
void document.fonts.ready.then(redraw);
// Without a dashboard hint the palette follows the OS live; repaint canvases with it.
lightQuery.addEventListener('change',()=>{if(vosu.colorScheme)return;document.documentElement.dataset.scheme=lightQuery.matches?'light':'dark';redraw();});
// Dashboard edits to settings apply when the page comes back into view.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshSettings();});

await vosu.ready;
$<HTMLAnchorElement>('dashboard').href=vosu.dashboardUrl;
input('file').disabled=!vosu.canWrite;
if(!vosu.canWrite)$('file').closest('label')!.title='Open Mania ratings from the dashboard to analyse a local file';
await refreshSettings();
follow=settings.follow_game;setLive();redraw();
if(follow)status('Waiting for vosu telemetry…','busy');
else status('Manual mode · set a rate or open a .osu file, or press Follow game.','warn');
connect();
