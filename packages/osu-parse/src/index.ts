export type Point = { x: number; y: number };
export type Ruleset = 0 | 1 | 2 | 3;
export interface TimingPoint { time: number; beatLength: number; meter: number; sampleSet: number; sampleIndex: number; volume: number; uninherited: boolean; effects: number }
export interface HitObject extends Point { time: number; endTime: number; type: number; sound: number; combo: number; number: number; stack: number; path: Point[]; repeats: number; length: number; span: number; ticks: number[]; edgeSounds: number[]; sample: string }
export interface Beatmap { format: number; mode: Ruleset; general: Record<string,string>; metadata: Record<string,string>; difficulty: { hp: number; cs: number; od: number; ar: number; sliderMultiplier: number; sliderTickRate: number }; timing: TimingPoint[]; objects: HitObject[]; breaks: [number,number][]; events: string[]; colours: [number,number,number][]; duration: number; rate: number; visualMods: string[] }
export interface Mod { acronym: string; settings?: Record<string, unknown> }
const distance = (a: Point,b: Point) => Math.hypot(a.x-b.x,a.y-b.y);
const lerp = (a: Point,b: Point,t: number): Point => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const same = (a: Point,b: Point) => a.x===b.x && a.y===b.y;
/** Parse CSV including quoted event filenames. */
export function csv(line: string): string[] { return line.match(/(?:"(?:[^"]|"")*"|[^,])+(?=,|$)|(?<=,)(?=,|$)/g)?.map(v=>v.trim().replace(/^"|"$/g, "").replace(/""/g,'"')) ?? []; }
function bezier(points: Point[]): Point[] {
  const out: Point[]=[];
  const subdivide=(p: Point[],depth: number): void=>{
    const a=p[0], b=p[p.length-1]; const d=distance(a,b);
    let error=0; for(let i=1;i<p.length-1;i++) error=Math.max(error,d ? Math.abs((b.y-a.y)*p[i].x-(b.x-a.x)*p[i].y+b.x*a.y-b.y*a.x)/d : distance(a,p[i]));
    if(error<0.2 || depth>=16){if(!out.length)out.push(a);out.push(b);return;}
    let level=p;const left=[p[0]],right=[p[p.length-1]];
    while(level.length>1){const next:Point[]=[];for(let i=0;i<level.length-1;i++)next.push(lerp(level[i],level[i+1],0.5));left.push(next[0]);right.push(next[next.length-1]);level=next;}
    subdivide(left,depth+1);subdivide(right.reverse(),depth+1);
  };subdivide(points,0);return out;
}
/** Flatten slider curves to subpixel accuracy, then trim/extend to the declared distance. */
export function sliderPath(kind: string, points: Point[], expectedLength?: number): Point[] {
  if(!points.length)return []; let out:Point[]=[];
  if(kind==='L')out=points.map(p=>({...p}));
  else if(kind==='P' && points.length===3){
    const [a,b,c]=points;const d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
    if(Math.abs(d)<1e-7)out=points.map(p=>({...p}));else{
      const aa=a.x*a.x+a.y*a.y,bb=b.x*b.x+b.y*b.y,cc=c.x*c.x+c.y*c.y;
      const cx=(aa*(b.y-c.y)+bb*(c.y-a.y)+cc*(a.y-b.y))/d,cy=(aa*(c.x-b.x)+bb*(a.x-c.x)+cc*(b.x-a.x))/d;
      const start=Math.atan2(a.y-cy,a.x-cx);let middle=Math.atan2(b.y-cy,b.x-cx)-start,end=Math.atan2(c.y-cy,c.x-cx)-start;
      const tau=Math.PI*2;middle=(middle+tau)%tau;end=(end+tau)%tau;if(middle>end)end-=tau;
      const r=Math.hypot(a.x-cx,a.y-cy),steps=Math.max(2,Math.ceil(Math.abs(end)*Math.sqrt(r/0.4)));
      for(let i=0;i<=steps;i++){const t=start+end*i/steps;out.push({x:cx+Math.cos(t)*r,y:cy+Math.sin(t)*r});}
    }
  }else if(kind==='C'){
    for(let i=0;i<points.length-1;i++){const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
      const n=Math.max(8,Math.ceil(distance(b,c)/3));for(let j=0;j<n;j++){const t=j/n,t2=t*t,t3=t2*t;out.push({x:0.5*(2*b.x+(-a.x+c.x)*t+(2*a.x-5*b.x+4*c.x-d.x)*t2+(-a.x+3*b.x-3*c.x+d.x)*t3),y:0.5*(2*b.y+(-a.y+c.y)*t+(2*a.y-5*b.y+4*c.y-d.y)*t2+(-a.y+3*b.y-3*c.y+d.y)*t3)});}}
    out.push({...points[points.length-1]});
  }else{
    let segment=[points[0]];for(let i=1;i<points.length;i++){segment.push(points[i]);if(i===points.length-1 || same(points[i],points[i+1])){if(segment.length>1)out.push(...bezier(segment));segment=[points[i]];}}if(!out.length)out=[{...points[0]}];
  }
  out=out.filter((p,i)=>!i || !same(p,out[i-1]));
  if(expectedLength===undefined || out.length<2)return out;
  let length=0;for(let i=1;i<out.length;i++){const d=distance(out[i-1],out[i]);if(length+d>=expectedLength){out[i]=lerp(out[i-1],out[i],Math.max(0,(expectedLength-length)/d));out.length=i+1;return out;}length+=d;}
  const last=out[out.length-1],prev=out[out.length-2],d=distance(prev,last);if(d>0 && expectedLength>length)out.push(lerp(prev,last,1+(expectedLength-length)/d));return out;
}
export function pathPosition(path: readonly Point[], progress: number): Point {
  if(!path.length)return {x:256,y:192};let length=0;for(let i=1;i<path.length;i++)length+=distance(path[i-1],path[i]);let remaining=Math.min(1,Math.max(0,progress))*length;
  for(let i=1;i<path.length;i++){const d=distance(path[i-1],path[i]);if(remaining<=d)return lerp(path[i-1],path[i],d?remaining/d:0);remaining-=d;}return {...path[path.length-1]};
}
export function timingAt(timing: readonly TimingPoint[], time: number): { beatLength: number; sv: number; meter: number } {
  let beatLength=500,sv=1,meter=4;for(const p of timing){if(p.time>time)break;if(p.uninherited){beatLength=p.beatLength;sv=1;meter=p.meter;}else sv=Math.max(0.1,Math.min(10,-100/p.beatLength));}return {beatLength,sv,meter};
}
export function approachTime(ar: number): number { return ar<5?1800-120*ar:1200-150*(ar-5); }
export function circleRadius(cs: number): number { return 54.4-4.48*cs; }
/** Stable's v6+ backwards stacking. Slider-tail stacks receive negative offsets. */
export function applyStacking(map: Beatmap): void {
  for(const o of map.objects)o.stack=0;if(map.mode!==0)return;
  const threshold=approachTime(map.difficulty.ar)*Number(map.general.StackLeniency??0.7),objs=map.objects;
  if(map.format<6){for(let i=0;i<objs.length;i++){const o=objs[i];if(o.type&8)continue;let end=o.endTime;for(let j=i+1;j<objs.length;j++){const n=objs[j];if(n.time-end>threshold)break;if(distance(o,n)<3){o.stack++;end=n.endTime;}}}return;}
  for(let i=objs.length-1;i>=0;i--){let o=objs[i];if(o.stack || o.type&8)continue;
    if(o.type&1){for(let j=i-1;j>=0;j--){const n=objs[j];if(n.type&8)continue;if(o.time-n.endTime>threshold)break;
      if(n.type&2 && distance(n.path[n.path.length-1]??n,o)<3){const offset=o.stack-n.stack+1;for(let k=j+1;k<=i;k++)if(distance(n.path[n.path.length-1]??n,objs[k])<3)objs[k].stack-=offset;break;}
      if(distance(n,o)<3){n.stack=o.stack+1;o=n;}
    }}else if(o.type&2){for(let j=i-1;j>=0;j--){const n=objs[j];if(n.type&8)continue;if(o.time-n.time>threshold)break;if(distance(n.path[n.path.length-1]??n,o)<3){n.stack=o.stack+1;o=n;}}}
  }
}
export function parseOsu(text: string): Beatmap {
  const map:Beatmap={format:14,mode:0,general:{},metadata:{},difficulty:{hp:5,cs:5,od:5,ar:5,sliderMultiplier:1.4,sliderTickRate:1},timing:[],objects:[],breaks:[],events:[],colours:[],duration:0,rate:1,visualMods:[]};
  let section='',combo=-1,number=0;const difficulty:Record<string,string>={};
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){const line=raw.trim();if(!line || line.startsWith('//'))continue;
    if(line.startsWith('osu file format v')){map.format=Number(line.slice(17));continue;}if(line.startsWith('[')){section=line.slice(1,-1);continue;}
    if(['General','Metadata','Difficulty','Colours'].includes(section)){const colon=line.indexOf(':');if(colon<0)continue;const key=line.slice(0,colon).trim(),value=line.slice(colon+1).trim();if(section==='General')map.general[key]=value;else if(section==='Metadata')map.metadata[key]=value;else if(section==='Difficulty')difficulty[key]=value;else if(/^Combo\d+$/.test(key)){const c=value.split(',').map(Number);map.colours.push([c[0]/255,c[1]/255,c[2]/255]);}continue;}
    const p=csv(line);if(section==='Events'){map.events.push(line);if(p[0]==='2'||p[0]==='Break')map.breaks.push([Number(p[1]),Number(p[2])]);}
    if(section==='TimingPoints'){const n=p.map(Number);if(!Number.isFinite(n[0])||!Number.isFinite(n[1])||n[1]===0)continue;map.timing.push({time:n[0],beatLength:n[1],meter:n[2]||4,sampleSet:n[3]||0,sampleIndex:n[4]||0,volume:n[5]??100,uninherited:p[6]===undefined||n[6]===1,effects:n[7]||0});}
    if(section==='HitObjects'){
      const [x,y,time,type,sound]=p.slice(0,5).map(Number);if(![x,y,time,type,sound].every(Number.isFinite))continue;if(combo<0 || type&4){combo+=1+((type>>4)&7);number=0;}number++;
      const o:HitObject={x,y,time,endTime:time,type,sound,combo,number,stack:0,path:[],repeats:1,length:0,span:0,ticks:[],edgeSounds:[],sample:p[p.length-1]??''};
      if(type&2){const curve=p[5].split('|');const controls=[{x,y},...curve.slice(1).map(v=>{const [x,y]=v.split(':').map(Number);return {x,y};})];o.length=Math.max(0,Number(p[7])||0);o.path=sliderPath(curve[0],controls,o.length);o.repeats=Math.max(1,Number(p[6])||1);o.edgeSounds=p[8]?.split('|').map(Number)??[];}
      else if(type&8)o.endTime=Number(p[5])||time;else if(type&128)o.endTime=Number(p[5]?.split(':')[0])||time;map.objects.push(o);
    }
  }
  map.mode=Math.max(0,Math.min(3,Number(map.general.Mode)||0)) as Ruleset;
  const d=map.difficulty;d.hp=Number(difficulty.HPDrainRate??5);d.cs=Number(difficulty.CircleSize??5);d.od=Number(difficulty.OverallDifficulty??5);d.ar=Number(difficulty.ApproachRate??d.od);d.sliderMultiplier=Number(difficulty.SliderMultiplier??1.4);d.sliderTickRate=Number(difficulty.SliderTickRate??1);
  map.timing.sort((a,b)=>a.time-b.time);map.objects.sort((a,b)=>a.time-b.time);
  for(const o of map.objects){if(o.type&2){const t=timingAt(map.timing,o.time);o.span=o.length*t.beatLength/(100*d.sliderMultiplier*t.sv);o.endTime=o.time+o.span*o.repeats;const tickDistance=100*d.sliderMultiplier*t.sv/d.sliderTickRate;for(let x=tickDistance;x<o.length-0.01 && o.ticks.length<10000;x+=tickDistance)o.ticks.push(x/o.length);}map.duration=Math.max(map.duration,o.endTime);}
  applyStacking(map);return map;
}
/** Mods never mutate the parsed source. Rate is metadata: renderAt always receives map milliseconds. */
export function applyMods(source: Beatmap, mods: readonly Mod[] = [], options: { ar?: number; cs?: number; seed?: number } = {}): Beatmap {
  const map=structuredClone(source),has=(s:string)=>mods.some(m=>m.acronym.toUpperCase()===s);map.visualMods=mods.map(m=>m.acronym.toUpperCase());
  const d=map.difficulty;if(has('EZ')){d.cs*=0.5;d.ar*=0.5;d.od*=0.5;d.hp*=0.5;}if(has('HR')){d.cs=Math.min(10,d.cs*1.3);d.ar=Math.min(10,d.ar*1.4);d.od=Math.min(10,d.od*1.4);d.hp=Math.min(10,d.hp*1.4);}
  for(const m of mods){const a=m.acronym.toUpperCase(),s=m.settings??{};if(['DT','NC','HT','DC'].includes(a))map.rate=Number(s.speed_change??(['DT','NC'].includes(a)?1.5:0.75));if(a==='DA'){d.ar=Number(s.approach_rate??d.ar);d.cs=Number(s.circle_size??d.cs);d.od=Number(s.overall_difficulty??d.od);d.hp=Number(s.drain_rate??d.hp);}}
  if(options.ar!==undefined)d.ar=options.ar;if(options.cs!==undefined)d.cs=options.cs;
  let seed=options.seed??Number(mods.find(m=>m.acronym==='RD')?.settings?.seed??1);const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  const keys=Math.max(1,Math.round(d.cs)),lanes=Array.from({length:keys},(_,i)=>i);if(has('RD'))for(let i=keys-1;i>0;i--){const j=Math.floor(random()*(i+1));[lanes[i],lanes[j]]=[lanes[j],lanes[i]];}
  const mirror=has('MR');const transform=(p:Point)=>{if(map.mode===0 && has('HR'))p.y=384-p.y;if(mirror && map.mode!==3)p.x=512-p.x;};
  for(const o of map.objects){transform(o);for(const p of o.path)transform(p);if(map.mode===3){let lane=Math.min(keys-1,Math.floor(o.x*keys/512));if(has('RD'))lane=lanes[lane];if(mirror)lane=keys-1-lane;o.x=(lane+0.5)*512/keys;}else if(has('RD')&&map.mode===0){const dx=(random()-0.5)*100,dy=(random()-0.5)*80;const minX=Math.min(o.x,...o.path.map(p=>p.x)),maxX=Math.max(o.x,...o.path.map(p=>p.x)),minY=Math.min(o.y,...o.path.map(p=>p.y)),maxY=Math.max(o.y,...o.path.map(p=>p.y));const tx=Math.max(-minX,Math.min(512-maxX,dx)),ty=Math.max(-minY,Math.min(384-maxY,dy));o.x+=tx;o.y+=ty;for(const p of o.path){p.x+=tx;p.y+=ty;}}}
  applyStacking(map);return map;
}
/** Integrated inherited SV; no discontinuity at timing changes. */
export function scrollPosition(timing: readonly TimingPoint[], time: number, mode: 'mania'|'taiko'='mania'): number {
  let previous=0,position=0,sv=1,beat=500;for(const t of timing){if(t.time>time)break;position+=(t.time-previous)*sv*(mode==='taiko'?500/beat:1);previous=t.time;if(t.uninherited){beat=t.beatLength;sv=1;}else sv=Math.max(0.1,Math.min(10,-100/t.beatLength));}return position+(time-previous)*sv*(mode==='taiko'?500/beat:1);
}
