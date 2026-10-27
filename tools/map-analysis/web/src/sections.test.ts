import {test,expect} from 'bun:test';
import {sections} from './sections';
import {convertedMania} from './played';
import {demo} from '../../../../../packages/demo-maps/src';
import {parseOsu} from '@vosu-tools/osu-parse';
import {playedRuleset} from '@vosu-tools/tool-web';

test('played ruleset precedence excludes stale play mode',()=>{
 expect(playedRuleset(2,{name:'mania'},{name:'taiko'},{name:'osu'})).toBe('mania');
 expect(playedRuleset(1,{name:'mania'},{name:'taiko'},{name:'osu'})).toBe('taiko');
 expect(playedRuleset(1,null,null,{name:'fruits'})).toBe('fruits');
});
for(const [id,mode] of [['osu',0],['taiko',1],['fruits',2]] as const){
 test(`${id} sections are finite, explicitly ours, and rate aware`,()=>{
  const slow=sections(demo(id).osu,mode,[],1),fast=sections(demo(id).osu,mode,[],1.5);
  expect(slow.units).toContain('ours');expect(slow.points.length).toBeGreaterThan(0);
  expect(fast.duration).toBeCloseTo(slow.duration/1.5,6);
  for(const point of slow.points){expect(Number.isFinite(point.value)).toBe(true);expect(point.nps).toBeGreaterThanOrEqual(0);}
 });
}
test('standard converts use shared package for all played rulesets',()=>{
 for(const mode of [1,2] as const)expect(sections(demo('osu').osu,mode,[],1).points.length).toBeGreaterThan(0);
 const text=convertedMania(demo('osu').osu,[{acronym:'4K'}]);
 expect(text).toBeDefined();expect(parseOsu(text!).mode).toBe(3);expect(parseOsu(text!).objects.length).toBeGreaterThan(0);
 expect(convertedMania(demo('mania-4k').osu,[])).toBeUndefined();
});
