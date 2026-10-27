import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
import {sections} from './sections';
import {convertedMania} from './played';
import type {Mod,Ruleset} from '@vosu-tools/osu-parse';
import {playedRuleset} from '@vosu-tools/tool-web';
type Unrated = {scope:'keys'|'rate'|'estimate';reason:string};
type Dan = {label:string;value:number;uncertainty?:number};
type Prism = {version:string;overall:number;skillsets:[string,number][];ln:number|null;centre_hand:number};
type Cluster = {pattern:string;specific:[string,number][];bpm:number;mixed:boolean;rating:number|null;amount:number};
type Patterns = {category:string;clusters:Cluster[];ln_percent:number;duration:number};
type LnStats = {notes:number;holds:number;ln_share:number;coverage:number;releases_per_second:number;peak_releases_per_second:number;inverse_share:number|null;offbeat_release_share:number|null;short_share:number|null;indicators:string[]};
type View7k = {categories:{id:string;label:string;coverage:number;main_bpm:number|null;msd:number|null;msd_source:string}[];ln:{id:string;label:string;value:number|null;unit:string;source:string}[]};
type Rating = {mode:string;official:{skills:Record<string,number>;source:string};performance:{targets?:{accuracy:number;pp:number}[];reason?:string};checksum:string;title:string;artist:string;version:string;rate:number;keys:number;notes:number;msd:Record<string,number|null>|null;interlude:number|null;quaver:number|null;stars:number|null;unsupported:string|null;dan:Dan|null;prism?:Prism|null;patterns?:Patterns|null;ln?:LnStats|null;view7k?:View7k|null;dan7k?:Dan|null;unrated?:Record<string,Unrated>};
type Point = {time:number;value:number|null;nps:number};
type Timeline = {duration:number;units:string;mode?:string;overall?:number|null;unrated?:string|null;window:number;hop:number;points:Point[]};
const SYSTEMS = ['etterna','etterna-native','prism','quaver','interlude','osu','ln','nps'] as const;
type System = typeof SYSTEMS[number];
type Settings = {follow_game:boolean;show_etterna:boolean;show_prism:boolean;show_quaver:boolean;show_interlude:boolean;show_osu:boolean;show_reform:boolean;show_dan7k:boolean;timeline_system:System;local_window:number;local_hop:number;strain_window:number;strain_hop:number};
type Notice = {message:string;tone:'busy'|'warn'|'error'};
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const input = (id:string) => $<HTMLInputElement>(id);
const fmt = (n:number|null|undefined) => n == null ? '—' : n.toFixed(2);
const pct = (n:number|null|undefined) => n == null ? '—' : `${Math.round(n*100)}%`;

// Effective settings: bridge helper, then the UI-readable route, then schema defaults.
const flag=(value:unknown,fallback:boolean)=>typeof value==='boolean'?value:fallback;
const bounded=(value:unknown,fallback:number,min:number,max:number)=>{const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:fallback;};
function normalize(v:Record<string,unknown>={}):Settings {
 return {
  follow_game:flag(v.follow_game,true),show_etterna:flag(v.show_etterna,true),show_prism:flag(v.show_prism,true),show_quaver:flag(v.show_quaver,true),
  show_interlude:flag(v.show_interlude,true),show_osu:flag(v.show_osu,true),show_reform:flag(v.show_reform,true),show_dan7k:flag(v.show_dan7k,true),
  timeline_system:SYSTEMS.find(s=>s===v.timeline_system)??'etterna',
  local_window:bounded(v.local_window,12,.1,60),local_hop:bounded(v.local_hop,1,.05,60),
  strain_window:bounded(v.strain_window,1,.1,60),strain_hop:bounded(v.strain_hop,.25,.05,60),
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
let rating:Rating|undefined, timeline:Timeline|undefined, selection:number|undefined, generation=0;
let pendingFile:File|undefined, fileName:string|undefined, follow=true, timelineTouched=false, analysedKey='', pending:number|undefined;
let notice:Notice|undefined;
const live={connected:false,connecting:true,checksum:'',rate:1,mods:'',state:-1,time:0,mode:''};
const canvas=$<HTMLCanvasElement>('timeline'), density=$<HTMLCanvasElement>('density');
const maniaSystems=$<HTMLSelectElement>('system').innerHTML;

// Charts read the theme tokens; the probe resolves any colour syntax to rgb().
const probe=document.createElement('i');probe.hidden=true;document.body.append(probe);
function paint(token:string){probe.style.color=`var(--${token})`;return getComputedStyle(probe).color;}
const mono=()=>getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()||'monospace';
const labelSize=()=>Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize)*.6875);

