import { afterAll, beforeAll, expect, test } from "bun:test";
import { ClientSkin, SKIN_POINTERS, type SkinState } from "../src/index";
import type { Fetcher } from "../src/host";

/*
 * Bun has neither OffscreenCanvas nor createImageBitmap. Built-in looks are
 * drawn into a context that accepts every call, and decoded skin files become
 * fake bitmaps that record whether they were released.
 */
const closed = new Set<string>();
beforeAll(() => {
  const context: unknown = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "measureText" ? () => ({ width: 10 }) : () => context,
      set: () => true,
    },
  );
  globalThis.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return context;
    }
    transferToImageBitmap() {
      return { width: this.width, height: this.height, close() {} };
    }
  } as unknown as typeof OffscreenCanvas;
  globalThis.createImageBitmap = (async (blob: Blob) => {
    const name = await blob.text();
    return { width: 64, height: 64, close: () => closed.add(name) };
  }) as unknown as typeof createImageBitmap;
});

/** Stand-in vosu: the skin report and files of whichever skin is current. */
const skins: Record<string, Record<string, string>> = {
  Ralsei: {
    "skin.ini": "[General]\nName: Ralsei\n",
    "hitcircle.png": "ralsei",
  },
  Staircase: {
    "skin.ini": "[General]\nName: Staircase\n",
    "hitcircle.png": "staircase",
  },
  Keys: {
    "skin.ini":
      "[General]\nName: Keys\nVersion: 2.7\n[Mania]\nKeys: 4\nNoteImage0L: four/body\n[Mania]\nKeys: 7\nNoteImage0L: seven/body\n",
    "hitcircle.png": "keys-circle",
    "four/body.png": "four-body",
    "seven/body.png": "seven-body",
    "mania-note1.png": "shared-note",
  },
};
/** Skin file paths requested, in order. */
const fileRequests: string[] = [];
let report: Record<string, unknown> = {},
  reports = 0,
  /** While set, skin files are held until it resolves; `fileRequested` fires on the first. */
  held: { release: Promise<void>; requested: () => void } | undefined;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/files/skin/") {
      reports++;
      return Response.json(report);
    }
    if (held) {
      held.requested();
      await held.release;
    }
    fileRequests.push(path.slice(12));
    const body = skins[String(report.name)]?.[path.slice(12).toLowerCase()];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body);
  },
});
afterAll(() => server.stop(true));
const host: Fetcher = (url, init) => fetch(new URL(url, server.url), init);

function controller(maniaKeys?: number[]) {
  const seen: SkinState[] = [];
  const skin = new ClientSkin({
    fetch: host,
    onChange: (s) => seen.push(s),
    maniaKeys,
  });
  return { skin, seen, last: () => seen.at(-1)! };
}

test("the client's skin loads, and reloads only when the game reports a change", async () => {
  report = {
    client: "lazer",
    name: "Ralsei",
    files: true,
    builtin: null,
    base: "legacy",
  };
  const { skin, last } = controller();
  await skin.useClient();
  expect(last()).toMatchObject({
    choice: "client",
    label: "Ralsei",
    source: "lazer · current skin · 2 files",
    message: "",
    busy: false,
  });
  expect(last().skin.assets.has("hitcircle")).toBe(true);
  // Missing elements come from the classic look.
  expect(last().skin.assets.has("approachcircle")).toBe(true);
  const ralsei = last().skin;

  // Same client and folder: nothing to do.
  reports = 0;
  await skin.gameChanged(null, null);
  expect(reports).toBe(0);

  // The user switches skins in the client: the folder pointer changes.
  report = { ...report, name: "Staircase" };
  await skin.gameChanged("lazer", "Staircase");
  expect(reports).toBe(1);
  expect(last().label).toBe("Staircase");
  expect(last().skin).not.toBe(ralsei);
  // The replaced skin's bitmaps were released after the swap.
  expect(closed.has("ralsei")).toBe(true);

  // A reconnect with an unchanged report keeps the loaded skin.
  const before = last().skin;
  await skin.useClient({ force: false });
  expect(last().skin).toBe(before);
  expect(SKIN_POINTERS).toEqual(["/client", "/folders/skin"]);
});

test("built-in lazer skins and missing clients fall back with a reason", async () => {
  const { skin, last } = controller();
  report = {
    client: "lazer",
    name: null,
    files: false,
    builtin: "triangles",
    base: null,
  };
  await skin.useClient();
  expect(last()).toMatchObject({
    label: "Triangles",
    source: "lazer · built-in skin",
    message: "",
  });
  const triangles = last().skin;
  report = {
    client: null,
    name: null,
    files: false,
    builtin: null,
    base: null,
  };
  await skin.useClient();
  expect(last()).toMatchObject({
    label: "Classic",
    source: "fallback look",
    tone: "notice",
    message: "No osu! client is connected; showing the classic look.",
  });
  // Built-in looks are drawn once.
  report = {
    client: "lazer",
    name: null,
    files: false,
    builtin: "triangles",
    base: null,
  };
  await skin.useClient();
  expect(last().skin).toBe(triangles);
});

