import { afterAll, expect, test } from "bun:test";
import { loadSkin } from "@vosu-tools/render-core";
import { hostSkinFiles, readCurrentSkin } from "../src/skin-source";

/**
 * Stand-in for vosu's overlay origin: `GET /files/skin/` reports the current
 * skin and `/files/skin/<path>` serves that skin's files by filename,
 * case-insensitively and with subfolders, like vosu does for lazer's realm
 * file store.
 */
const skinFiles: Record<string, string> = {
  "skin.ini":
    "[General]\nName: Stand-in\nVersion: 2.7\n[Mania]\nKeys: 4\nKeyImage0: Mania\\Key Left\n",
  "hitcircle.png": "hitcircle",
  "approachcircle@2x.png": "approach",
  "mania/key left.png": "key",
};
let report: unknown = null,
  routeStatus = 200;
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/files/skin/")
      return routeStatus === 200
        ? Response.json(report)
        : new Response("not found", { status: routeStatus });
    if (!path.startsWith("/files/skin/"))
      return new Response("not found", { status: 404 });
    const name = path
      .slice("/files/skin/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/")
      .toLowerCase();
    const body = Object.hasOwn(skinFiles, name) ? skinFiles[name] : undefined;
    return body === undefined
      ? Response.json({ error: "not found" }, { status: 404 })
      : new Response(body, { headers: { "content-type": "image/png" } });
  },
});
afterAll(() => server.stop(true));
const host: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(new URL(String(input), server.url), init),
  { preconnect: fetch.preconnect },
);

test("lazer skin with files loads by filename from the host", async () => {
  report = {
    client: "lazer",
    name: "Stand-in",
    files: true,
    builtin: null,
    base: "legacy",
  };
  routeStatus = 200;
  const current = await readCurrentSkin(host);
  expect(current).toEqual({
    kind: "files",
    name: "Stand-in",
    fallback: "legacy",
    info: {
      client: "lazer",
      name: "Stand-in",
      files: true,
      builtin: null,
      base: "legacy",
    },
  });
  // Bun has no createImageBitmap; record which blobs became bitmaps.
  const decoded: string[] = [];
  globalThis.createImageBitmap = (async (blob: Blob) => {
    decoded.push(await blob.text());
    return { width: 64, height: 64, close() {} };
  }) as unknown as typeof createImageBitmap;
  requests.length = 0;
  const files = hostSkinFiles(host),
    skin = await loadSkin(files.resolve, "Stand-in");
  expect(skin.sections.get("General")?.[0]?.Name).toBe("Stand-in");
  expect(skin.assets.has("hitcircle")).toBe(true);
  expect(skin.pixelScale?.get("approachcircle")).toBe(2);
  expect(skin.assets.has("Mania/Key Left")).toBe(true);
  expect(decoded).toContain("key");
  expect(files.served).toBe(4);
  expect(files.failures).toBe(0);
  // Subfolders keep their separator; other characters are percent-encoded.
  expect(requests).toContain("/files/skin/Mania/Key%20Left.png");
  expect(requests).toContain("/files/skin/skin.ini");
});

test("lazer built-in skins use the preview's drawing of that skin", async () => {
  report = {
    client: "lazer",
    name: null,
    files: false,
    builtin: "argon-pro",
    base: "argon-pro",
  };
  const current = await readCurrentSkin(host);
  expect(current.kind === "builtin" && current.look).toBe("argon-pro");
  expect(current.kind === "builtin" && current.name).toBe("Argon Pro");
  report = {
    client: "lazer",
    name: "osu! (classic)",
    files: false,
    builtin: "legacy",
  };
  const classic = await readCurrentSkin(host);
  expect(classic.kind === "builtin" && classic.look).toBe("legacy");
  report = { client: "lazer", name: null, files: false, builtin: "retro" };
  const retro = await readCurrentSkin(host);
  expect(retro.kind === "builtin" && retro.look).toBe("legacy");
  expect(retro.kind === "builtin" && retro.message).toContain("classic look");
});

test("Argon- and Triangles-based user skins keep their family's look", async () => {
  report = {
    client: "lazer",
    name: "Mine",
    files: true,
    builtin: null,
    base: "argon",
  };
  expect(await readCurrentSkin(host)).toMatchObject({
    kind: "builtin",
    look: "argon",
    name: "Mine",
    coloursFromFiles: true,
  });
  report = {
    client: "lazer",
    name: "Old",
    files: true,
    builtin: null,
    base: "triangles",
  };
  expect(await readCurrentSkin(host)).toMatchObject({
    kind: "builtin",
    look: "triangles",
  });
});

test("skins whose files vosu cannot serve say so", async () => {
  report = { client: "lazer", name: "Broken", files: false, builtin: null };
  const current = await readCurrentSkin(host);
  expect(current.kind === "unavailable" && current.message).toContain(
    "vosu reports that the files of “Broken” are unavailable",
  );
});

test("no connected client, older vosu, and unreachable hosts are explained", async () => {
  report = { client: null, name: null, files: false, builtin: null };
  const none = await readCurrentSkin(host);
  expect(none.kind === "unavailable" && none.message).toContain(
    "No osu! client is connected",
  );
  routeStatus = 404;
  const old = await readCurrentSkin(host);
  expect(old.kind === "unavailable" && old.message).toContain(
    "does not report the current skin",
  );
  routeStatus = 500;
  const broken = await readCurrentSkin(host);
  expect(broken.kind === "unavailable" && broken.message).toContain(
    "does not report the current skin",
  );
  routeStatus = 200;
  const offline = await readCurrentSkin(async () => {
    throw new TypeError("fetch failed");
  });
  expect(offline.kind === "unavailable" && offline.message).toContain(
    "Could not reach vosu",
  );
});
test("host errors other than 404 are counted as failures", async () => {
  const files = hostSkinFiles(
    async () => new Response("boom", { status: 500 }),
  );
  expect(await files.resolve("hitcircle.png")).toBeNull();
  expect(files.failures).toBe(1);
  expect(files.served).toBe(0);
});
