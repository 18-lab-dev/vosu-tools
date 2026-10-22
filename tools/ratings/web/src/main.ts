import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
type Rating = {checksum:string;title:string;artist:string;version:string;rate:number;keys:number;notes:number;msd:Record<string,number>|null;interlude:number|null;quaver:number|null;stars:number|null;unsupported:string|null;dan:{label:string;value:number}|null};
type Point = {time:number;value:number;nps:number};
type Timeline = {duration:number;units:string;window:number;hop:number;points:Point[]};
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const input = (id:string) => $<HTMLInputElement>(id);
const status = (message:string) => $('status').textContent = message;
const fmt = (n:number|null|undefined) => n == null ? '—' : n.toFixed(2);
let rating:Rating|undefined, timeline:Timeline|undefined, selection:number|undefined, generation=0;
let selectedFile:File|undefined;
async function api<T>(path:string,init?:RequestInit):Promise<T> {
 const response = await vosu.fetch(path,init);
 const result = await response.json();
 if(!response.ok) throw Error(result.error || `Ratings unavailable (${response.status})`);
 return result as T;
}
function cards(r:Rating) {
 const target=$('summary'); target.replaceChildren();
 for(const [label,value,unit] of [['Etterna',r.msd?.overall,'MSD / HEADS'],['Quaver',r.quaver,'DIFFICULTY'],['Interlude',r.interlude,'PHYSICAL'],['osu!mania',r.stars,'STARS / REFERENCE']] as const) {
  const card=document.createElement('article'); const name=document.createElement('h3'); name.textContent=label;
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
 const w=rect.width,h=canvas.height/dpr,max=Math.max(1,...points.map(p=>p[field])),duration=timeline?.duration||1;
 ctx.clearRect(0,0,w,h);ctx.strokeStyle='#47484b';ctx.fillStyle='#92959b';ctx.font='11px monospace';
 for(let i=1;i<4;i++){const y=i*h/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
 ctx.fillStyle=field==='nps'?'#858c98':'#ff963f';ctx.globalAlpha=.75;
 for(const p of points){const x=p.time/duration*w,bar=Math.max(1,(timeline?.hop||.25)/duration*w);ctx.fillRect(x,h-20-p[field]/max*(h-35),bar,p[field]/max*(h-35));}
 ctx.globalAlpha=1;ctx.fillStyle='#a6a9af';ctx.fillText(`0:00 · peak ${max.toFixed(1)}`,5,h-5);ctx.fillText(`${Math.floor(duration/60)}:${Math.floor(duration%60).toString().padStart(2,'0')}`,w-45,h-5);
 if(range){ctx.fillStyle='#ffffff30';ctx.fillRect(range[0]/duration*w,0,(range[1]-range[0])/duration*w,h);}
}
async function loadTimeline(id:number) {
 if(!rating)return;
 const system=$<HTMLSelectElement>('system').value;
 const t=await api<Timeline>(`v1/beatmap/${rating.checksum}/timeline?rate=${rating.rate}&system=${system}&window=${input('window').value}&hop=${input('hop').value}`);
 if(id!==generation)return;
 timeline=t;draw($<HTMLCanvasElement>('timeline'),t.points,'value');draw($<HTMLCanvasElement>('density'),t.points,'nps');
 $('timeline-caption').textContent=`${t.units} · ${t.window}s window / ${t.hop}s hop / no smoothing · chart-time axis. Drag a phrase to rate it.`;
}
function rateCurve(rates:{rate:number;msd:{overall:number}|null}[]) {
 const svg=$('curve');svg.replaceChildren();
 const max=Math.max(1,...rates.map(p=>p.msd?.overall||0));
 const line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('points',rates.map(p=>`${35+(p.rate-.5)/1.5*540},${195-(p.msd?.overall||0)/max*170}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#ff963f');line.setAttribute('stroke-width','3');svg.append(line);
 for(const r of rates.filter((_,i)=>i%5===0)){const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x',String(20+(r.rate-.5)/1.5*540));text.setAttribute('y','224');text.textContent=`${r.rate.toFixed(2)}×`;svg.append(text);}
}
async function analyze(file:File|undefined=selectedFile) {
 selectedFile=file;
 const id=++generation;status('Calculating native models…');
 try {
  const rate=Number(input('rate').value);
  const r=await api<Rating>(file?`v1/calculate?rate=${rate}`:`v1/beatmap/current?rate=${rate}`,file?{method:'POST',body:await file.arrayBuffer()}:undefined);
  if(id!==generation)return;rating=r;cards(r);
  if(r.unsupported)throw Error(r.unsupported);
  $('title').textContent=file?.name || `${r.artist} — ${r.title} [${r.version}]`;
  await loadTimeline(id);
  const curve=await api<{rates:{rate:number;msd:{overall:number}|null}[]}>(`v1/beatmap/${r.checksum}/rates?step=0.05`);
  if(id!==generation)return;rateCurve(curve.rates);status('Analysis ready · models have independent scales and cannot be compared numerically.');
 }catch(e){if(id===generation)status(String(e));}
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
for(const id of ['system','window','hop'])$(id).onchange=()=>void loadTimeline(generation).catch(e=>status(String(e)));
input('rate').onchange=()=>void analyze();
new ResizeObserver(()=>{if(timeline){draw(canvas,timeline.points,'value');draw($<HTMLCanvasElement>('density'),timeline.points,'nps');}}).observe(canvas);
await vosu.ready;
$<HTMLAnchorElement>('dashboard').href=vosu.dashboardUrl;
input('file').disabled=!vosu.canWrite;
if(!vosu.canWrite)input('file').title='Open Ratings from the dashboard to import a file';
void analyze();
