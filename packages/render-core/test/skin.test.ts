import { expect, test } from "bun:test";
import { parseOsu, parseSkinIni } from "@vosu-tools/osu-parse";
import { compileScene } from "../src/scene";
import type { Skin, AtlasRegion } from "../src/skin";
const source =
  "osu file format v14\n[General]\nMode:3\n[Difficulty]\nCircleSize:4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,1000,128,0,2000:0:0:0:0:";
test("skin-defined stage, normal/pressed keys, lighting and repeating hold body use atlas instances", () => {
  const sections = parseSkinIni(
    "[General]\nVersion:2.7\nAnimationFramerate:20\n[Mania]\nKeys:4\nColumnStart:286.67\nColumnWidth:70,70,70,70\nColumnSpacing:2,2,2\nHitPosition:457\nLightPosition:440\nNoteBodyStyle:1\nStageLeft:left\nStageRight:right\nStageBottom:bottom\nStageHint:hint\nStageLight:light\nKeyImage0:key\nKeyImage0D:pressed\nNoteImage0:note\nNoteImage0H:note\nNoteImage0L:body\nNoteImage0T:tail",
  );
  const skin: Skin = { name: "test", assets: new Map(), sections };
  const regions = new Map<string, AtlasRegion>();
  let first = 0;
  for (const name of [
    "left",
    "right",
    "bottom",
    "hint",
    "light",
    "key",
    "pressed",
    "note",
    "body",
    "tail",
  ])
    regions.set(name, {
      u: 0,
      v: 0,
      w: 0.1,
      h: 0.05,
      width: 140,
      height: 70,
      first: first++,
      count: 2,
      fps: 20,
    });
  const scene = compileScene(parseOsu(source), {}, regions, skin),
    instances = Array.from({ length: scene.count }, (_, i) => [
      ...scene.data.slice(i * 24, i * 24 + 24),
    ]),
    motions = instances.map((instance) => instance[12]);
  expect(motions).toContain(11);
  expect(motions).toContain(12);
  expect(motions).toContain(13);
  // NoteBodyStyle 1 is not Stretch: lazer's 32800-unit body (kind 14).
  const body = instances.filter((instance) => instance[12] === 14);
  expect(body).toHaveLength(1);
  // Hit position 457: 36.8 lazer units above the stage's bottom edge (render y 409).
  expect(body[0][15]).toBe(409);
  expect(body[0][21]).toBe(8);
  expect(body[0][23]).toBeCloseTo(1000 / 30);
  // Half the head's and tail's heights: 140×70 images at the 112-unit column width.
  expect(body[0][1]).toBeCloseTo(56 / 1.6 / 2);
  expect(body[0][3]).toBeCloseTo(56 / 1.6 / 2);
  expect(body[0].slice(8, 11)).toEqual([1, 1, 1]);
  // Stage bottom: 1.6× the image, on the stage's bottom edge.
  const bottom = instances.at(-1)!;
  expect(bottom[21]).toBe(2);
  expect(bottom[2]).toBeCloseTo(140);
  expect(bottom[3]).toBeCloseTo(70);
  expect(bottom[1] + bottom[3] / 2).toBeCloseTo(432);
  // Keys: column wide, the image's own height (70 lazer units), on the bottom edge.
  const key = instances.find((instance) => instance[12] === 11)!;
  expect(key[2]).toBeCloseTo(70);
  expect(key[3]).toBeCloseTo(70 / 1.6);
  expect(key[1] + key[3] / 2).toBeCloseTo(432);
  // Column light: bottom edge on LightPosition 440.
  const light = instances.find((instance) => instance[12] === 13)!;
  expect(light[1] + light[3] / 2).toBeCloseTo(392);
  expect(light[23]).toBe(60);
  const unlit = compileScene(
    parseOsu(source),
    { hitLighting: false },
    regions,
    skin,
  );
  expect(
    Array.from({ length: unlit.count }, (_, i) => unlit.data[i * 24 + 12]).some(
      (motion) => motion === 13 || motion === 18 || motion === 19,
    ),
  ).toBe(false);
  expect(unlit.count).toBeLessThan(scene.count);
});
test("all catcher states select separate skinned sprites", () => {
  const map = parseOsu(source);
  map.mode = 2;
  const regions = new Map<string, AtlasRegion>();
  for (const name of [
    "fruit-catcher-idle",
    "fruit-catcher-kiai",
    "fruit-catcher-fail",
  ])
    regions.set(name, {
      u: 0,
      v: 0,
      w: 0.1,
      h: 0.1,
      first: 0,
      count: 1,
      fps: 60,
    });
  const scene = compileScene(map, {}, regions);
  const states = [];
  for (let i = 0; i < scene.count; i++)
    if (scene.data[i * 24 + 12] >= 15) states.push(scene.data[i * 24 + 12]);
  expect(states).toEqual([15, 16, 17]);
});
