import {parseOsu,applyMods,type Mod,type Ruleset} from '@vosu-tools/osu-parse';
import {convertBeatmap,catchObjects} from '@vosu-tools/ruleset-convert';
export type SectionPoint={time:number;value:number;nps:number;metrics:Record<string,number>};
/** Descriptive counts, not official difficulty or community calculator output. */
export function sections(text:string,mode:Ruleset,mods:Mod[],rate:number,window=12,hop=1){
 if(!Number.isFinite(window)||window<.1||window>60||!Number.isFinite(hop)||hop<.05||hop>60)throw Error('window must be 0.1–60s; hop must be 0.05–60s');
 if(!Number.isFinite(rate)||rate<.5||rate>2)throw Error('rate must be 0.5–2.0');
 const map=applyMods(convertBeatmap(parseOsu(text),mode,mods),mods);
 const objects=mode===2?catchObjects(map).filter(o=>o.kind==='fruit'||o.kind==='droplet').map(o=>({time:o.time,x:o.x,y:0,type:1,sound:0,hyper:o.hyper})):map.objects.map(o=>({...o,hyper:false}));
 const duration=(objects.at(-1)?.time??0)/1000/rate;
 const points:SectionPoint[]=[];
 const labels=mode===0?['Streams','Jumps','Bursts','Sliders']:mode===1?['Colour changes','Rhythm changes','Stamina hits']:['Hyperdashes','Direction changes'];
 const runLengths=new Uint32Array(objects.length);
 for(let a=0;a<objects.length;){let b=a;while(b+1<objects.length&&(objects[b+1].time-objects[b].time)/rate<=200)b++;runLengths.fill(b-a+1,a,b+1);a=b+1;}
 const events=objects.map((o,i)=>{
  const prev=objects[i-1],before=objects[i-2],dt=prev?(o.time-prev.time)/rate:Infinity;
  const metrics=Object.fromEntries(labels.map(l=>[l,0]));
  if(mode===0){
   if(o.type&2)metrics.Sliders=1;
   if(prev&&Math.hypot(o.x-prev.x,o.y-prev.y)>=100)metrics.Jumps=1;
   if(dt>0&&dt<=200){
    metrics[runLengths[i]>=8?'Streams':'Bursts']=1;
   }
  }else if(mode===1){
   if(prev&&Boolean(o.sound&10)!==Boolean(prev.sound&10))metrics['Colour changes']=1;
   if(before&&prev){const last=(prev.time-before.time)/rate;if(dt>0&&last>0&&Math.abs(Math.log2(dt/last))>.25)metrics['Rhythm changes']=1;}
   if(dt>0&&dt<=200)metrics['Stamina hits']=1;
  }else{
   metrics.Hyperdashes=o.hyper?1:0;
   if(prev&&before&&(o.x-prev.x)*(prev.x-before.x)<0)metrics['Direction changes']=1;
  }
  return {time:o.time/1000/rate,metrics};
 });
 let first=0,last=0;
 const sums=Object.fromEntries(labels.map(l=>[l,0]));
 for(let time=0;time<=duration;time+=hop){
  const a=Math.max(0,time-window/2),b=Math.min(duration+.001,time+window/2),span=Math.max(.001,b-a);
  while(last<events.length&&events[last].time<b){for(const label of labels)sums[label]+=events[last].metrics[label];last++;}
  while(first<last&&events[first].time<a){for(const label of labels)sums[label]-=events[first].metrics[label];first++;}
  const metrics=Object.fromEntries(labels.map(l=>[l,sums[l]/span]));
  points.push({time,value:Math.max(0,...Object.values(metrics)),nps:(last-first)/span,metrics});
 }
 return {duration,units:'Events/s (ours)',window,hop,points,labels};
}
