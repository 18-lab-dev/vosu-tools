// Skin files fetched for previews, shared by every preview load. A source
// read afresh (a fresh snapshot, an apply, a restore) may have new bytes
// under the same names, so `invalidate` drops its entries, bumps `epoch`
// (previews fold it into their source version so they reload) and makes
// later requests for that source bypass the browser's HTTP cache.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class AssetCache {
  #blobs = new Map<string, Promise<Blob | null>>();
  #refreshed = new Set<string>();
  /** Bumped by every invalidation: part of each preview source's version. */
  epoch = 0;

  constructor(
    readonly url: (skin: string, file: string) => string,
    readonly fetcher: Fetcher = (url, init) => fetch(url, init),
    readonly limit = 4000,
  ) {}

  get(skin: string, file: string): Promise<Blob | null> {
    const key = `${skin}\n${file}`;
    let pending = this.#blobs.get(key);
    if (!pending) {
      if (this.#blobs.size > this.limit) this.#blobs.clear();
      pending = this.fetcher(this.url(skin, file), {
        credentials: "omit",
        cache: this.#refreshed.has(skin) ? "no-cache" : "default",
      }).then(
        (r) => (r.ok ? r.blob() : null),
        () => null,
      );
      this.#blobs.set(key, pending);
    }
    return pending;
  }

  /** Forgets `skin`'s files (failed reads included) so they are read again. */
  invalidate(skin: string) {
    const prefix = `${skin}\n`;
    for (const key of this.#blobs.keys()) if (key.startsWith(prefix)) this.#blobs.delete(key);
    this.#refreshed.add(skin);
    this.epoch++;
  }
}
