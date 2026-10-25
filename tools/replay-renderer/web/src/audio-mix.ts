import { replayPitched } from "@vosu-tools/replay";
import { ApiError, ENTRY_HOLD_MS, ENTRY_FADE_MS, type Track, type Fetcher } from "./studio";
import { fallbackSample, gain, mix, sampleCandidates, soundEvents, type PCM, type SampleOrigin, type Voice } from "./audio";

export function wav(pcm: PCM): ArrayBuffer {
  const frames = pcm.channels[0].length, output = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(output);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, output.byteLength - 8, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, pcm.sampleRate, true); view.setUint32(28, pcm.sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) {
    const value = Math.max(-1, Math.min(1, pcm.channels[Math.min(c, pcm.channels.length - 1)][i]));
    view.setInt16(44 + i * 4 + c * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return output;
}

/** Decode each unique file once, including shared samples across players. */
export async function compositionAudio(tracks: Pick<Track, "replay" | "map" | "simulation" | "settings" | "skin" | "builtinSamples">[], start: number, duration: number, fadeMs: number, fetcher: Fetcher, prefix = "v1/assets") {
  const decoder = new OfflineAudioContext(2, 1, 48000);
  const cache = new Map<string, Promise<PCM | null>>();
  const undecodable: { url: string; error: string }[] = [];
  const decode = (url: string) => {
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        let response: Response;
        try { response = await fetcher(url); }
        catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Sample fetch failed (${response.status}): ${url}`);
        let buffer: AudioBuffer;
        try { buffer = await decoder.decodeAudioData(await response.arrayBuffer()); }
        catch (error) {
          if (!(error instanceof DOMException) || error.name !== "EncodingError" || new URL(url, location.href).searchParams.get("kind") === "music") throw error;
          undecodable.push({ url, error: error.message });
          return null;
        }
        return { channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), sampleRate: buffer.sampleRate };
      })();
      cache.set(url, pending);
    }
    return pending;
  };
  const first = tracks[0], rate = first.replay.rate;
  const voices: Voice[] = [], samples: { track: number; name: string; origin: SampleOrigin; filename?: string }[] = [];
  const music = await decode(`${prefix}?${new URLSearchParams({ kind: "music", hash: first.replay.beatmapHash, path: first.map.general.AudioFilename, rate: String(rate), pitch: replayPitched(first.replay) ? "1" : "0" })}`);
  if (music) voices.push({ sample: music, time: -start / rate, gain: gain(first.settings["audio.music"] ?? 100) });
  for (const [trackIndex, track] of tracks.entries()) {
    if (!track.simulation || track.settings["audio.mute"] === 1 || track.settings["audio.hitsounds"] === 0) continue;
    const loaded = new Map<string, { pcm: PCM | null; origin: SampleOrigin; filename?: string }>();
    for (const event of soundEvents(track.map, track.simulation)) {
      const key = JSON.stringify([event.name, event.bank, event.index, event.filename]);
      let sample = loaded.get(key);
      if (!sample) {
        sample = { pcm: null, origin: "missing" };
        for (const candidate of sampleCandidates(event)) {
          if (candidate.origin === "skin" && track.builtinSamples) continue;
          const query = new URLSearchParams({ kind: candidate.origin === "beatmap" ? "map-asset" : "skin", path: candidate.filename });
          if (candidate.origin === "beatmap") query.set("hash", track.replay.beatmapHash);
          else if (track.skin) query.set("skin", track.skin);
          const pcm = await decode(`${prefix}?${query}`);
          if (pcm) { sample = { pcm, origin: candidate.origin, filename: candidate.filename }; break; }
        }
        if (!sample.pcm && track.settings["audio.fallback"] !== 0) sample = { pcm: fallbackSample(event.name), origin: "fallback" };
        loaded.set(key, sample);
        samples.push({ track: trackIndex, name: key, origin: sample.origin, filename: sample.filename });
      }
      if (sample.pcm) voices.push({ sample: sample.pcm, time: (event.time - start) / rate,
        gain: event.volume * gain(track.settings["audio.hitsounds"] ?? 80),
        duration: event.duration === undefined ? undefined : event.duration / rate,
        speed: track.simulation.client === "lazer" || (track.replay.mods & 512) !== 0 ? rate : 1 });
    }
  }
  const result = mix(voices, duration / rate / 1000, first.settings["audio.master_mute"] === 1 ? 0 : (first.settings["audio.master"] ?? 100), first.settings["audio.limiter"] !== 0);
  const wallMs = duration / rate;
  for (const channel of result.channels) for (let i = 0; i < channel.length; i++) {
    const ms = i * 1000 / result.sampleRate;
    channel[i] *= Math.min(1, Math.max(0, (ms - ENTRY_HOLD_MS) / ENTRY_FADE_MS), fadeMs ? Math.max(0, (wallMs - ms) / fadeMs) : 1);
  }
  return { ...result, samples, undecodable, wav: wav(result) };
}
