import { vosu } from '/tools/_host/v1/bridge.js';
import './style.css';
type Options = {rate:number;seed:number;mirror:string;angle_sharpness:number;mods:string[];pitch_preserving:boolean;hp:number|null;cs:number|null;ar:number|null;od:number|null;lock_ar:boolean;lock_od:boolean};
type Entry = {id:string;name:string;files:{path:string}[];warnings:string[]};
const $ = <T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const form=$<HTMLFormElement>('form');
const status=$('status');
let job:string|null=null;
let busy=false;
const groups:[string,string[],string[]][]=[['All rulesets',['HT','DC','DT','NC','DA'],['Half Time','Daycore','Double Time','Nightcore','Difficulty Adjust']],['osu!',['MR','RD'],['Mirror','Random']],['taiko',['SW','RD','CS'],['Swap','Random','Constant Speed']],['catch',['MR'],['Mirror']],['mania',['IN','HO','MR','RD','CS'],['Invert','Hold Off','Mirror','Random','Constant Speed']]];
const selectors:{input:HTMLInputElement;group:string}[]=[];
for(const [group,ids,names] of groups){
 const field=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=group;field.append(legend);
 ids.forEach((id,i)=>{const label=document.createElement('label');label.className='mod';const input=document.createElement('input');input.type='checkbox';input.value=id;input.name=`mod-${group}-${id}`;label.append(input,document.createTextNode(`${id} / ${names[i]}`));field.append(label);selectors.push({input,group});});$('mods').append(field);
}
function control(name:string):HTMLInputElement{return form.elements.namedItem(name) as HTMLInputElement;}
function options():Options {
 const number=(name:string)=>control(name).value===''?null:Number(control(name).value);
 return {rate:Number(control('rate').value),seed:Number(control('seed').value),mirror:control('mirror').value,angle_sharpness:Number(control('angle_sharpness').value),mods:selectors.filter(x=>x.input.checked&&!x.input.disabled).map(x=>x.input.value),pitch_preserving:!control('pitch').checked,hp:number('hp'),cs:number('cs'),ar:number('ar'),od:number('od'),lock_ar:control('lock_ar').checked,lock_od:control('lock_od').checked};
}
function setOptions(o:Options){
 for(const key of ['rate','seed','mirror','angle_sharpness','hp','cs','ar','od'] as const) control(key).value=o[key]===null?'':String(o[key]);
 control('pitch').checked=!o.pitch_preserving;control('lock_ar').checked=o.lock_ar;control('lock_od').checked=o.lock_od;
 for(const x of selectors)x.input.checked=o.mods.includes(x.input.value);
}
async function api<T>(path:string,body?:unknown,method?:string):Promise<T>{
 const r=await vosu.fetch(path,body===undefined?{method:method??'GET'}:{method:method??'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const v=await r.json();if(!r.ok)throw new Error(v.error??r.statusText);return v as T;
}
function fail(e:unknown){status.textContent=e instanceof Error?e.message:String(e);}
function writable(){for(const id of ['generate','save','preview-button'])($<HTMLButtonElement>(id)).disabled=!vosu.canWrite||busy;}
async function refresh(){
 const v=await api<{client:string;beatmap:null|{title:string;artist:string;version:string;mode:string;bpm:number};ratings:{msd?:{overall:number};unsupported?:string}|null}>(`v1/current?rate=${Number(control('rate').value)||1}`);
 const b=v.beatmap;
 $('title').textContent=b?`${b.artist} — ${b.title}`:'No selected beatmap';
 $('map').textContent=b?`${b.version} / ${b.mode} / ${b.bpm.toFixed(2)} BPM / ${v.client}`:'Select a beatmap in osu! to begin.';
 $('ratings').textContent=v.ratings?.msd?`Source-map MSD at selected rate: ${v.ratings.msd.overall.toFixed(2)} (before map transforms)`:'';
 for(const x of selectors){const ruleset=x.group==='osu!'?'osu':x.group==='catch'?'fruits':x.group;const allowed=x.group==='All rulesets'||ruleset===b?.mode;x.input.disabled=!allowed;x.input.closest('label')?.classList.toggle('unavailable',!allowed);}
 control('cs').disabled=b?.mode==='mania';if(b?.mode==='mania')control('cs').value='';
}
async function generated(){
 const {maps}=await api<{maps:Entry[]}>('v1/generated');const container=$('generated');container.replaceChildren();
 if(!maps.length){container.textContent='No practice copies generated yet.';return;}
 for(const entry of maps){const row=document.createElement('article');const name=document.createElement('h3');name.textContent=entry.name;const path=document.createElement('p');path.className='mono';path.textContent=entry.files.find(f=>/\.(osu|osz)$/.test(f.path))?.path??'';row.append(name,path);
 for(const warning of entry.warnings){const p=document.createElement('p');p.textContent=warning;row.append(p);}
 const button=document.createElement('button');button.textContent='Delete copy';button.disabled=!vosu.canWrite||busy;button.onclick=()=>{void (async()=>{if(!confirm(`Delete this generated copy and its unmodified owned assets?\n${entry.name}`))return;await api(`v1/delete/${encodeURIComponent(entry.id)}`,{});await generated();})().catch(fail);};row.append(button);container.append(row);}
}
async function preview(){
 const v=await api<{objects:number;duration_ms:number;bpm:number;ar:number;od:number;hp:number;cs:number}>('v1/preview',options());
 $('preview').textContent=`${v.objects} objects / ${(v.duration_ms/1000).toFixed(1)} s map end / ${v.bpm.toFixed(2)} BPM / HP ${v.hp.toFixed(2)} · CS ${v.cs.toFixed(2)} · AR ${v.ar.toFixed(2)} · OD ${v.od.toFixed(2)}`;
}
$('preview-button').onclick=()=>void preview().catch(fail);
$('refresh').onclick=()=>void refresh().catch(fail);
$('save').onclick=()=>void api('v1/settings',options()).then(()=>{status.textContent='Settings saved.';}).catch(fail);
$('cancel').onclick=()=>{if(job)void api(`v1/jobs/${job}`,undefined,'DELETE').catch(fail);};
form.onsubmit=e=>{e.preventDefault();if(!vosu.canWrite||busy)return;void(async()=>{
 busy=true;writable();await generated();status.textContent='Starting job…';
 try{
  await preview();const result=await api<{job:string}>('v1/generate',options());job=result.job;$('cancel').hidden=false;$('progress').hidden=false;
  for(;;){const state=await api<{state:string;message:string;progress:number}>(`v1/jobs/${job}`);status.textContent=state.message;($<HTMLProgressElement>('progress')).value=state.progress;if(['done','failed','cancelled'].includes(state.state))break;const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,250);await promise;}
 }finally{job=null;busy=false;$('cancel').hidden=true;writable();await generated();}
})().catch(fail);};
void(async()=>{await vosu.ready;$('access').textContent=vosu.canWrite?'WRITE SESSION / local practice generation enabled':'READ ONLY / open from the vosu dashboard to generate';writable();setOptions(await api<Options>('v1/settings'));await refresh();await generated();})().catch(fail);
