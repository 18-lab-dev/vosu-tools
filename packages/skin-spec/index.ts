import data from './spec.json';
export const revision = data.revision;
export interface Spec {section:string;key:string;type:string;default?:string;enum?:string[];min?:number;max?:number;since?:number;columns?:number;indexBase?:number}
export const spec: Spec[] = data.entries;
export const sections = ['General','Colours','Fonts','CatchTheBeat','Mania'];
export interface Line {raw:string;eol:string;line:number;section:string;block:number;key?:string;value?:string;valueColumn?:number}
export interface Document {lines:Line[]}
export function parse(text:string):Document {
  let section='',block=0;
  const lines:Line[]=[];
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const raw=match[1], trimmed=raw.replace(/^\uFEFF/,'').trim();
    const header=trimmed.match(/^\[([^\]]+)\]$/);
    if(header){section=header[1];block++;}
    const entry = !/^(\/\/|;|\[)/.test(trimmed) ? raw.match(/^\s*([^:]+?)\s*:\s*(.*)$/) : null;
    lines.push({raw,eol:match[2],line:lines.length+1,section,block,...(entry?{key:entry[1].trim().replace(/^\uFEFF/,''),value:entry[2].trim(),valueColumn:raw.indexOf(':')+2+(raw.slice(raw.indexOf(':')+1).match(/^\s*/)?.[0].length??0)}:{})});
  }
  return {lines};
}
export function serialize(doc:Document):string{return doc.lines.map(l=>l.raw+l.eol).join('');}
export function setValue(doc:Document,lineNumber:number,value:string):Document {
  return parse(doc.lines.map(l=>l.line===lineNumber ? l.raw.slice(0,(l.valueColumn??1)-1)+value+l.eol : l.raw+l.eol).join(''));
}
export function resolve(section:string,key:string):Spec|undefined {
  return spec.find(s=>s.section===section && (s.key===key || (s.key.includes('#') && new RegExp('^'+s.key.replace('#','\\d+')+'$').test(key))));
}
export function keys(section:string,count=4):Spec[]{return spec.filter(s=>s.section===section).flatMap(s=>s.key.includes('#')?Array.from({length:count},(_,i)=>({...s,key:s.key.replace('#',String(i+(s.indexBase??0)))})):[s]);}
export function pathCandidates(files:string[],prefix=false):string[]{
  const names=files.filter(f=>/\.(png|jpe?g)$/i.test(f)).map(f=>f.replace(/\.(png|jpe?g)$/i,'').replace(/@2x$/i,''));
  return [...new Set(names.flatMap(n=>prefix ? /-\d+$/.test(n)?[n.replace(/-\d+$/,'')]:[] : [n,n.replace(/-\d+$/,'')]))].sort();
}
export function hasAsset(value:string,files:string[],prefix=false):boolean {
  const base=value.replace(/\\/g,'/').replace(/\.(png|jpe?g)$/i,'').replace(/@2x$/,'');
  if (/^(\/|[A-Za-z]:)|(^|\/)\.\.(\/|$)/.test(base)) return false;
  const names=files.map(f=>f.replace(/\\/g,'/').replace(/\.(png|jpe?g)$/i,'').replace(/@2x$/,''));
  return prefix ? Array.from({length:10},(_,i)=>`${base}-${i}`).every(n=>names.includes(n)) : names.some(n=>n===base||n===`${base}-0`);
}
export interface Diagnostic {line:number;column:number;message:string;severity:'error'|'warning';replacement?:string}
export function validate(text:string,files?:string[]):Diagnostic[]{
  const doc=parse(text),out:Diagnostic[]=[];
  const versionLine=doc.lines.find(l=>l.section==='General'&&l.key==='Version');
  const version=versionLine?.value==='latest'?Infinity:Number(versionLine?.value??1);
  const blocks=new Map<number,number>();
  for(const l of doc.lines) if(l.section==='Mania'&&l.key==='Keys') blocks.set(l.block,Number(l.value));
  const seen=new Set<string>();
  for(const l of doc.lines){
    const emit=(message:string,severity:'error'|'warning'='error',replacement?:string)=>out.push({line:l.line,column:l.valueColumn??1,message,severity,replacement});
    if(!sections.includes(l.section)&&l.raw.trim().startsWith('[')){const fix=sections.find(s=>s.toLowerCase()===l.section.toLowerCase())??(l.section==='Colors'?'Colours':undefined);emit('Unknown section; commands are case-sensitive.','warning',fix?`[${fix}]`:undefined);}
    if(l.section==='Mania'&&l.raw.trim()==='[Mania]'&&!blocks.has(l.block))emit('Each Mania section requires Keys.');
    if(!l.key){if(l.raw.trim()&&!/^(\uFEFF?\s*\[|\s*\/\/|\s*;)/.test(l.raw))emit('Expected Key: value.');continue;}
    const s=resolve(l.section,l.key);
    if(!s){const fix=keys(l.section,blocks.get(l.block)).find(s=>s.key.toLowerCase()===l.key!.toLowerCase());emit('Unknown key; retained unchanged.','warning',fix?.key);continue;}
    const id=`${l.block}:${l.key}`;if(seen.has(id))emit('Duplicate key in this section.','warning');seen.add(id);
    const v=l.value??'', nums=v.split(',').map(x=>Number(x.trim()));
    const numeric=(integer=false)=>nums.every((n,i)=>v.split(',')[i].trim()!==''&&Number.isFinite(n)&&(!integer||Number.isInteger(n))&&(s.min===undefined||n>=s.min));
    if(s.type==='enum'&&!s.enum?.includes(v))emit(`Expected ${s.enum?.join(' / ')}.`);
    if(['integer','number','integers','numbers'].includes(s.type)&&(!numeric(s.type.includes('integer'))||(!s.type.endsWith('s')&&nums.length!==1))&&!(s.key==='AnimationFramerate'&&v==='-1'))emit(`Expected ${s.type}${s.min!==undefined?` ≥ ${s.min}`:''}.`);
    if(['rgb','rgba'].includes(s.type)&&(!(s.type==='rgba'?[3,4]:[3]).includes(nums.length)||!numeric(true)||nums.some(n=>n<0||n>255)))emit('Expected RGB channels 0–255'+(s.type==='rgba'?' with optional alpha 0–255.':'.'));
    if(s.since&&version<s.since)emit(`Requires Version ${s.since} or higher.`,'warning');
    const count=blocks.get(l.block);
    if(count&&s.columns!==undefined&&nums.length!==count+s.columns)emit(`Expected ${count+s.columns} values for Keys: ${count}; missing values use defaults, extras are ignored.`,'warning');
    if(count&&s.indexBase!==undefined){const index=Number(l.key.match(/\d+/)?.[0]);if(index<s.indexBase||index>=count+s.indexBase)emit(`Column index outside this ${count}-key layout.`);}
    if(files&&(s.type==='image'||s.type==='prefix')&&v&&!hasAsset(v,files,s.type==='prefix'))emit(s.type==='prefix'?'Missing digit image(s): prefix requires -0 through -9 (normal or @2x).':'Missing image (including @2x / first animation frame).','warning');
  }
  return out;
}
export function documentation(s:Spec):string{return `**${s.key}** · [${s.section}]\n\n${s.type}${s.enum?': '+s.enum.join(' / '):''}${s.min!==undefined?' · minimum '+s.min:''}${s.default!==undefined?'\n\nDefault: `'+s.default+'`':''}${s.since?'\n\nRequires Version '+s.since:''}${s.columns!==undefined?'\n\nList length: Keys '+(s.columns>=0?'+':'')+s.columns:''}${s.type==='image'?'\n\nSkin-relative image name, without extension. @2x and animation frame 0 are resolved.':''}\n\n[osu! wiki reference](https://osu.ppy.sh/wiki/en/Skinning/skin.ini)`;}
