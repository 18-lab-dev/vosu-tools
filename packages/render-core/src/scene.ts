import { approachTime,circleRadius,pathPosition,scrollPosition,timingAt } from '@vosu-tools/osu-parse';
import type { Beatmap,HitObject,Mod } from '@vosu-tools/osu-parse';
import type { Skin,AtlasRegion } from './skin';
export interface RenderOptions { mods?: Mod[]; ar?:number; cs?:number; scrollSpeed?:number; noteSpeed?:number }
export interface Scene { data: Float32Array<ArrayBuffer>; chunks: {first:number;count:number;from:number;until:number}[]; count:number; preempt:number; speed:number; catcher: {time:number;x:number}[] }
const palette:readonly (readonly number[])[]=[[1,0.52,0.24],[0.35,0.72,1],[0.68,0.9,0.35],[0.86,0.45,0.8]];
/** Packed 6xvec4 instance ABI: geometry, lifetime, tint, motion, UV, shape parameters. */
export function compileScene(map: Beatmap,options:RenderOptions,regions:Map<string,AtlasRegion>,skin?:Skin): Scene {
  const values:number[]=[],preempt=approachTime(map.difficulty.ar),radius=circleRadius(map.difficulty.cs),catcher:{time:number;x:number}[]=[];
  const mania=skin?.sections.get('Mania')?.find(s=>Number(s.Keys)===Math.round(map.difficulty.cs));
  const speed=map.mode===3?(options.scrollSpeed??20)/20*0.55:map.mode===1?0.32*(options.noteSpeed??1):map.mode===2?300/preempt:0;
  function add(x:number,y:number,w:number,h:number,start:number,end:number,from:number,until:number,colour:readonly number[],shape=0,motion=0,a=0,b=0,c=0,asset='',p=0,q=0,r=0):void {
    const uv=regions.get(asset);values.push(x,y,w,h,start,end,from,until,colour[0],colour[1],colour[2],colour[3]??1,motion,a,b,c,uv?.u??0,uv?.v??0,uv?.w??0,uv?.h??0,uv?10:shape,p,q,r);
  }
  function circle(o:HitObject,x:number,y:number,r:number,colour:readonly number[],start=o.time,asset='hitcircle'):void{
    add(x,y,r*2,r*2,start,o.endTime,start-preempt,o.endTime+180,colour,0,0,0,0,0,asset);
    add(x,y,r*2,r*2,start,o.endTime,start-preempt,o.endTime+180,[1,1,1],1,0,0,0,0,'hitcircleoverlay');
  }
  function digits(o:HitObject,x:number,y:number):void{const s=String(o.number),prefix=skin?.sections.get('Fonts')?.[0]?.HitCirclePrefix??'default';for(let i=0;i<s.length;i++)add(x+(i-(s.length-1)/2)*radius*0.55,y,radius*0.7,radius*0.9,o.time,o.time,o.time-preempt,o.time+120,[1,1,1],10,0,0,0,0,regions.has(`${prefix}-${s[i]}`)?`${prefix}-${s[i]}`:`default-${s[i]}`);}
  if(map.mode===0){
    // Slider tracks sit below all hit objects. Discs fill joins; capsule segments avoid cracks.
    for(const o of map.objects)if(o.type&2){const offset=o.stack*radius/10,colour=map.colours[o.combo%map.colours.length]??palette[o.combo%palette.length];let cumulative=0;
      for(let i=1;i<o.path.length;i++){const a=o.path[i-1],b=o.path[i],len=Math.hypot(b.x-a.x,b.y-a.y);cumulative+=len;const reveal=o.time-preempt+Math.min(1,cumulative/Math.max(1,o.length))*preempt*0.4;
        add((a.x+b.x)/2-offset,(a.y+b.y)/2-offset,len+radius*2,radius*2,o.time,o.endTime,reveal,o.endTime+180,[0.85,0.85,0.85],2,0,Math.atan2(b.y-a.y,b.x-a.x),0,0,'',radius);
        add((a.x+b.x)/2-offset,(a.y+b.y)/2-offset,len+radius*1.75,radius*1.75,o.time,o.endTime,reveal,o.endTime+180,[colour[0]*0.3,colour[1]*0.3,colour[2]*0.3],2,0,Math.atan2(b.y-a.y,b.x-a.x),0,0,'',radius*0.875);
      }
    }
    for(let index=map.objects.length-1;index>=0;index--){const o=map.objects[index],offset=o.stack*radius/10,x=o.x-offset,y=o.y-offset,colour=map.colours[o.combo%map.colours.length]??palette[o.combo%palette.length];
      if(o.type&8){add(256,192,300,300,o.time,o.endTime,o.time-preempt,o.endTime+180,[0.65,0.7,0.8,0.5],1,7,0,0,0,'spinner-circle');add(256,192,300,300,o.time,o.endTime,o.time-preempt,o.endTime,[1,1,1],1,10,0,0,0,'spinner-approachcircle');continue;}
      if(o.type&2){
        for(let repeat=0;repeat<o.repeats;repeat++){
          const reverse=repeat%2===1,spanStart=o.time+o.span*repeat;let cumulative=0;
          for(let i=1;i<o.path.length;i++){const a=o.path[i-1],b=o.path[i],length=Math.hypot(b.x-a.x,b.y-a.y),first=cumulative/Math.max(o.length,1),last=(cumulative+length)/Math.max(o.length,1);cumulative+=length;const start=spanStart+(reverse?1-last:first)*o.span,end=spanStart+(reverse?1-first:last)*o.span;
            add((reverse?b.x:a.x)-offset,(reverse?b.y:a.y)-offset,radius*2,radius*2,start,end,start,end,[1,1,1],0,5,(reverse?a.x:b.x)-offset,(reverse?a.y:b.y)-offset,0,'sliderb0');
            add((reverse?b.x:a.x)-offset,(reverse?b.y:a.y)-offset,radius*4.6,radius*4.6,start,end,start,end,[1,1,1,0.6],1,5,(reverse?a.x:b.x)-offset,(reverse?a.y:b.y)-offset,0,'sliderfollowcircle');
          }
          for(const t of o.ticks){const p=pathPosition(o.path,t),hit=spanStart+(reverse?1-t:t)*o.span;add(p.x-offset,p.y-offset,8,8,hit,hit,o.time-preempt,hit,[1,1,1],0,0,0,0,0,'sliderscorepoint');}
          if(repeat<o.repeats-1){const p=pathPosition(o.path,reverse?0:1),near=pathPosition(o.path,reverse?0.03:0.97),angle=Math.atan2(near.y-p.y,near.x-p.x);add(p.x-offset,p.y-offset,radius*1.2,radius*1.2,spanStart+o.span,spanStart+o.span,o.time-preempt,spanStart+o.span,[1,1,1],3,0,angle,0,0,'reversearrow');}
        }
        const end=pathPosition(o.path,o.repeats%2?1:0);add(end.x-offset,end.y-offset,radius*2,radius*2,o.endTime,o.endTime,o.time-preempt,o.endTime,[...colour,0.7],1);
      }
      circle(o,x,y,radius,colour);digits(o,x,y);add(x,y,radius*2,radius*2,o.time,o.time,o.time-preempt,o.time,[...colour,0.9],1,6,0,0,0,'approachcircle');
    }
  }else if(map.mode===3){
    const keys=Math.max(1,Math.round(map.difficulty.cs)),rawWidths=mania?.ColumnWidth?.split(',').map(Number),widths=Array.from({length:keys},(_,i)=>rawWidths?.[i]??30),total=widths.reduce((a,b)=>a+b,0),scale=Math.min(1.6,240/total);let left=256-total*scale/2;
    const hit=Number(mania?.HitPosition??402)/480*384;
    for(let lane=0;lane<keys;lane++){const w=widths[lane]*scale,x=left+w/2;add(x,192,w-1,384,0,0,-1e9,1e9,[lane%2?0.045:0.025,lane%2?0.05:0.03,0.065],4);add(x,hit,w-1,3,0,0,-1e9,1e9,[0.8,0.8,0.8],4);left+=w;}
    for(const o of map.objects){const lane=Math.min(keys-1,Math.floor(o.x*keys/512)),x=256-total*scale/2+widths.slice(0,lane).reduce((a,b)=>a+b,0)*scale+widths[lane]*scale/2,w=widths[lane]*scale-2,kind=keys%2 && lane===Math.floor(keys/2)?'S':lane%2?'2':'1',colour=kind==='S'?[1,0.65,0.2]:lane%2?[0.35,0.65,1]:[0.9,0.9,0.95],s=scrollPosition(map.timing,o.time),e=scrollPosition(map.timing,o.endTime),from=o.time-30000;
      if(o.endTime>o.time){add(x,hit,w,12,o.time,o.endTime,from,o.endTime+120,[...colour,0.55],4,2,s,e,hit,mania?.[`NoteImage${lane}L`]??`mania-note${kind}L`);add(x,hit,w,12,o.endTime,o.endTime,from,o.endTime+120,colour,4,1,e,0,hit,mania?.[`NoteImage${lane}T`]??`mania-note${kind}T`);}
      add(x,hit,w,12,o.time,o.endTime,from,o.endTime+120,colour,4,1,s,0,hit,mania?.[`NoteImage${lane}${o.endTime>o.time?'H':''}`]??`mania-note${kind}${o.endTime>o.time?'H':''}`);
    }
    left=256-total*scale/2;for(let lane=0;lane<keys;lane++){const w=widths[lane]*scale,kind=keys%2&&lane===Math.floor(keys/2)?'S':lane%2?'2':'1';add(left+w/2,hit+20,w-2,30,0,0,-1e9,1e9,[0.3,0.32,0.36],4,11,lane,0,0,mania?.[`KeyImage${lane}`]??`mania-key${kind}`);left+=w;}
    // Uninherited beat grid; positions follow the same SV integral as notes.
    for(let i=0;i<map.timing.length;i++){const t=map.timing[i];if(!t.uninherited)continue;const next=map.timing.slice(i+1).find(p=>p.uninherited)?.time??map.duration;for(let time=t.time;time<next;time+=t.beatLength*t.meter)add(256,hit,total*scale,0.8,time,time,time-30000,time+20,[0.32,0.34,0.38,0.5],4,1,scrollPosition(map.timing,time),0,hit);}
  }else if(map.mode===1){
    add(300,192,424,92,0,0,-1e9,1e9,[0.09,0.09,0.1],4);add(90,192,78,78,0,0,-1e9,1e9,[0.85,0.85,0.85],1);add(42,192,65,74,0,0,-1e9,1e9,[0.4,0.4,0.4],0,0,0,0,0,'taiko-drum-inner');
    for(let i=map.objects.length-1;i>=0;i--){const o=map.objects[i],rim=!!(o.sound&10),big=!!(o.sound&4),r=big?31:22,t=timingAt(map.timing,o.time),velocity=speed*map.difficulty.sliderMultiplier*500/t.beatLength*t.sv,lead=480/velocity;
      if(o.type&8){add(300,192,86,86,o.time,o.endTime,o.time-lead,o.endTime,[0.9,0.7,0.2],1,7);continue;}
      if(o.type&2){add(90,192,Math.max(1,(o.endTime-o.time)*velocity),r*2,o.time,o.endTime,o.time-lead,o.endTime,[1,0.75,0.25],4,4,velocity);const interval=t.beatLength/(map.difficulty.sliderTickRate===3?6:8);for(let time=o.time;time<o.endTime;time+=interval)add(90,192,6,6,time,time,time-lead,time,[0.8,0.35,0.05],0,3,velocity);continue;}
      add(90,192,r*2,r*2,o.time,o.time,o.time-lead,o.time+120,rim?[0.22,0.65,0.85]:[0.95,0.25,0.22],0,3,velocity,0,0,big?'taiko-bigcircle':'taikohitcircle');add(90,192,r*2,r*2,o.time,o.time,o.time-lead,o.time+120,[1,1,1],1,3,velocity,0,0,'taikohitcircleoverlay');
    }
  }else{
    const fruits:{time:number;x:number;kind:number}[]=[];
    for(const o of map.objects){if(o.type&8){for(let time=o.time,n=0;time<o.endTime;time+=Math.max(35,(o.endTime-o.time)/100),n++){const x=((Math.imul(n+Math.round(o.time),1664525)+1013904223)>>>0)%512;fruits.push({time,x,kind:3});}}
      else if(o.type&2){for(let span=0;span<o.repeats;span++){const reverse=!!(span%2),start=o.time+span*o.span;fruits.push({time:start,x:pathPosition(o.path,reverse?1:0).x,kind:0});const tickTimes=[0,...o.ticks,1];for(const tick of o.ticks)fruits.push({time:start+(reverse?1-tick:tick)*o.span,x:pathPosition(o.path,tick).x,kind:1});for(let i=1;i<tickTimes.length;i++){const a=tickTimes[i-1],b=tickTimes[i],n=Math.ceil((b-a)*o.span/100);for(let j=1;j<n;j++){const progress=a+(b-a)*j/n;fruits.push({time:start+(reverse?1-progress:progress)*o.span,x:pathPosition(o.path,progress).x,kind:2});}}}fruits.push({time:o.endTime,x:pathPosition(o.path,o.repeats%2?1:0).x,kind:0});}
      else fruits.push({time:o.time,x:o.x,kind:0});}
    fruits.sort((a,b)=>a.time-b.time);const size=Math.max(8,106.75*(1-0.7*(map.difficulty.cs-5)/5)/2);let last:{time:number;x:number;kind:number}|undefined;
    for(const fruit of fruits){let hyper=false;if(last&&fruit.kind!==2){hyper=Math.abs(fruit.x-last.x)>Math.max(0,(fruit.time-last.time))*1.0+size;}if(fruit.kind!==2){last=fruit;catcher.push({time:fruit.time,x:fruit.x});}const r=fruit.kind===0?15:fruit.kind===1?7:fruit.kind===2?3:12;add(fruit.x,340,r*2,r*2,fruit.time,fruit.time,fruit.time-preempt,fruit.time+100,fruit.kind===3?[1,0.9,0.1]:palette[Math.floor(fruit.time/1000)%palette.length],0,8,0,0,0,['fruit-apple','fruit-drop','fruit-drop','fruit-bananas'][fruit.kind]);if(hyper)add(fruit.x,340,r*2.8,r*2.8,fruit.time,fruit.time,fruit.time-preempt,fruit.time,[1,0.15,0.1],1,8);}
    add(256,355,size*2,20,0,0,-1e9,1e9,[0.9,0.9,0.95],4,9,0,0,0,'fruit-catcher-idle');
  }
  const data=new Float32Array(values),count=values.length/24,chunks:Scene['chunks']=[];for(let first=0;first<count;first+=128){const n=Math.min(128,count-first);let from=Infinity,until=-Infinity;for(let i=first;i<first+n;i++){from=Math.min(from,data[i*24+6]);until=Math.max(until,data[i*24+7]);}chunks.push({first,count:n,from,until});}
  return {data,chunks,count,preempt,speed:map.mode===1?speed:map.mode===3?speed*(options.noteSpeed??1):speed,catcher};
}
