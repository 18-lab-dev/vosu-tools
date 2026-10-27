// Run after building packages/ruleset-convert/test/reference against
// ppy/osu 2025-10-13 (28c846b4d9366484792e27f4729cd1afa2cdeb66).
// bun tools/map-analysis/tests/reference/official.ts DOTNET ORACLE.dll SCRATCH
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const [dotnet,oracle,scratch]=Bun.argv.slice(2);
if(!dotnet||!oracle||!scratch)throw Error('provide dotnet, oracle.dll and private scratch directory');
for(const dir of ['home','config','cache','data','state','runtime'])await mkdir(resolve(scratch,dir),{recursive:true,mode:0o700});
const rows=[];
for(const mode of ['osu','taiko','fruits','mania'])for(const copies of [1,2,4]){
 const chart=mode==='mania'?`mania-${copies===1?4:copies===2?7:8}k.osu`:`${mode}-${copies}.osu`;
 for(const mods of ['', 'HD,HR','DT','HT']){
  const command=['unshare','-rn','--pid','--fork','--mount-proc',dotnet,oracle,mode,resolve(import.meta.dir,'../fixtures/demo',chart),mods,'difficulty'];
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe',env:{...process.env,HOME:resolve(scratch,'home'),XDG_CONFIG_HOME:resolve(scratch,'config'),XDG_CACHE_HOME:resolve(scratch,'cache'),XDG_DATA_HOME:resolve(scratch,'data'),XDG_STATE_HOME:resolve(scratch,'state'),XDG_RUNTIME_DIR:resolve(scratch,'runtime')}});
  const text=await new Response(child.stdout).text(),error=await new Response(child.stderr).text();
  if(await child.exited!==0)throw Error(error);
  rows.push({chart,mode,mods:mods.replaceAll(',',''),rate:mods==='DT'?1.5:mods==='HT'?.75:1,attributes:JSON.parse(text)});
 }
}
await Bun.write(new URL('../fixtures/official-lazer.json',import.meta.url),JSON.stringify({source:'ppy/osu 2025-10-13 / 28c846b4d9366484792e27f4729cd1afa2cdeb66',rows},null,2)+'\n');
