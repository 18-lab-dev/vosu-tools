import { Muxer, ArrayBufferTarget } from "webm-muxer";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type Layout = "side-by-side" | "stacked" | "grid";
export function layoutRects(
  count: number,
  width: number,
  height: number,
  layout: Layout,
  gap = 8,
): Rect[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 16 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    gap < 0
  )
    throw new Error("Invalid layout dimensions");
  const columns =
    layout === "side-by-side"
      ? count
      : layout === "stacked"
        ? 1
        : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cellWidth = (width - gap * (columns - 1)) / columns,
    cellHeight = (height - gap * (rows - 1)) / rows;
  if (cellWidth < 1 || cellHeight < 1) throw new Error("Layout is too small");
  return Array.from({ length: count }, (_, i) => {
    const x = Math.round((i % columns) * (cellWidth + gap)),
      y = Math.round(Math.floor(i / columns) * (cellHeight + gap));
    return {
      x,
      y,
      width: Math.round((i % columns) * (cellWidth + gap) + cellWidth) - x,
      height:
        Math.round(Math.floor(i / columns) * (cellHeight + gap) + cellHeight) -
        y,
    };
  });
}
export interface ExportOptions {
  fps: number;
  width: number;
  height: number;
  durationMs: number;
  rate?: number;
  startMs?: number;
  audio?: ArrayBuffer;
  /** Already mixed on the wall-clock timeline; do not retime or fade again. */
  audioIsMix?: boolean;
  volume?: number;
  /** Audio fades, wall-clock ms: silent for `inDelayMs`, then in over `inMs`;
   *  out over the last `outMs`. The picture's fade is the renderer's. */
  fade?: { inDelayMs: number; inMs: number; outMs: number };
  signal?: AbortSignal;
  render(
    timeMs: number,
  ):
    | Promise<HTMLCanvasElement | OffscreenCanvas>
    | HTMLCanvasElement
    | OffscreenCanvas;
  progress?(fraction: number): void;
}
/** Integer frame indices are the clock. No requestAnimationFrame or wall-time scheduling enters export. */
export async function exportWebM(options: ExportOptions): Promise<Blob> {
  const { fps, width, height, durationMs, render, signal } = options;
  const rate = options.rate ?? 1;
  if (
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > 240 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  )
    throw new Error("Invalid export parameters");
  if (typeof VideoEncoder === "undefined")
    throw new Error(
      "This browser does not support WebCodecs. Use the native render command.",
    );
  const config: VideoEncoderConfig = {
    codec: "vp09.00.10.08",
    width,
    height,
    bitrate: Math.round(width * height * fps * 0.12),
    framerate: fps,
    latencyMode: "quality",
  };
  if (!(await VideoEncoder.isConfigSupported(config)).supported)
    throw new Error("VP9 encoding is unavailable in this browser");
  const wallDuration = durationMs / rate / 1000;
  let audio: AudioBuffer | undefined;
  if (options.audio) {
    if (
      typeof AudioEncoder === "undefined" ||
      !(
        await AudioEncoder.isConfigSupported({
          codec: "opus",
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128000,
        })
      ).supported
    )
      throw new Error("Opus audio encoding is unavailable in this browser");
    const context = new OfflineAudioContext(
      2,
      Math.ceil(wallDuration * 48000),
      48000,
    );
    const source = context.createBufferSource();
    source.buffer = await context.decodeAudioData(options.audio.slice(0));
    source.playbackRate.value = options.audioIsMix ? 1 : rate;
    const gain = context.createGain();
    const volume = options.volume ?? 1;
    gain.gain.value = volume;
    const fade = options.audioIsMix ? undefined : options.fade;
    if (fade) {
      const at = (ms: number) => Math.min(wallDuration, Math.max(0, ms / 1000));
      gain.gain.setValueAtTime(0, 0);
      gain.gain.setValueAtTime(0, at(fade.inDelayMs));
      gain.gain.linearRampToValueAtTime(volume, at(fade.inDelayMs + fade.inMs));
      gain.gain.setValueAtTime(volume, Math.max(at(fade.inDelayMs + fade.inMs), wallDuration - fade.outMs / 1000));
      gain.gain.linearRampToValueAtTime(0, wallDuration);
    }
    source.connect(gain).connect(context.destination);
    // A negative start is a lead-in: the song begins that much (wall time) later.
    const startMs = options.audioIsMix ? 0 : (options.startMs ?? 0);
    source.start(Math.max(0, -startMs / rate / 1000), Math.max(0, startMs) / 1000);
    audio = await context.startRendering();
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "V_VP9", width, height, frameRate: fps },
    ...(audio
      ? {
          audio: {
            codec: "A_OPUS" as const,
            numberOfChannels: 2,
            sampleRate: 48000,
          },
        }
      : {}),
    firstTimestampBehavior: "offset",
  });
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  // flush() is an end-of-stream barrier; using it for backpressure repeatedly
  // drains the encoder's lookahead/workers. Wait only until the queue has room.
  const capacity = async (encoder: VideoEncoder | AudioEncoder, limit: number) => {
    while (encoder.encodeQueueSize > limit && !failure) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const done = () => {
        encoder.removeEventListener("dequeue", done);
        wake = undefined;
        resolve();
      };
      wake = done;
      encoder.addEventListener("dequeue", done, { once: true });
      await promise;
    }
    if (failure) throw failure;
  };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error;
      wake?.();
    },
  });
  let audioEncoder: AudioEncoder | undefined;
  try {
    encoder.configure(config);
    const frameCount = Math.ceil(wallDuration * fps);
    for (let i = 0; i < frameCount; i++) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const canvas = await render(
        (options.startMs ?? 0) + ((i * 1000) / fps) * rate,
      );
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration:
          Math.round(((i + 1) * 1e6) / fps) - Math.round((i * 1e6) / fps),
      });
      try {
        encoder.encode(frame, {
          keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0,
        });
      } finally {
        frame.close();
      }
      if (encoder.encodeQueueSize > 8) await capacity(encoder, 8);
      options.progress?.(((i + 1) / frameCount) * (audio ? 0.9 : 1));
    }
    await encoder.flush();
    if (audio) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (error) => {
          failure = error;
          wake?.();
        },
      });
      audioEncoder.configure({
        codec: "opus",
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      for (let start = 0; start < audio.length; start += 960) {
        signal?.throwIfAborted();
        if (failure) throw failure;
        const length = Math.min(960, audio.length - start),
          samples = new Float32Array(length * 2);
        samples.set(audio.getChannelData(0).subarray(start, start + length));
        samples.set(
          audio.getChannelData(1).subarray(start, start + length),
          length,
        );
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: 48000,
          numberOfFrames: length,
          numberOfChannels: 2,
          timestamp: Math.round((start * 1e6) / 48000),
          data: samples,
        });
        try {
          audioEncoder.encode(data);
        } finally {
          data.close();
        }
        if (audioEncoder.encodeQueueSize > 16) await capacity(audioEncoder, 16);
      }
      await audioEncoder.flush();
    }
    if (failure) throw failure;
    muxer.finalize();
    options.progress?.(1);
    return new Blob([muxer.target.buffer], { type: "video/webm" });
  } finally {
    if (encoder.state !== "closed") encoder.close();
    if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
  }
}
export function assertCompatible(
  replays: readonly { rate: number; beatmapHash: string; mapset?: string }[],
): void {
  if (!replays.length) throw new Error("Add a replay first");
  const first = replays[0];
  for (const replay of replays.slice(1)) {
    if (replay.rate !== first.rate)
      throw new Error("All replays must use the same playback rate");
    if (
      replay.beatmapHash !== first.beatmapHash &&
      (!first.mapset || replay.mapset !== first.mapset)
    )
      throw new Error("All replays must belong to the same beatmap set");
  }
}
