export type { ToolIdentity, VosuBridge } from "./bridge.js";
/** Selected-field telemetry: play mode only applies during active gameplay. */
export function playedRuleset(state: number, play: unknown, settings: unknown, beatmap: unknown): 'osu'|'taiko'|'fruits'|'mania' {
  const name=(value:unknown)=>typeof value==='object'&&value!==null&&'name' in value?String(value.name):typeof value==='string'?value:'';
  const value=(state===2?name(play):'')||name(settings)||name(beatmap);
  return value==='taiko'?'taiko':value==='fruits'||value==='catch'?'fruits':value==='mania'?'mania':'osu';
}
