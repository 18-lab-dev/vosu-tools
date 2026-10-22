import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
type Rating = {checksum:string;title:string;artist:string;version:string;rate:number;keys:number;notes:number;msd:Record<string,number>|null;interlude:number|null;quaver:number|null;stars:number|null;unsupported:string|null;dan:{label:string;value:number}|null};
type Point = {time:number;value:number;nps:number};
type Timeline = {duration:number;units:string;mode?:string;overall?:number;window:number;hop:number;points:Point[]};
type RatePoint = {rate:number;msd:{overall:number}|null};
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const input = (id:string) => $<HTMLInputElement>(id);
const status = (message:string,state:'busy'|'ready'|'error'='ready') => {const el=$('status');el.textContent=message;el.dataset.state=state;};
const fmt = (n:number|null|undefined) => n == null ? '—' : n.toFixed(2);
const lightQuery = matchMedia('(prefers-color-scheme: light)');
// The dashboard's mode wins; older bridges lack colorScheme, so follow the OS.
document.documentElement.dataset.scheme = vosu.colorScheme ?? (lightQuery.matches ? 'light' : 'dark');
let rating:Rating|undefined, timeline:Timeline|undefined, curve:RatePoint[]|undefined, selection:number|undefined, generation=0;
let selectedFile:File|undefined;
// Canvas cannot read light-dark() tokens, so resolve them through a probe.
const probe=document.createElement('i');probe.hidden=true;document.body.append(probe);
function paint(token:string){probe.style.color=`var(--${token})`;return getComputedStyle(probe).color;}
const MONO='"Martian Mono", ui-monospace, monospace';
async function api<T>(path:string,init?:RequestInit):Promise<T> {
 const response = await vosu.fetch(path,init);
 const result = await response.json();
 if(!response.ok) throw Error(result.error || `Ratings unavailable (${response.status})`);
 return result as T;
}
function cards(r:Rating) {
 const target=$('summary'); target.replaceChildren();
 for(const [system,label,value,unit] of [['etterna','Etterna',r.msd?.overall,'MSD / HEADS'],['quaver','Quaver',r.quaver,'DIFFICULTY'],['interlude','Interlude',r.interlude,'PHYSICAL'],['osu','osu!mania',r.stars,'STARS / REFERENCE']] as const) {
  const card=document.createElement('article'); card.dataset.system=system;
  const name=document.createElement('h3'); name.textContent=label;
  const number=document.createElement('strong'); number.textContent=fmt(value);
  const caption=document.createElement('small'); caption.textContent=unit;
  card.append(name,number,caption);target.append(card);
 }
 $('meta').textContent=`${r.keys} KEYS / ${r.notes.toLocaleString()} NOTES / ${r.rate.toFixed(2)}× / ${r.checksum}`;
 $('skills').replaceChildren();
 for(const [name,value] of Object.entries(r.msd||{}).filter(([key])=>key!=='overall')) {
  const row=document.createElement('div'); row.className='skill';
  const label=document.createElement('span');label.textContent=name.replace('speed',' speed');
  const bar=document.createElement('meter');bar.min=0;bar.max=Math.max(30,...Object.values(r.msd||{}));bar.value=value;
  const number=document.createElement('b');number.textContent=fmt(value);row.append(label,bar,number);$('skills').append(row);
 }
 $('dan').textContent=r.dan?`${r.dan.label} · ${fmt(r.dan.value)} / EXPERIMENTAL Reform calibration, not a certification.`:'Experimental Reform estimate: outside calibration or unsupported key count.';
}
function draw(canvas:HTMLCanvasElement,points:Point[],field:'value'|'nps',range?:[number,number]) {
 const rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;
 canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round((canvas.id==='density'?110:200)*dpr);
 const ctx=canvas.getContext('2d')!;ctx.scale(dpr,dpr);
 const w=rect.width,h=canvas.height/dpr,peak=Math.max(1,...points.map(p=>p[field])),duration=timeline?.duration||1;
 const local=field==='value'&&timeline?.mode==='local_msd';
 const max=local?Math.max(40,Math.ceil(Math.max(peak,timeline?.overall||0)/10)*10):peak;
 const top=15,plot=h-35,y=(v:number)=>h-20-v/max*plot;
 const ink=paint('ink'),muted=paint('muted'),rule=paint('rule-strong'),bands=[0,1,2,3,4].map(i=>paint(`band-${i}`)),nps=paint('sys-nps');
 ctx.clearRect(0,0,w,h);ctx.font=`400 10px ${MONO}`;ctx.lineWidth=1;
 // Data-aligned rules: every 10 MSD in local mode (the colour band edges), quarters otherwise.
 const steps=local?Array.from({length:max/10-1},(_,i)=>(i+1)*10):[1,2,3].map(i=>i*max/4);
 ctx.strokeStyle=rule;ctx.globalAlpha=.7;
 for(const v of steps){const ly=Math.round(y(v))+.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();}
 ctx.globalAlpha=1;
 for(const p of points){
  const x=p.time/duration*w,bar=Math.max(1,(timeline?.hop||1)/duration*w);
  ctx.fillStyle=field==='nps'?nps:bands[p.value<10?0:p.value<20?1:p.value<30?2:p.value<40?3:4];
  ctx.fillRect(x,y(p[field]),bar,p[field]/max*plot);
 }
 // Labels sit on a paper chip so they stay legible over dense bars.
 const surface=paint('surface');
 const chip=(text:string,x:number,baseline:number,color:string)=>{const width=ctx.measureText(text).width;ctx.fillStyle=surface;ctx.globalAlpha=.85;ctx.fillRect(x-3,baseline-10,width+6,14);ctx.globalAlpha=1;ctx.fillStyle=color;ctx.fillText(text,x,baseline);};
 for(const v of steps)chip(local?String(v):v.toFixed(1),5,Math.max(top,y(v)-4),muted);
 if(local&&timeline?.overall!==undefined){
  const ly=y(timeline.overall);ctx.setLineDash([3,4]);ctx.strokeStyle=ink;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();ctx.setLineDash([]);
  const label=`MAP ${timeline.overall.toFixed(2)} MSD`;
  chip(label,Math.max(5,w-ctx.measureText(label).width-8),Math.max(12,ly-6),ink);
 }
 ctx.fillStyle=muted;
 const end=`${Math.floor(duration/60)}:${Math.floor(duration%60).toString().padStart(2,'0')}`;
 ctx.fillText(`0:00 · ${local?`0–${max} MSD · `:''}peak ${peak.toFixed(1)}`,5,h-6);ctx.fillText(end,w-ctx.measureText(end).width-6,h-6);
 if(range){
  const x0=range[0]/duration*w,x1=range[1]/duration*w;
  ctx.fillStyle=paint('pen');ctx.globalAlpha=.16;ctx.fillRect(x0,0,x1-x0,h);ctx.globalAlpha=1;
  ctx.strokeStyle=paint('pen');ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,h);ctx.moveTo(x1,0);ctx.lineTo(x1,h);ctx.stroke();
 }
}
function redraw(){
 if(timeline){draw(canvas,timeline.points,'value');draw($<HTMLCanvasElement>('density'),timeline.points,'nps');}
}
async function loadTimeline(id:number) {
 if(!rating)return;
 const system=$<HTMLSelectElement>('system').value;
 const t=await api<Timeline>(`v1/beatmap/${rating.checksum}/timeline?rate=${rating.rate}&system=${system}&window=${input('window').value}&hop=${input('hop').value}`);
 if(id!==generation)return;
 timeline=t;redraw();
 $('timeline-caption').textContent=`${t.units} · ${t.window}s ${t.mode==='local_msd'?'centered, reset-context ':''}window / ${t.hop}s hop / no smoothing · chart-time axis. ${t.mode==='local_msd'?'Dotted line = whole-map MSD. Colour bands: <10 / 10–20 / 20–30 / 30–40 / 40+. ':''}Drag a phrase to rate it.`;
}
function svg<K extends keyof SVGElementTagNameMap>(tag:K,attributes:Record<string,string|number>,text?:string) {
 const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
 if(text!==undefined)node.textContent=text;
 return node;
}
function rateCurve(rates:RatePoint[]) {
 curve=rates;
 const target=$('curve');target.replaceChildren();
 const max=Math.max(1,...rates.map(p=>p.msd?.overall||0));
 const x=(rate:number)=>44+(rate-.5)/1.5*516,y=(v:number)=>200-v/max*175;
 for(const fraction of [.25,.5,.75,1]){
  const value=max*fraction;
  target.append(svg('line',{class:'grid',x1:44,x2:560,y1:y(value),y2:y(value)}),svg('text',{x:4,y:y(value)+4},value.toFixed(0)));
 }
 target.append(svg('polyline',{class:'trace',points:rates.map(p=>`${x(p.rate)},${y(p.msd?.overall||0)}`).join(' ')}));
 for(const r of rates.filter((_,i)=>i%5===0))target.append(svg('text',{x:x(r.rate),y:230,'text-anchor':'middle'},`${r.rate.toFixed(2)}×`));
 const current=rating&&rates.find(p=>Math.abs(p.rate-rating!.rate)<1e-6);
 if(current?.msd)target.append(svg('circle',{class:'marker',cx:x(current.rate),cy:y(current.msd.overall),r:5.5}));
}
async function analyze(file:File|undefined=selectedFile) {
 selectedFile=file;
 const id=++generation;status('Calculating native models…','busy');
 try {
  const rate=Number(input('rate').value);
  const r=await api<Rating>(file?`v1/calculate?rate=${rate}`:`v1/beatmap/current?rate=${rate}`,file?{method:'POST',body:await file.arrayBuffer()}:undefined);
  if(id!==generation)return;rating=r;cards(r);
  if(r.unsupported)throw Error(r.unsupported);
  $('title').textContent=file?.name || `${r.artist} — ${r.title} [${r.version}]`;
  await loadTimeline(id);
  const result=await api<{rates:RatePoint[]}>(`v1/beatmap/${r.checksum}/rates?step=0.05`);
  if(id!==generation)return;rateCurve(result.rates);status('Analysis ready · models have independent scales and cannot be compared numerically.');
 }catch(e){if(id===generation)status(String(e),'error');}
}
async function section() {
 if(!rating)return;
 try{
  const result=await api<{rating:Rating}>(`v1/beatmap/${rating.checksum}/section?start=${input('start').value}&end=${input('end').value}&rate=${rating.rate}`);
  const r=result.rating;$('section-result').textContent=`Etterna ${fmt(r.msd?.overall)} · Quaver ${fmt(r.quaver)} · Interlude ${fmt(r.interlude)} · ${fmt(r.stars)} ★ (reset context)`;
 }catch(e){$('section-result').textContent=String(e);}
}
const canvas=$<HTMLCanvasElement>('timeline');
function position(e:PointerEvent){const rect=canvas.getBoundingClientRect();return Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*(timeline?.duration||0);}
canvas.addEventListener('pointerdown',e=>{selection=position(e);canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(selection!==undefined&&timeline)draw(canvas,timeline.points,'value',[Math.min(selection,position(e)),Math.max(selection,position(e))]);});
canvas.addEventListener('pointerup',e=>{if(selection===undefined)return;const a=Math.min(selection,position(e)),b=Math.max(selection,position(e));selection=undefined;input('start').value=a.toFixed(2);input('end').value=b.toFixed(2);void section();});
$('refresh').onclick=()=>{selectedFile=undefined;void analyze();};$('section').onclick=()=>void section();
input('file').onchange=()=>{const file=input('file').files?.[0];if(file)void analyze(file);};
for(const id of ['window','hop'])$(id).onchange=()=>void loadTimeline(generation).catch(e=>status(String(e),'error'));
$('system').onchange=()=>{
 const local=$<HTMLSelectElement>('system').value==='etterna';input('window').value=local?'12':'1';input('hop').value=local?'1':'0.25';
 void loadTimeline(generation).catch(e=>status(String(e),'error'));
};
input('rate').onchange=()=>void analyze();
new ResizeObserver(redraw).observe(canvas);
// Canvas text needs the bundled mono face; repaint once it has loaded.
void document.fonts.ready.then(redraw);
// Without a dashboard hint the palette follows the OS live; repaint canvases with it.
lightQuery.addEventListener('change',()=>{if(vosu.colorScheme)return;document.documentElement.dataset.scheme=lightQuery.matches?'light':'dark';redraw();if(curve)rateCurve(curve);});
await vosu.ready;
$<HTMLAnchorElement>('dashboard').href=vosu.dashboardUrl;
input('file').disabled=!vosu.canWrite;
if(!vosu.canWrite)input('file').title='Open Ratings from the dashboard to import a file';
void analyze();