async function api<T>(path:string,init?:RequestInit):Promise<T> {
 const response = await vosu.fetch(path,init);
 const result = await response.json();
 if(!response.ok) throw Error(result.error || `Map analysis unavailable (${response.status})`);
 return result as T;
}
// Bar status: one dot and a word; warnings and errors also raise the toast.
function status(message='',tone?:Notice['tone']){notice=tone?{message,tone}:undefined;setLive();}
function setLive(){
 const link=!live.connected?(live.connecting?'connecting':'offline'):!follow?'manual':live.state===2?'playing':'live';
 const words={connecting:'Connecting',offline:'Offline',manual:'Manual',playing:'In play',live:'Live'};
 const dot={connecting:'',offline:'error',manual:'warn',playing:'ok',live:'ok'}[link];
 $('dot').dataset.state=notice?.tone??dot;
 $('live').textContent=notice?.tone==='busy'?'Analysing':words[link];
 $('live').title=link==='offline'?'vosu telemetry disconnected; reconnecting':link==='manual'?'Not following the game':'';
 $('follow').setAttribute('aria-pressed',String(follow));
 const mods=$('mods');mods.hidden=!live.mods||live.mods==='NM';mods.textContent=live.mods;
 const toast=$('toast');toast.hidden=!notice||notice.tone==='busy';toast.textContent=notice?.message??'';
 if(notice?.tone==='error')toast.dataset.tone='error';else delete toast.dataset.tone;
}
function stat(label:string,value:string,unit?:string,help?:string,tag:'div'|'li'='div'){
 const item=document.createElement(tag);item.className='v-stat';
 const name=document.createElement('span');name.className='v-stat__label';name.textContent=label;
 if(help){const tip=document.createElement('span');tip.className='v-help';tip.tabIndex=0;tip.setAttribute('role','img');tip.setAttribute('aria-label',help);tip.dataset.tip=help;tip.dataset.tipPos='left';name.append(tip);}
 const number=document.createElement('span');number.className='v-stat__value';number.textContent=value;
 if(unit){const small=document.createElement('span');small.className='v-stat__unit';small.textContent=unit;number.append(small);}
 item.append(name,number);return item;
}
// A missing value says why: "not rated" plus the calculator's own reason on hover.
// Key-count reasons already name the key count; rate-scoped ones get the rate.
const explain=(why:Unrated,rate:number)=>why.scope==='rate'?`Not rated at ${rate.toFixed(2)}×: ${why.reason}`:why.reason;
// Readouts show only the systems that apply to the chart's key count; the
// ones that cannot rate it are listed in one cell with their own reasons.
function cards(r:Rating) {
 const target=$('summary'); target.replaceChildren();
 $('performance').replaceChildren();
 if(r.performance?.targets)for(const t of r.performance.targets)$('performance').append(stat(`${t.accuracy}%`,fmt(t.pp),'pp'));
 else empty($('performance'),r.performance?.reason??'PP targets unavailable: enable Server pp calculator.');
 if(r.mode!=='mania'){
  target.append(stat(`osu!${r.mode==='osu'?'standard':r.mode==='fruits'?'catch':r.mode}`,fmt(r.stars),'★',r.official.source));
  const tabs=$('tabs');tabs.replaceChildren();const button=document.createElement('button');button.textContent=r.mode==='fruits'?'Catch':r.mode==='osu'?'Standard':'Taiko';button.setAttribute('aria-pressed','true');tabs.append(button);
  const body=$('skills');body.replaceChildren();
  for(const [name,value] of Object.entries(r.official.skills))row(body,[name,num(fmt(value))]);
  return;
 }
 const notFor:[string,string][]=[];
 const add=(show:boolean,system:string,label:string,value:number|null|undefined,unit?:string,help?:string)=>{
  if(!show)return;
  const why=r.unrated?.[system];
  if(value!=null||!why){target.append(stat(label,fmt(value),unit,help));return;}
  if(why.scope==='keys'){notFor.push([label,why.reason]);return;}
  target.append(stat(label,'—','not rated',explain(why,r.rate)));
 };
 const dan=(show:boolean,system:string,label:string,d:Dan|null|undefined,text:(d:Dan)=>[string,string],help:string)=>{
  if(!show)return;
  const why=r.unrated?.[system];
  if(d){const [value,unit]=text(d);target.append(stat(label,value,unit,help));return;}
  if(why?.scope==='keys'){notFor.push([label,why.reason]);return;}
  target.append(stat(label,'—','not rated',why?explain(why,r.rate):help));
 };
 add(settings.show_etterna,'etterna','Etterna',r.msd?.overall,'MSD');
 add(settings.show_prism,'prism','Prism',r.prism?.overall,undefined,"mania-tracker's 6K–8K calculator on the MSD scale; not Etterna.");
 add(settings.show_quaver,'quaver','Quaver',r.quaver);
 add(settings.show_interlude,'interlude','Interlude',r.interlude);
 add(settings.show_osu,'osu','osu!mania',r.stars,'★',r.official.source);
 dan(settings.show_reform,'reform','Reform',r.dan,d=>[d.label.replace(/^Reform /,''),fmt(d.value)],'Experimental dan estimate from MinaCalc overall MSD (4K); not a certification.');
 dan(settings.show_dan7k,'dan7k','7K dan (ours)',r.dan7k,d=>[d.label.replace(/ Dan$/,''),`${d.value.toFixed(1)} ± ${d.uncertainty?.toFixed(1)??'?'}`],"Our interpolation of MinaCalc 7K MSD between Jinjin's 7K Regular dan courses; ± is the held-out error on those courses. Not a certification.");
 if(notFor.length)target.append(stat(`Not for ${r.keys}K`,notFor.map(n=>n[0]).join(' · '),undefined,notFor.map(n=>`${n[0]}: ${n[1]}`).join(' ')));
 tabs(r);
}

