import { expect, test } from "bun:test";
import { parseOsu } from "@vosu-tools/osu-parse";
import type { Simulation, Judgement } from "@vosu-tools/replay";
import { fallbackSample, gain, mix, MixScheduler, sampleAt, sampleCandidates, soundEvents } from "../src/audio";
import { wav } from "../src/audio-mix";
const map = () => parseOsu(`osu file format v14\n[General]\nMode:0\nSampleSet:Normal\n[Difficulty]\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,2,3,65,1,0\n500,-100,4,3,2,40,0,0\n[HitObjects]\n256,192,1000,1,10,0:0:0:0:\n`);
const judgement = (time: number, combo: number, result = "n300") => ({ time, note: 0, combo, result, object: "circle", offset: 27, x: 256, y: 192 }) as Judgement;
const simulation = (events: Judgement[]) => ({ events }) as Simulation;
test("legacy banks and custom-index lookup prefer beatmap before skin, WAV before MP3 before OGG", () => {
  expect(sampleCandidates({ name: "hitnormal", bank: 2, index: 3, volume: 1 }).map((x) => `${x.origin}:${x.filename}`)).toEqual([
    "beatmap:soft-hitnormal3.wav", "beatmap:soft-hitnormal3.mp3", "beatmap:soft-hitnormal3.ogg",
    "skin:soft-hitnormal.wav", "skin:soft-hitnormal.mp3", "skin:soft-hitnormal.ogg",
    "skin:hitnormal.wav", "skin:hitnormal.mp3", "skin:hitnormal.ogg",
  ]);
  expect(sampleCandidates({ name: "taiko-hitnormal", bank: 1, index: 0, volume: 1 })[0].filename).toBe("taiko-normal-hitnormal.wav");
});
test("green timing lines inherit sample bank/index/volume; object overrides win", () => {
  const m = map(), object = m.objects[0];
  expect(sampleAt(m, object, 999)).toMatchObject({ bank: 3, addition: 3, index: 2, volume: 0.4 });
  object.sample = "1:2:4:25:My Sample.WAV";
  expect(sampleAt(m, object, 999)).toMatchObject({ bank: 1, addition: 2, index: 4, volume: 0.25, filename: "My Sample.WAV" });
});
test("parser retains slider edge sample sets and hold filename/volume", () => {
  const m = parseOsu("osu file format v14\n[HitObjects]\n64,192,1000,128,0,1500:2:3:4:35:hold.wav\n256,192,2000,2,2,L|356:192,1,100,2|4,1:2|3:1,2:3:4:50:slide.wav\n");
  expect(m.objects[0].sample).toBe("2:3:4:35:hold.wav");
  expect(m.objects[1].edgeSets).toEqual([[1, 2], [3, 1]]);
  expect(m.objects[1].sample).toBe("2:3:4:50:slide.wav");
});
test("effects follow actual judgement and combo break is at least twenty", () => {
  const m = map();
  const events = soundEvents(m, simulation([judgement(1027, 20), judgement(1500, 0, "miss")]));
  expect(events.filter((x) => x.name === "combobreak").map((x) => x.time)).toEqual([1500]);
  expect(events.filter((x) => x.name !== "combobreak").every((x) => x.time === 1027)).toBe(true);
  expect(soundEvents(m, simulation([judgement(1027, 19), judgement(1500, 0, "miss")])).some((x) => x.name === "combobreak")).toBe(false);
});
test("volume gain is linear and zero really silences", () => {
  expect(gain(50)).toBe(0.5);
  const sample = { channels: [Float32Array.of(0.5, 0.25)], sampleRate: 48000 };
  const a = mix([{ time: 0, sample, gain: 0.8 }], 0.01, 100, false);
  const b = mix([{ time: 0, sample, gain: 0.8 }], 0.01, 50, false);
  expect(b.channels[0][0] / a.channels[0][0]).toBe(0.5);
  expect(mix([{ time: 0, sample, gain: 0.8 }], 0.01, 0).report.peak).toBe(0);
});
test("same mix hashes identically and timestamps round once within a sample", async () => {
  const voices = [{ time: 1027.123, sample: fallbackSample("hitnormal"), gain: 0.8 }];
  const a = wav(mix(voices, 2, 100)), b = wav(mix(voices, 2, 100));
  expect(new Bun.CryptoHasher("sha256").update(a).digest("hex")).toBe(new Bun.CryptoHasher("sha256").update(b).digest("hex"));
  const samples = mix([{ time: 1027.123, sample: { channels: [Float32Array.of(1)], sampleRate: 48000 }, gain: 1 }], 2, 100).channels[0];
  expect(Math.abs(samples.findIndex((x) => x !== 0) / 48 - 1027.123)).toBeLessThanOrEqual(1 / 48);
});
test("limiter prevents overload and reports both pre/post clipping", () => {
  const voices = [{ time: 0, sample: { channels: [Float32Array.of(2, -3, 0.5)], sampleRate: 48000 }, gain: 1 }];
  expect(mix(voices, 0.01, 100, true).report).toMatchObject({ peak: 3, clippedSamples: 4, outputPeak: 1, outputClippedSamples: 0 });
  expect(mix(voices, 0.01, 100, false).report).toMatchObject({ peak: 3, clippedSamples: 4, outputPeak: 3, outputClippedSamples: 4 });
});
test("preview seek/pause cancels old sources and caps at one voice", () => {
  let live = 0, maximum = 0, started = 0;
  const context = { currentTime: 0, destination: {}, resume: async () => {}, createBufferSource: () => ({ connect() {}, disconnect() {}, start() { started++; live++; maximum = Math.max(maximum, live); }, stop() { live--; } }) } as unknown as AudioContext;
  const scheduler = new MixScheduler(context, { duration: 10 } as AudioBuffer);
  scheduler.sync(0, true); scheduler.sync(0.01, true); expect(started).toBe(1);
  scheduler.sync(4, true, true); expect(started).toBe(2); expect(maximum).toBe(1);
  scheduler.sync(4, false); expect(live).toBe(0);
  scheduler.sync(7, true); scheduler.stop(); expect(live).toBe(0);
});
