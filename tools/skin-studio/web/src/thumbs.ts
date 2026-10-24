// Small decoded thumbnails for the Explorer list, made in a worker
// (thumbs.worker.ts) and kept as ImageBitmaps, so scrolling a skin with
// thousands of files decodes each image once and never on the main thread.

export interface Thumb {
  bitmap: ImageBitmap;
  /** The image's own size. */
  width: number;
  height: number;
}
type Done = (thumb: Thumb | null) => void;
type Reply =
  | { id: number; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; error: string }
  | { id: number; dropped: true };

export class Thumbnails {
  #worker?: Worker;
  #size: number;
  #limit: number;
  /** By absolute URL; Map order doubles as least-recently-used order. */
  #cache = new Map<string, Thumb>();
  #failed = new Set<string>();
  #pending = new Map<string, { id: number; done: Set<Done> }>();
  #urls = new Map<number, string>();
  #next = 1;

  /** `size`: longest thumbnail side in device pixels; `limit`: cached bitmaps. */
  constructor(size = 48, limit = 2500) {
    this.#size = size;
    this.#limit = limit;
  }

  #start() {
    if (this.#worker) return this.#worker;
    this.#worker = new Worker(new URL("./thumbs.worker.ts", import.meta.url), {
      type: "module",
    });
    this.#worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      const url = this.#urls.get(data.id);
      this.#urls.delete(data.id);
      const pending = url ? this.#pending.get(url) : undefined;
      if (!url || !pending || pending.id !== data.id) {
        if ("bitmap" in data) data.bitmap.close();
        return;
      }
      this.#pending.delete(url);
      if ("dropped" in data) return;
      let thumb: Thumb | null = null;
      if ("bitmap" in data) {
        thumb = { bitmap: data.bitmap, width: data.width, height: data.height };
        this.#cache.set(url, thumb);
        for (const [old, t] of this.#cache) {
          if (this.#cache.size <= this.#limit) break;
          t.bitmap.close();
          this.#cache.delete(old);
        }
      } else this.#failed.add(url);
      for (const done of pending.done) done(thumb);
    };
    return this.#worker;
  }

  /** A cached thumbnail (marking it recently used). */
  get(url: string): Thumb | undefined {
    const thumb = this.#cache.get(url);
    if (thumb) {
      this.#cache.delete(url);
      this.#cache.set(url, thumb);
    }
    return thumb;
  }

  /** Calls `done` with the thumbnail now or once made (null when unreadable). */
  request(url: string, done: Done) {
    const cached = this.get(url);
    if (cached || this.#failed.has(url)) return done(cached ?? null);
    const pending = this.#pending.get(url);
    if (pending) {
      pending.done.add(done);
      return;
    }
    const id = this.#next++;
    this.#pending.set(url, { id, done: new Set([done]) });
    this.#urls.set(id, url);
    this.#start().postMessage({
      type: "job",
      job: { id, url, size: this.#size },
    });
  }

  /** Only these URLs are still wanted; the worker skips the rest. */
  want(urls: Iterable<string>) {
    if (!this.#worker) return;
    const ids: number[] = [];
    for (const url of urls) {
      const pending = this.#pending.get(url);
      if (pending) ids.push(pending.id);
    }
    this.#worker.postMessage({ type: "want", ids });
  }
}

/** Draws a thumbnail into a canvas sized to it. */
export function thumbCanvas(thumb: Thumb | undefined): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  if (thumb) paint(canvas, thumb);
  else canvas.width = canvas.height = 0;
  return canvas;
}
export function paint(canvas: HTMLCanvasElement, thumb: Thumb) {
  canvas.width = thumb.bitmap.width;
  canvas.height = thumb.bitmap.height;
  canvas.getContext("2d")?.drawImage(thumb.bitmap, 0, 0);
}