test("a chosen built-in look is not replaced by game changes", async () => {
  report = {
    client: "lazer",
    name: "Ralsei",
    files: true,
    builtin: null,
    base: "legacy",
  };
  const { skin, last } = controller();
  skin.useBuiltin("argon");
  expect(last()).toMatchObject({ choice: "argon", label: "Argon" });
  reports = 0;
  await skin.gameChanged("lazer", "Ralsei");
  expect(reports).toBe(0);
  expect(last().choice).toBe("argon");
});

test("a later choice wins over a load still in progress", async () => {
  report = {
    client: "lazer",
    name: "Ralsei",
    files: true,
    builtin: null,
    base: "legacy",
  };
  const { skin, last } = controller();
  const pending = skin.useClient();
  skin.useBuiltin("legacy");
  await pending;
  expect(last()).toMatchObject({
    choice: "legacy",
    label: "Classic",
    busy: false,
  });
});

test("a reload that overlaps the first load still installs the skin", async () => {
  // Startup: the first frame's reload arrives while the explicit load is still
  // fetching files. The reload wins and must not mistake the unfinished load
  // for a skin already shown.
  report = {
    client: "stable",
    name: "Ralsei",
    files: true,
    builtin: null,
    base: null,
  };
  const { skin, last } = controller();
  const release = Promise.withResolvers<void>(),
    requested = Promise.withResolvers<void>();
  held = { release: release.promise, requested: requested.resolve };
  const first = skin.useClient();
  await requested.promise;
  held = undefined;
  const second = skin.gameChanged("stable", "Ralsei");
  release.resolve();
  await Promise.all([first, second]);
  expect(last()).toMatchObject({
    choice: "client",
    label: "Ralsei",
    busy: false,
  });
  expect(last().skin.assets.has("hitcircle")).toBe(true);
});

test("mania images load per key count, sharing and releasing bitmaps", async () => {
  report = {
    client: "lazer",
    name: "Keys",
    files: true,
    builtin: null,
    base: "legacy",
  };
  const { skin, last } = controller([]);
  closed.clear();
  fileRequests.length = 0;
  await skin.useClient();
  const names = (s: SkinState) =>
    ["four/body", "seven/body", "mania-note1", "hitcircle"].filter((n) =>
      s.skin.assets.has(n),
    );
  // No stage yet: only general elements (and the built-in fallback's mania look).
  expect(fileRequests.some((p) => p.startsWith("four/"))).toBe(false);
  expect(last().skin.assets.has("four/body")).toBe(false);
  expect(skin.hasManiaKeys([4])).toBe(false);
  const circle = last().skin.assets.get("hitcircle");
  // Asking every frame while the set loads starts one load.
  await Promise.all([skin.useManiaKeys([4]), skin.useManiaKeys([4])]);
  expect(fileRequests.filter((p) => p === "four/body.png")).toHaveLength(1);
  expect(names(last())).toEqual(["four/body", "mania-note1", "hitcircle"]);
  expect(skin.hasManiaKeys([4])).toBe(true);
  const note = last().skin.assets.get("mania-note1");
  // 4K -> 7K: the 4K body is released, shared images are kept as they are.
  await skin.useManiaKeys([7]);
  expect(names(last())).toEqual(["seven/body", "mania-note1", "hitcircle"]);
  expect(last().skin.assets.get("hitcircle")).toBe(circle);
  expect(last().skin.assets.get("mania-note1")).toBe(note);
  expect([...closed]).toEqual(["four-body"]);
  expect(fileRequests.filter((p) => p === "hitcircle.png")).toHaveLength(1);
  // Change detection still works, and a reload keeps the current key count.
  await skin.gameChanged("lazer", "Keys");
  fileRequests.length = 0;
  await skin.gameChanged("lazer", "Keys");
  expect(fileRequests).toEqual([]);
  await skin.useClient();
  expect(names(last())).toEqual(["seven/body", "mania-note1", "hitcircle"]);
  expect(fileRequests).not.toContain("four/body.png");
  // Leaving mania releases every mania image of the skin (the built-in
  // fallback still lends its classic mania look).
  closed.clear();
  await skin.useManiaKeys([]);
  expect(last().skin.assets.has("seven/body")).toBe(false);
  expect([...closed].sort()).toEqual(["seven-body", "shared-note"]);
  skin.destroy();
});