// Breakdown panel: one source at a time, only the sources that apply.
type Tab = {id:string;label:string;heading:string;title:string;render:(r:Rating,body:HTMLElement)=>void};
const TABS:Tab[]=[
 {id:'etterna',label:'Etterna',heading:'Etterna skills',title:'Etterna MinaCalc 527 skillsets',render:renderEtterna},
 {id:'prism',label:'Prism',heading:'Prism (mania-tracker)',title:"Prism (mania-tracker) skillsets, MSD scale; not Etterna",render:renderPrism},
 {id:'view7k',label:'7K (ours)',heading:'7K skills (ours)',title:'7K skills: pattern analysis (ours) from Interlude patterns and MinaCalc 7K',render:render7k},
 {id:'patterns',label:'Interlude patterns',heading:'Interlude patterns',title:'Interlude patterns',render:renderPatterns},
 {id:'ln',label:'LN (ours)',heading:'LN statistics (ours)',title:'LN statistics (ours)',render:renderLn},
];
let chosenTab:string|undefined;
function tabs(r:Rating){
 const available=TABS.filter(t=>t.id==='ln'||r.unrated?.[t.id]?.scope!=='keys');
 const preferred=r.keys===7?'view7k':r.keys===8?'prism':[3,9,10].includes(r.keys)?'patterns':r.keys>=4&&r.keys<=6?'etterna':'ln';
 const active=available.find(t=>t.id===chosenTab)??available.find(t=>t.id===preferred)??available[0];
 const group=$('tabs');group.replaceChildren();
 for(const t of available){
  const button=document.createElement('button');button.type='button';button.textContent=t.label;button.title=t.title;
  button.setAttribute('aria-pressed',String(t===active));
  button.onclick=()=>{chosenTab=t.id;if(rating)tabs(rating);};
  group.append(button);
 }
 const body=$('skills');body.replaceChildren();body.dataset.tab=active.id;
 body.setAttribute('aria-label',active.heading);
 active.render(r,body);
}
function empty(body:HTMLElement,text:string){const p=document.createElement('p');p.className='v-empty';p.textContent=text;body.append(p);}
function row(body:HTMLElement,cells:(string|HTMLElement)[],opts:{current?:boolean;title?:string;head?:boolean}={}){
 const el=document.createElement('div');el.className=opts.head?'skill skill--head':'skill';el.dataset.cols=String(cells.length);
 if(opts.current)el.setAttribute('aria-current','true');
 if(opts.title)el.title=opts.title;
 for(const c of cells){if(typeof c==='string'){const s=document.createElement('span');s.textContent=c;el.append(s);}else el.append(c);}
 body.append(el);return el;
}
function meter(value:number,max:number,label:string){
 const bar=document.createElement('div');bar.className='v-meter';bar.style.setProperty('--v-value',String(Math.max(0,Math.min(1,value/max))));
 bar.setAttribute('role','meter');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(max));bar.setAttribute('aria-valuenow',String(value));bar.setAttribute('aria-label',label);
 return bar;
}
function num(text:string,title?:string){const s=document.createElement('span');s.className='v-num';s.textContent=text;if(title)s.title=title;return s;}
function renderEtterna(r:Rating,body:HTMLElement){
 if(!r.msd){const why=r.unrated?.etterna;empty(body,why?explain(why,r.rate):'No MinaCalc rating.');return;}
 // MinaCalc's own skillset names; Technical is null where it has no model (6K, 7K).
 const skills=Object.entries(r.msd).filter((e):e is [string,number]=>e[0]!=='overall'&&e[1]!=null);
 const top=skills.filter(([key])=>key!=='stamina').reduce<[string,number]|undefined>((best,entry)=>!best||entry[1]>best[1]?entry:best,undefined);
 const max=Math.max(30,...skills.map(e=>e[1]),r.msd.overall??0);
 for(const [name,value] of skills){const label=skillLabel(name,r.keys);row(body,[label,meter(value,max,label),num(fmt(value))],{current:name===top?.[0]});}
}
// Same names as the overlay chip: MinaCalc's generic 5K–7K slots and spaced
// Prism names.
function skillLabel(name:string,keys:number){
 const generic:Record<string,string>=keys===4?{}:{jumpstream:'chordstream',handstream:'bracketing'};
 return (generic[name]??name).replace('speed',' speed');
}
const prismLabel=(name:string)=>name.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/ Only$/,' only').replace(/^(\w)(.*)$/,(_,a:string,b:string)=>a+b.toLowerCase());
function renderPrism(r:Rating,body:HTMLElement){
 const p=r.prism;
 if(!p){const why=r.unrated?.prism;empty(body,why?explain(why,r.rate):'No Prism rating.');return;}
 const max=Math.max(30,p.overall,...p.skillsets.map(s=>s[1]));
 const top=p.skillsets.reduce<[string,number]|undefined>((b,s)=>!b||s[1]>b[1]?s:b,undefined);
 for(const [name,value] of p.skillsets){const label=prismLabel(name);row(body,[label,meter(value,max,label),num(fmt(value))],{current:name===top?.[0]});}
 if(p.ln!=null)row(body,['LN rating',meter(p.ln,max,'Prism LN rating'),num(fmt(p.ln))],{title:"Prism's LN model"});
}
function render7k(r:Rating,body:HTMLElement){
 const v=r.view7k;
 if(!v){const why=r.unrated?.view7k;empty(body,why?explain(why,r.rate):'No 7K view.');return;}
 row(body,['','Coverage','','BPM','MinaCalc'],{head:true});
 const top=v.categories.reduce<typeof v.categories[number]|undefined>((b,c)=>!b||c.coverage>b.coverage?c:b,undefined);
 for(const c of v.categories)row(body,[c.label,meter(c.coverage,1,`${c.label} coverage`),num(pct(c.coverage)),num(c.main_bpm==null?'—':String(c.main_bpm),'BPM covering most of this category, counting each row as a 1/16 note (Interlude convention), at this rate'),num(c.msd==null?'—':c.msd.toFixed(1),c.msd_source)],{current:c===top&&c.coverage>0});
 const grid=document.createElement('ol');grid.className='ladder ln-family';
 for(const l of v.ln){
  const value=l.value==null?'—':l.unit==='share'?pct(l.value):`${l.value.toFixed(0)}/s`;
  // The source goes on hover of the whole cell: four help icons do not fit.
  const item=stat(l.label,value,undefined,undefined,'li');item.classList.add('v-stat--sm');item.title=`${l.label}: ${l.source}`;grid.append(item);
 }
 body.append(grid);
}
function renderPatterns(r:Rating,body:HTMLElement){
 const p=r.patterns;
 if(!p){const why=r.unrated?.patterns;empty(body,why?explain(why,r.rate):'No pattern report.');return;}
 // Covers = the cluster's share of the chart's length; clusters overlap.
 row(body,[p.category,'Covers','','Rating'],{head:true}).classList.add('skill--category');
 if(!p.clusters.length){empty(body,'No recognised patterns.');return;}
 for(const [i,c] of p.clusters.slice(0,6).entries()){
  const name=c.specific[0]&&c.specific[0][1]>.4?c.specific[0][0]:c.pattern;
  const bpm=Math.round(c.bpm*r.rate);
  const label=c.mixed?`~${bpm} BPM Mixed ${name}`:`${bpm} BPM ${name}`;
  const share=p.duration>0?c.amount/p.duration:0;
  row(body,[label,meter(share,1,`${label} covers`),num(pct(share)),num(c.rating==null?'—':c.rating.toFixed(1),'Interlude strain rating of the cluster')],{current:i===0,title:label});
 }
}
function renderLn(r:Rating,body:HTMLElement){
 const l=r.ln;
 if(!l){empty(body,'No LN statistics.');return;}
 const grid=document.createElement('ol');grid.className='ladder ln-stats';
 const items:[string,string,string][]=[
  ['Holds',pct(l.ln_share),'Holds / all notes'],['Coverage',pct(l.coverage),'Held time / (columns × chart length)'],
  ['Releases',`${l.releases_per_second.toFixed(1)}/s`,'Releases per playback second'],['Peak',`${l.peak_releases_per_second.toFixed(0)}/s`,'Most releases in one playback second'],
  ['Inverse',pct(l.inverse_share),'Holds whose column is pressed again within 150 ms of the release'],['Off-row',pct(l.offbeat_release_share),'Releases not on a press row'],
  ['Short',pct(l.short_share),'Holds shorter than 150 ms'],
 ];
 for(const [label,value,help] of items){const item=stat(label,value,undefined,help,'li');item.classList.add('v-stat--sm');grid.append(item);}
 body.append(grid);
 if(l.indicators.length){const badges=document.createElement('div');badges.className='badges';for(const i of l.indicators){const b=document.createElement('span');b.className='v-badge v-badge--accent';b.textContent=i;badges.append(b);}body.append(badges);}
}
function frame(element:Element){return element.parentElement as HTMLElement;}
function draw(target:HTMLCanvasElement,points:Point[],field:'value'|'nps',range?:[number,number]) {
 const rect=frame(target).getBoundingClientRect(),dpr=devicePixelRatio||1;
 target.width=Math.max(1,Math.round(rect.width*dpr));target.height=Math.max(1,Math.round(rect.height*dpr));
 const ctx=target.getContext('2d')!;ctx.scale(dpr,dpr);
 // Windows MinaCalc could not rate are null and stay empty.
 const rated=points.filter((p):p is Point&{value:number}=>p[field]!=null);
 const w=rect.width,h=rect.height,size=labelSize(),peak=Math.max(1,...rated.map(p=>p[field])),duration=timeline?.duration||1;
 const local=field==='value'&&timeline?.mode==='local_msd';
 const max=local?Math.max(40,Math.ceil(Math.max(peak,timeline?.overall||0)/10)*10):peak;
 const top=size+6,bottom=size+10,plot=Math.max(1,h-top-bottom),y=(v:number)=>h-bottom-v/max*plot;
 const fg=paint('fg'),muted=paint('muted'),back=paint('bg-sunken'),accent=paint('accent');
 const playing=live.state===2&&follow&&rating?.checksum===live.checksum;
 ctx.clearRect(0,0,w,h);ctx.font=`400 ${size}px ${mono()}`;ctx.lineWidth=1;
 // Data-aligned rules: every 10 MSD in local mode (the band edges), quarters otherwise.
 const steps=local?Array.from({length:max/10-1},(_,i)=>(i+1)*10):[1,2,3].map(i=>i*max/4);
 ctx.strokeStyle=paint('rule');
 for(const v of steps){const ly=Math.round(y(v))+.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();}
 // Difficulty bands <10 / 10–20 / 20–30 / 30–40 / 40+: one accent, rising strength; 40+ in the text colour.
 const strength=[.32,.5,.7,.9,1];
 for(const p of rated){
  const x=p.time/duration*w,bar=Math.max(1,(timeline?.hop||1)/duration*w),band=Math.min(4,Math.floor(p.value/10));
  const future=playing&&p.time>live.time?.35:1;
  ctx.fillStyle=field==='nps'?muted:band===4?fg:accent;
  ctx.globalAlpha=(field==='nps'?.8:strength[band])*future;
  ctx.fillRect(x,y(p[field]),bar,p[field]/max*plot);
 }
 ctx.globalAlpha=1;
 // Labels sit on a chip so they stay legible over dense bars.
 const chip=(text:string,x:number,baseline:number,color:string)=>{const width=ctx.measureText(text).width;ctx.fillStyle=back;ctx.globalAlpha=.85;ctx.fillRect(x-3,baseline-size,width+6,size+4);ctx.globalAlpha=1;ctx.fillStyle=color;ctx.fillText(text,x,baseline);};
 for(const v of steps)chip(local?String(v):v.toFixed(1),5,Math.max(top,y(v)-4),muted);
 if(local&&timeline?.overall!=null){
  const ly=y(timeline.overall);ctx.setLineDash([3,4]);ctx.strokeStyle=fg;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(w,ly);ctx.stroke();ctx.setLineDash([]);
  const label=`Map ${timeline.overall.toFixed(2)} MSD`;
  chip(label,Math.max(5,w-ctx.measureText(label).width-8),Math.max(top,ly-6),fg);
 }
 ctx.fillStyle=muted;
 const clock=(s:number)=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
 const end=clock(duration);
 const axis=field==='nps'?`0:00 · notes/s · peak ${peak.toFixed(1)}`:`0:00 · ${timeline?.units??''} · ${timeline?.window}s / ${timeline?.hop}s · peak ${peak.toFixed(1)}`;
 ctx.fillText(axis,5,h-5);ctx.fillText(end,w-ctx.measureText(end).width-6,h-5);
 if(range){
  const x0=range[0]/duration*w,x1=range[1]/duration*w;
  ctx.fillStyle=accent;ctx.globalAlpha=.16;ctx.fillRect(x0,0,x1-x0,h);ctx.globalAlpha=1;
  ctx.strokeStyle=accent;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,h);ctx.moveTo(x1,0);ctx.lineTo(x1,h);ctx.stroke();
 }
 if(playing){
  const x=Math.max(0,Math.min(w,live.time/duration*w));
  ctx.strokeStyle=fg;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
  chip(clock(Math.max(0,live.time)),Math.min(w-50,x+6),top,fg);
 }
}
function redraw(){
 $('empty').hidden=Boolean(rating);
 if(timeline){draw(canvas,timeline.points,'value');draw(density,timeline.points,'nps');}
}
function applyTimelineDefaults(system:System){
 // Rated windows (local MSD, Prism) use the long-window defaults.
 const local=system==='etterna'||system==='prism';
 input('window').value=String(local?settings.local_window:settings.strain_window);
 input('hop').value=String(local?settings.local_hop:settings.strain_hop);
}
// Systems that cannot rate the chart's key count are disabled with their reason;
// a disabled selection falls back to the default system, else the first enabled one.
function syncSystems(r:Rating){
 const select=$<HTMLSelectElement>('system');
 select.closest('label')!.hidden=false;
 $('pattern-metrics').hidden=r.mode==='mania';
 if(r.mode!=='mania'){
  const labels=r.mode==='osu'?['Streams','Jumps','Bursts','Sliders']:r.mode==='taiko'?['Colour changes','Rhythm changes','Stamina hits']:['Hyperdashes','Direction changes'];
  select.replaceChildren(...labels.map(label=>new Option(`${label} (ours)`,label)));
  return;
 }
 if(!select.querySelector('option[value="etterna"]'))select.innerHTML=maniaSystems;
 for(const option of select.options){
  const why=r.unrated?.[option.value==='etterna-native'?'etterna':option.value];
  option.disabled=why?.scope==='keys';
  option.title=option.disabled?why!.reason:'';
 }
 if(!select.selectedOptions[0]?.disabled)return;
 const fallback=[...select.options].find(o=>o.value===settings.timeline_system&&!o.disabled)??[...select.options].find(o=>!o.disabled)!;
 select.value=fallback.value;applyTimelineDefaults(fallback.value as System);
}
async function loadTimeline(id:number) {
 if(!rating)return;
 if(rating.mode!=='mania'){
  const response=await vosu.fetch(`v1/beatmap/${rating.checksum}/file`);
  if(!response.ok)throw Error('Map bytes unavailable');
  const mode=({osu:0,taiko:1,fruits:2,mania:3} as const)[rating.mode as 'osu'|'taiko'|'fruits'|'mania'];
  const report=sections(await response.text(),mode as Ruleset,(live.mods.match(/.{2}/g)??[]).map(acronym=>({acronym})) as Mod[],rating.rate,Number(input('window').value),Number(input('hop').value));
  if(id!==generation)return;
  const metric=$<HTMLSelectElement>('system').value;
  timeline={...report,units:`${metric} /s (ours)`,points:report.points.map(p=>({...p,value:p.metrics[metric]??p.value}))};
  $('pattern-metrics').replaceChildren();
  for(const label of report.labels){const peak=Math.max(0,...report.points.map(p=>p.metrics[label]));$('pattern-metrics').append(stat(label,fmt(peak),'peak /s'));}
  redraw();return;
 }
 const system=$<HTMLSelectElement>('system').value;
 const t=await api<Timeline>(`v1/beatmap/${rating.checksum}/timeline?rate=${rating.rate}&system=${system}&window=${input('window').value}&hop=${input('hop').value}`);
 if(id!==generation)return;
 timeline=t;redraw();
}
function selectedRate(){return follow?live.rate:Number(input('rate').value);}
// Following: the game's selection. Manual: a newly opened file, else the chart on
// screen re-rated by checksum (its bytes are cached by the service).
async function analyze() {
 const id=++generation,file=pendingFile,rate=selectedRate(),shown=!follow?rating:undefined;
 pendingFile=undefined;
 if(!(rate>=.5&&rate<=2)){document.body.classList.toggle('stale',Boolean(rating));status(`Rate ${rate.toFixed(2)}× is outside 0.50–2.00×.`,'warn');return;}
 if(!file&&!shown&&!live.checksum){status();return;}
 input('rate').value=rate.toFixed(2);
 status('','busy');
 try {
  const options=`rate=${rate}&mods=${encodeURIComponent(live.mods||'NM')}${live.mode?`&mode=${encodeURIComponent(live.mode)}`:''}`;
  let r=await api<Rating>(file?`v1/calculate?${options}`:shown?`v1/beatmap/${shown.checksum}?${options}`:`v1/beatmap/current?${options}`,file?{method:'POST',body:await file.arrayBuffer()}:undefined);
  if(r.mode==='mania'){
   const source=await vosu.fetch(`v1/beatmap/${r.checksum}/file`);
   if(!source.ok)throw Error('Map bytes unavailable');
   const converted=convertedMania(await source.text(),(live.mods.match(/.{2}/g)??[]).map(acronym=>({acronym})) as Mod[]);
   if(converted)r=await api<Rating>(`v1/calculate?${options}`,{method:'POST',body:converted});
  }
  if(id!==generation)return;
  if(r.unsupported){
   const mode=live.mode&&live.mode!=='mania'&&!file?` (${live.mode})`:'';
   document.body.classList.toggle('stale',Boolean(rating));
   status(`${r.unsupported.charAt(0).toUpperCase()}${r.unsupported.slice(1)}${mode}.`,'warn');
   return;
  }
  fileName=file?file.name:shown?.checksum===r.checksum?fileName:undefined;
  rating=r;analysedKey=follow?`${live.checksum}:${rate}:${live.mods}:${live.mode}`:'';document.body.classList.remove('stale');cards(r);syncSystems(r);
  $('title').textContent=fileName ?? `${r.artist} — ${r.title} [${r.version}]`;$('title').title=`${$('title').textContent} · md5 ${r.checksum}`;
  $('meta').textContent=`${r.mode==='mania'?`${r.keys}K`:r.mode} · ${r.notes.toLocaleString()} objects · ${r.rate.toFixed(2)}×`;
  await loadTimeline(id);
  status();
 }catch(e){if(id===generation){document.body.classList.toggle('stale',Boolean(rating));status(e instanceof Error?e.message:String(e),'error');}}
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
 if(r0.mode!=='mania'){
  const start=Number(input('start').value),end=Number(input('end').value);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start){$('section-result').textContent='Choose 0 ≤ start < end.';return;}
  const points=(timeline?.points??[]).filter(p=>p.time>=start&&p.time<end);
  $('section-result').textContent=`Section density (ours): ${fmt(points.length?points.reduce((n,p)=>n+p.nps,0)/points.length:0)} objects/s`;
  return;
 }
 void api<{rating:Rating}>(`v1/beatmap/${r0.checksum}/section?start=${input('start').value}&end=${input('end').value}&rate=${r0.rate}`)
  .then(result=>{const r=result.rating;$('section-result').textContent=`Etterna ${fmt(r.msd?.overall)}${r.prism?` · Prism ${fmt(r.prism.overall)}`:''} · Quaver ${fmt(r.quaver)} · Interlude ${fmt(r.interlude)} · ${fmt(r.stars)} ★`;})
  .catch(e=>{$('section-result').textContent=e instanceof Error?e.message:String(e);});
}

