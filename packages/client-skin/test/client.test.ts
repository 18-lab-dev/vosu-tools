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
};
let report: Record<string, unknown> = {},
  reports = 0;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/files/skin/") {
      reports++;
      return Response.json(report);
    }
    const body = skins[String(report.name)]?.[path.slice(12).toLowerCase()];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body);
  },
});
afterAll(() => server.stop(true));
const host: Fetcher = (url, init) => fetch(new URL(url, server.url), init);

function controller() {
  const seen: SkinState[] = [];
  const skin = new ClientSkin({ fetch: host, onChange: (s) => seen.push(s) });
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
