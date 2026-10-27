import {parseOsu,type Mod} from '@vosu-tools/osu-parse';
import {convertBeatmap} from '@vosu-tools/ruleset-convert';
/** Feed the exact package conversion to every native-mania calculator. */
export function convertedMania(text:string,mods:Mod[]):string|undefined{
 const source=parseOsu(text);if(source.mode!==0)return;
 const map=convertBeatmap(source,3,mods);
 const sections=text.split(/(?=^\[)/m).filter(s=>!/^\[(HitObjects|TimingPoints)\]/.test(s));
 const header=sections.join('').replace(/^Mode\s*:.*$/m,'Mode:3').replace(/^CircleSize\s*:.*$/m,`CircleSize:${map.difficulty.cs}`);
 const timing=map.timing.map(t=>`${t.time},${t.beatLength},${t.meter},${t.sampleSet},${t.sampleIndex},${t.volume},${t.uninherited?1:0},${t.effects}`).join('\n');
 const objects=map.objects.map(o=>`${o.x},${o.y},${o.time},${o.type},${o.sound},${o.type&128?`${o.endTime}:`:''}0:0:0:0:`).join('\n');
 return `${header}\n[TimingPoints]\n${timing}\n[HitObjects]\n${objects}\n`;
}