// Live telemetry: selected map, rate, mods and play position.
const FIELDS=['/beatmap/checksum','/beatmap/time/live','/play/mods/rate','/state/number','/play/mods/name','/beatmap/mode','/play/mode','/settings/mode'] as const;
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
  const rate=Number(values[2]??1);live.rate=Number.isFinite(rate)&&rate>0?rate:1;
  live.state=Number(values[3]??-1);live.mods=typeof values[4]==='string'?values[4]:'';live.mode=playedRuleset(live.state,values[6],values[7],values[5]);
  setLive();
  if(follow&&`${live.checksum}:${live.rate}:${live.mods}:${live.mode}`!==analysedKey){analysedKey=`${live.checksum}:${live.rate}:${live.mods}:${live.mode}`;void refreshSettings().then(()=>schedule());}
  // Only the time-based plots move during play; the curve moves only for the manual-mode game-rate marker.
  if(timeline&&(live.state===2||wasPlaying)){draw(canvas,timeline.points,'value');draw(density,timeline.points,'nps');}
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
setLive();if(follow){analysedKey=`${live.checksum}:${live.rate}`;schedule(0);}
};
input('file').onchange=()=>{const file=input('file').files?.[0];if(!file)return;pendingFile=file;follow=false;setLive();schedule(0);};
input('rate').onchange=()=>{follow=false;setLive();schedule(0);};
for(const id of ['window','hop'])$(id).onchange=()=>{timelineTouched=true;void loadTimeline(generation).catch(e=>status(String(e),'error'));};
$('system').onchange=()=>{
 timelineTouched=true;applyTimelineDefaults($<HTMLSelectElement>('system').value as System);
 void loadTimeline(generation).catch(e=>status(String(e),'error'));
};
const resize=new ResizeObserver(redraw);
for(const element of [canvas,density])resize.observe(frame(element));
// Canvas text uses the theme's mono face; repaint once it has loaded.
void document.fonts.ready.then(redraw);
// Dashboard edits to settings apply when the page comes back into view.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshSettings();});

await vosu.ready;
$<HTMLAnchorElement>('dashboard').href=vosu.dashboardUrl;
input('file').disabled=!vosu.canWrite;
const picker=$('file').closest('label')!;
picker.setAttribute('aria-disabled',String(!vosu.canWrite));
if(!vosu.canWrite)picker.title='Open from the dashboard to analyse a local file';
await refreshSettings();
follow=settings.follow_game;setLive();redraw();
connect();
