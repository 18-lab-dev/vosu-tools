import type { Beatmap, HitObject } from "@vosu-tools/osu-parse";
import type { Simulation } from "@vosu-tools/replay";

export type SampleOrigin = "beatmap" | "skin" | "fallback" | "missing";
export interface SampleRequest { name: string; bank: number; index: number; volume: number; filename?: string }
export interface SoundEvent extends SampleRequest { time: number; duration?: number }
export interface PCM { channels: Float32Array[]; sampleRate: number }
export interface Voice { time: number; sample: PCM; gain: number; speed?: number; duration?: number }
const banks = ["normal", "normal", "soft", "drum"];
export const gain = (value: number) => Math.min(100, Math.max(0, value)) / 100;

/** Sample control points apply in time/file order, including inherited (green) lines. */
export function sampleAt(map: Beatmap, object: HitObject, time: number, edge?: number) {
  let bank = ["Normal", "Soft", "Drum"].indexOf(map.general.SampleSet) + 1;
  let index = 0, volume = 100;
  for (const point of [...map.timing].sort((a, b) => a.time - b.time || (a.order ?? 0) - (b.order ?? 0))) {
    if (point.time > time) break;
    bank = point.sampleSet || 1;
    index = point.sampleIndex;
    volume = point.volume;
  }
  const [normal, addition, custom, ownVolume, ...filename] = object.sample.split(":");
  const node = edge === undefined ? undefined : object.edgeSets?.[edge];
  const normalBank = node?.[0] || Number(normal) || bank || 1;
  return { bank: normalBank, addition: node?.[1] || Number(addition) || normalBank,
    index: Number(custom) || index, volume: (Number(ownVolume) || volume) / 100,
    filename: filename.join(":") || undefined };
}

