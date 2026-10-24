import { afterEach, expect, test } from "bun:test";
import { exportWebM } from "../src";

const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});
function codecs(fail = false) {
  const counters = { frames: 0, closedFrames: 0, flushes: 0, peak: 0, drains: 0 };
  class Encoder extends EventTarget {
    static async isConfigSupported(config: VideoEncoderConfig) { return { supported: true, config }; }
    encodeQueueSize = 0;
    state = "unconfigured";
    constructor(private callbacks: { error(error: Error): void }) { super(); }
    configure() { this.state = "configured"; }
    encode() {
      counters.frames++;
      this.encodeQueueSize++;
      counters.peak = Math.max(counters.peak, this.encodeQueueSize);
      if (this.encodeQueueSize === 9) queueMicrotask(() => {
        if (fail) { this.state = "closed"; this.callbacks.error(new Error("encoding failed")); }
        else { this.encodeQueueSize = 4; counters.drains++; this.dispatchEvent(new Event("dequeue")); }
      });
    }
    async flush() { counters.flushes++; this.encodeQueueSize = 0; }
    close() { this.state = "closed"; }
  }
  class Frame { close() { counters.closedFrames++; } }
  install("VideoEncoder", Encoder);
  install("VideoFrame", Frame);
  return counters;
}
const options = () => ({ fps: 60, width: 1920, height: 1080, durationMs: 1000, render: () => ({} as HTMLCanvasElement) });
test("backpressure keeps the encoder fed without flushing each batch", async () => {
  const counters = codecs();
  const blob = await exportWebM(options());
  expect(blob.type).toBe("video/webm");
  expect(counters.frames).toBe(60);
  expect(counters.closedFrames).toBe(60);
  expect(counters.peak).toBe(9);
  expect(counters.drains).toBeGreaterThan(0);
  expect(counters.flushes).toBe(1);
});
test("an asynchronous encoder failure wakes a backpressure waiter", async () => {
  const counters = codecs(true);
  await expect(exportWebM(options())).rejects.toThrow("encoding failed");
  expect(counters.frames).toBe(9);
  expect(counters.closedFrames).toBe(9);
  expect(counters.flushes).toBe(0);
});
