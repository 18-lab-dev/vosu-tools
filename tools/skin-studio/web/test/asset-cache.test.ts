import { expect, test } from "bun:test";
import { AssetCache } from "../src/asset-cache";

test("a source read afresh serves its new image bytes, not the cached ones", async () => {
  let bytes = "old";
  const requests: RequestInit[] = [];
  const cache = new AssetCache(
    (skin, file) => `asset?skin=${skin}&name=${file}`,
    async (_url, init) => {
      requests.push(init);
      return new Response(bytes);
    },
  );
  expect(await (await cache.get("A", "note.png"))!.text()).toBe("old");
  bytes = "new";
  // Without a refresh the preview keeps one request per file.
  expect(await (await cache.get("A", "note.png"))!.text()).toBe("old");
  expect(requests.length).toBe(1);
  const epoch = cache.epoch;
  cache.invalidate("A");
  expect(cache.epoch).toBe(epoch + 1);
  expect(await (await cache.get("A", "note.png"))!.text()).toBe("new");
  expect(requests.length).toBe(2);
  // The browser's 30 s HTTP cache must not hand back the old bytes either.
  expect(requests[1].cache).toBe("no-cache");
});

test("invalidation is per source, and a failed read becomes readable after a refresh", async () => {
  let ok = false;
  let fetched = 0;
  const cache = new AssetCache(
    (skin, file) => `${skin}/${file}`,
    async (url) => {
      fetched++;
      return url.startsWith("A/") && !ok ? new Response("", { status: 404 }) : new Response(url);
    },
  );
  expect(await cache.get("A", "x.png")).toBeNull();
  await cache.get("B", "x.png");
  ok = true;
  cache.invalidate("A");
  expect(await (await cache.get("A", "x.png"))!.text()).toBe("A/x.png");
  await cache.get("B", "x.png");
  expect(fetched).toBe(3);
});