/** Judgement timestamps, never nominal object times, are the audible clock. */
export function soundEvents(map: Beatmap, simulation: Simulation): SoundEvent[] {
  const events: SoundEvent[] = [];
  let combo = 0;
  for (const event of simulation.events) {
    if (combo >= 20 && event.combo === 0) events.push({ time: event.time, name: "combobreak", bank: 1, index: 0, volume: 1 });
    combo = event.combo;
    if (event.result === "miss" || event.kind?.includes("miss")) continue;
    if (["body", "hold", "strong", "drumroll", "slider", "spinner", "spinner_tick"].includes(event.object ?? "")) continue;
    const object = map.objects[event.note];
    if (!object) continue;
    const edge = object.type & 2 ? Math.max(0, Math.min(object.repeats, Math.round((event.time - object.time) / (object.span || 1)))) : undefined;
    const sampleTime = edge === undefined ? object.endTime + 5 : object.time + edge * object.span + 5;
    const sample = sampleAt(map, object, sampleTime, edge);
    const add = (name: string, bank = sample.bank, filename?: string) => events.push({ ...sample, name, bank, filename, time: event.time });
    if (event.object === "tick" || event.object === "slider_tick") { add("slidertick"); continue; }
    if (event.object === "spinner_bonus") { add("spinnerbonus"); continue; }
    if (map.mode === 1) {
      if (event.object === "swell") { add("taiko-hitfinish"); continue; }
      const sound = object.sound;
      add(sound & (2 | 8) ? "taiko-hitclap" : "taiko-hitnormal", sample.bank, sample.filename);
      if (sound & 4) add("taiko-hitfinish");
      continue;
    }
    if (event.object === "droplet" || event.object === "tiny_droplet") { add("slidertick"); continue; }
    if (event.object === "banana") { add("metronomelow"); continue; }
    const sound = edge === undefined ? object.sound : (object.edgeSounds[edge] ?? object.sound);
    add("hitnormal", sample.bank, sample.filename);
    for (const [bit, name] of [[2, "hitwhistle"], [4, "hitfinish"], [8, "hitclap"]] as const)
      if (sound & bit) add(name, sample.addition);
  }
  for (const interval of simulation.audio ?? []) {
    const object = map.objects[interval.note];
    if (!object) continue;
    const end = interval.endTime;
    const times = end === undefined ? [interval.time] : [...new Set([interval.time, ...map.timing.filter((point) => point.time > interval.time && point.time < end).map((point) => point.time), end])].sort((a, b) => a - b);
    for (let i = 0; i < (end === undefined ? 1 : times.length - 1); i++) {
      const sample = sampleAt(map, object, times[i]);
      const duration = end === undefined ? undefined : times[i + 1] - times[i];
      events.push({ ...sample, filename: undefined, time: times[i], name: interval.name, duration });
      if (interval.name === "sliderslide" && object.sound & 2)
        events.push({ ...sample, filename: undefined, bank: sample.addition, time: times[i], name: "sliderwhistle", duration });
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

export interface SampleCandidate { origin: "beatmap" | "skin"; filename: string }
export function sampleCandidates(sample: SampleRequest): SampleCandidate[] {
  const names: SampleCandidate[] = [];
  const push = (origin: "beatmap" | "skin", stem: string) => {
    for (const extension of ["wav", "mp3", "ogg"]) names.push({ origin, filename: `${stem}.${extension}` });
  };
  if (sample.filename) {
    if (/\.(wav|mp3|ogg)$/i.test(sample.filename)) names.push({ origin: "beatmap", filename: sample.filename });
    else push("beatmap", sample.filename);
  }
  const special = ["combobreak", "spinnerbonus", "spinnerspin", "metronomelow"].includes(sample.name);
  const taiko = sample.name.startsWith("taiko-");
  const name = taiko ? sample.name.slice(6) : sample.name;
  const stem = special ? name : `${taiko ? "taiko-" : ""}${banks[sample.bank] ?? "normal"}-${name}`;
  if (!sample.filename) push("beatmap", `${stem}${sample.index > 1 ? sample.index : ""}`);
  push("skin", stem);
  if (!special) push("skin", sample.name);
  return names;
}

/** Original, generated percussion; no third-party game assets. */
export function fallbackSample(name: string, sampleRate = 48000): PCM {
  const data = new Float32Array(Math.round(sampleRate * (name === "combobreak" ? 0.22 : 0.055)));
  const frequency = name.includes("clap") ? 1700 : name.includes("finish") ? 1100 : name.includes("whistle") ? 2200 : 650;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate, envelope = Math.exp(-t * 85) * Math.min(1, i / 24);
    data[i] = 0.35 * envelope * (Math.sin(2 * Math.PI * frequency * t) + 0.25 * Math.sin(2 * Math.PI * frequency * 2.7 * t));
  }
  return { channels: [data], sampleRate };
}

/** Deterministic linear resampling and summation; timestamps round once to a PCM frame. */
export function mix(voices: Voice[], seconds: number, master = 80, limiter = true, sampleRate = 48000) {
  const channels = [new Float32Array(Math.ceil(seconds * sampleRate)), new Float32Array(Math.ceil(seconds * sampleRate))];
  for (const voice of voices) {
    const start = Math.round(voice.time * sampleRate / 1000);
    const step = voice.sample.sampleRate / sampleRate * (voice.speed ?? 1);
    const length = voice.duration === undefined ? Math.ceil(voice.sample.channels[0].length / step) : Math.round(voice.duration * sampleRate / 1000);
    for (let c = 0; c < 2; c++) {
      const source = voice.sample.channels[Math.min(c, voice.sample.channels.length - 1)];
      const output = channels[c];
      for (let i = Math.max(0, -start); i < length && start + i < output.length; i++) {
        const position = voice.duration === undefined ? i * step : (i * step) % source.length;
        const low = Math.floor(position), fraction = position - low;
        const next = voice.duration === undefined ? (source[low + 1] ?? 0) : source[(low + 1) % source.length];
        output[start + i] += ((source[low] ?? 0) * (1 - fraction) + next * fraction) * voice.gain * gain(master);
      }
    }
  }
  let peak = 0, clippedSamples = 0, outputPeak = 0, outputClippedSamples = 0, envelope = 0;
  const release = Math.exp(-1 / (0.05 * sampleRate));
  for (let i = 0; i < channels[0].length; i++) {
    envelope = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1][i]), envelope * release);
    const attenuation = limiter ? 1 / Math.max(1, envelope) : 1;
    for (const channel of channels) {
      peak = Math.max(peak, Math.abs(channel[i]));
      if (Math.abs(channel[i]) > 1) clippedSamples++;
      channel[i] *= attenuation;
      outputPeak = Math.max(outputPeak, Math.abs(channel[i]));
      if (Math.abs(channel[i]) > 1) outputClippedSamples++;
    }
  }
  return { channels, sampleRate, report: { peak, clippedSamples, outputPeak, outputClippedSamples, limiter } };
}

/** One pre-mixed WebAudio voice: seeks and scrubbing cannot stack effects. */
export class MixScheduler {
  private source?: AudioBufferSourceNode;
  private started = 0;
  private offset = 0;
  constructor(private context: AudioContext, private buffer: AudioBuffer) {}
  stop() { this.source?.stop(); this.source?.disconnect(); this.source = undefined; }
  sync(offset: number, playing: boolean, force = false) {
    if (!playing || offset < 0 || offset >= this.buffer.duration) { this.stop(); return; }
    const expected = this.offset + this.context.currentTime - this.started;
    if (this.source && !force && Math.abs(expected - offset) < 0.08) return;
    this.stop();
    void this.context.resume();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.context.destination);
    this.source = source; this.offset = offset; this.started = this.context.currentTime;
    source.onended = () => { if (this.source === source) this.source = undefined; source.disconnect(); };
    source.start(this.started, offset);
  }
}
