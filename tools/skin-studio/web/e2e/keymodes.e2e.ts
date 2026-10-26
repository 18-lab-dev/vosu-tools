#!/usr/bin/env bun
// End-to-end check of the Keymodes screen on real skins, in an isolated vosu
// (`vosu --tool tools/skin-studio`): private network namespace, a /dev without
// GPU nodes (Chromium draws with SwiftShader), private /tmp, hidden
// /run/user and osu! folders, a temporary HOME with every XDG directory.
//
//   bun tools/skin-studio/web/e2e/keymodes.e2e.ts --vosu <vosu binary> \
//     --playwright <playwright/index.mjs> --skins <folder with two skins> \
//     --keys "Orchids Garden" --notes "Arturia (sxlvia mania+taiko)" --out <evidence dir>
//
// Build first: `cargo build -p vosu-skin-studio` and `bun run build` in
// tools/skin-studio/web. The skins are copied; the originals are only read.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "../../../..");
const { values: opt } = parseArgs({
  options: {
    vosu: { type: "string" },
    playwright: { type: "string" },
    skins: { type: "string" },
    keys: { type: "string" },
    notes: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["vosu", "playwright", "skins", "keys", "notes", "out"] as const)
  if (!opt[name]) throw new Error(`--${name} is required`);
const out = resolve(opt.out!);
mkdirSync(out, { recursive: true });

if (process.env.KM_E2E_SANDBOX !== "1") {
  const osuWine = join(homedir(), ".local/share/osu-wine");
  const run = spawnSync(
    "bwrap",
    [
      "--dev-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run/user",
      "--tmpfs", osuWine,
      "--unshare-net", "--unshare-ipc", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
      "--setenv", "KM_E2E_SANDBOX", "1",
      process.execPath, ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

// ── Isolated vosu ─────────────────────────────────────────────────────────
const LAB = mkdtempSync(join(tmpdir(), "km-e2e-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
for (const name of [opt.keys!, opt.notes!]) cpSync(join(opt.skins!, name), join(SKINS, name), { recursive: true });
spawnSync("chmod", ["-R", "a-w", SKINS]);
const SERVER = 25950, DASHBOARD = 25951;
mkdirSync(join(env.XDG_CONFIG_HOME, "vosu"), { recursive: true });
writeFileSync(join(env.XDG_CONFIG_HOME, "vosu/vosu.toml"), [
  "ENABLE_AUTOUPDATE = false", "OPEN_DASHBOARD_ON_STARTUP = false", "START_AT_LOGIN = false",
  'SERVER_IP = "127.0.0.1"', `SERVER_PORT = ${SERVER}`, 'DASHBOARD_IP = "127.0.0.1"', `DASHBOARD_PORT = ${DASHBOARD}`,
  `STATIC_FOLDER_PATH = "${join(LAB, "static")}"`, "",
].join("\n"));
mkdirSync(join(LAB, "static"));
const daemonLog: string[] = [];
const daemon = spawn(resolve(opt.vosu!), ["--update=false", "--tool", join(ROOT, "tools/skin-studio")], { cwd: LAB, env, stdio: ["ignore", "pipe", "pipe"] });
daemon.stdout.on("data", (c) => daemonLog.push(String(c)));
daemon.stderr.on("data", (c) => daemonLog.push(String(c)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(check: () => Promise<T> | T, what: string, timeout = 60000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(150);
  }
}
const results: { check: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const dash = `http://127.0.0.1:${DASHBOARD}`;
let csrf = "";
async function api(path: string, body?: unknown) {
  const response = await fetch(dash + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: dash, "X-Vosu-CSRF": csrf, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
}

const { chromium } = await import(resolve(opt.playwright!));
let browser: any;
try {
  csrf = await until(async () => {
    const page = await (await fetch(`${dash}/tools`)).text();
    return JSON.parse(/<script[^>]*id="vosu-context"[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]).csrf;
  }, "dashboard");
  await api("/api/tools/skin-studio/settings", [
    { uniqueID: "stable_skins_dir", value: SKINS },
    { uniqueID: "lazer_skins", value: false },
    { uniqueID: "start_ruleset", value: "mania" },
  ]);
  const launch = async (theme: string) =>
    (await until(() => api("/api/tools/skin-studio/launch", { theme }), "launch")).url as string;

  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  // Dialogs are accepted unless a step says otherwise; the last text is kept.
  let answer = true,
    lastDialog = "";
  page.on("dialog", (d: { message(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
    lastDialog = d.message();
    return answer ? d.accept() : d.dismiss();
  });
  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");
  const shot = (name: string, opts: object = {}) => page.screenshot({ path: join(out, `${name}.png`), ...opts });
  const slot = (key: string) => page.locator(`#km-grid [data-key="${key}"], #km-shared-grid [data-key="${key}"]`).first();
  const label = (key: string) => slot(key).getAttribute("aria-label");
  const tile = (name: string) =>
    page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: new RegExp(`^${name.replace(/[()]/g, "\\$&")}$`) }) }).first();
  const settle = async () => {
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !document.querySelector("#km-images .v-empty")?.textContent?.startsWith("Reading"));
  };
  const source = async (name: string) => {
    await page.selectOption("#km-source", { label: name });
    await settle();
  };
  const waitLabel = (key: string, part: string) =>
    until(async () => (await label(key))?.includes(part), `${key} shows ${part}`, 30000);
  const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:recipe") ?? "{}").keymodes ?? {});

  // ── Base: the notes skin; before shots of its 4K and 7K ──────────────────
  await page.locator("#skins .skin", { hasText: opt.notes! }).click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await page.waitForSelector("#km-counts .km-count");
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^.*${keys}K`) }).first().click();
    await page.waitForSelector(`#km-grid .km-colhead:nth-of-type(${keys})`);
    await page.waitForTimeout(1500);
  };
  await pick(4);
  await page.waitForTimeout(2500);
  await shot("4k-before");
  check("4K rows from the base's block", (await page.locator("#km-grid .km-slot").count()) === 4 * 6);
  await pick(7);
  await page.waitForTimeout(2500);
  await shot("7k-before");
  check("7K rows from the base's block", (await page.locator("#km-grid .km-slot").count()) === 7 * 6);
  check("7K note resolves from skin.ini", (await label("NoteImage1"))?.includes("NoteImage1: mania/circles-7k/mauve") ?? false, await label("NoteImage1") ?? "");

  const copyFrom = async (skin: string, keys: number) => {
    await page.click(".km-copy-menu > summary");
    await page.selectOption("#km-copy-skin", { label: skin });
    await until(() => page.locator(`#km-copy-keys option[value="${keys}"]`).count(), "copy key counts");
    await page.selectOption("#km-copy-keys", String(keys));
    await page.click("#km-copy-go");
    await page.click(".km-copy-menu > summary");
  };
  // ── 4K after: copied from the keys skin ──────────────────────────────────
  await pick(4);
  await copyFrom(`${opt.keys} · Stable`, 4);
  await waitLabel("KeyImage0", "skin-studio/4k/");
  await page.waitForTimeout(2500);
  await shot("4k-after");
  check("Copy key count from another skin's 4K", true, await label("KeyImage0") ?? "");

  // ── 7K: copy from this mix's 4K, keys from one skin, notes from the other ─
  await pick(7);
  await copyFrom("This mix", 4);
  await waitLabel("KeyImage6", "skin-studio/7k/");
  check("Copy key count from 4K remaps 4 → 7 columns", true, await label("KeyImage3") ?? "");
  await source(opt.keys!);
  await slot("KeyImage0").click();
  await tile("mania-key1").click();
  await waitLabel("KeyImage0", "skin-studio/7k/mania-key1");
  check("Click assign (slot, then picker image)", true);
  await tile("mania-key2").dragTo(slot("KeyImage1"));
  await waitLabel("KeyImage1", "skin-studio/7k/mania-key2");
  check("Picker drag onto a slot", true);
  for (const [key, name] of [["KeyImage0D", "mania-key1D"], ["KeyImage1D", "mania-key2D"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `skin-studio/7k/${name}`);
  }
  // ── Explorer: "Use as <slot>" for the selected Keymodes slot, and a drag ──
  await slot("KeyImage3").click();
  await page.click("#tab-explorer");
  await page.selectOption("#x-skin", { label: opt.keys! });
  const xrow = (name: string) =>
    page.locator("#x-list .x-row").filter({ has: page.locator(".x-name", { hasText: new RegExp(`^${name}$`, "i") }) }).first();
  await page.fill("#x-filter", "mania-keys");
  await xrow("mania-keyS").click();
  const use = await page.locator("#x-keymodes").textContent();
  await page.click("#x-keymodes");
  await page.waitForSelector("#keymodes-view:not([hidden])");
  await waitLabel("KeyImage3", "skin-studio/7k/mania-keyS");
  check("Explorer: Use as the selected Keymodes slot", use === "Use as 7K column 4 key", use ?? "");
  await page.click("#tab-explorer");
  await page.fill("#x-filter", "mania-keysd");
  await xrow("mania-keySD").waitFor();
  await page.evaluate(async () => {
    const row = [...document.querySelectorAll<HTMLElement>("#x-list .x-row")].find((r) => /^mania-keySD$/i.test(r.querySelector(".x-name")!.textContent!))!;
    const data = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    document.querySelector("#tab-keymodes")!.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true }));
    await new Promise((done) => setTimeout(done, 700));
    const target = document.querySelector('#km-grid [data-key="KeyImage3D"]')!;
    for (const type of ["dragenter", "dragover", "drop"])
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await waitLabel("KeyImage3D", "skin-studio/7k/mania-keySD");
  check("Explorer drag: the Keymodes tab opens on hover, the image drops on a slot", true);
  await source(opt.notes!);
  for (const [key, name] of [["NoteImage0", "mania/circles-7k/left"], ["NoteImage0H", "mania/circles-7k/left"], ["NoteImage3", "mania/circles-7k/cornflower"], ["NoteImage3H", "mania/circles-7k/cornflower"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `skin-studio/7k/${name.split("/").pop()}`);
  }
  await slot("NoteImage0").click();
  await tile("mania/circles-7k/mauve").dragTo(page.locator('#km-columns .km-column[data-col="1"]'));
  await waitLabel("NoteImage1", "skin-studio/7k/mauve");
  check("Picker drag onto a stage column", true);
  for (const [key, name] of [["NoteImage0L", "mania/circles-7k/holdbody-50"], ["NoteImage0T", "mania/circles-7k/holdcap"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `skin-studio/7k/${name.split("/").pop()}`);
    await page.click("#km-all");
    await waitLabel(key.replace("0", "6"), `skin-studio/7k/${name.split("/").pop()}`);
  }
  check("Apply to all columns", true);
  await page.click("#km-pattern");
  await waitLabel("KeyImage2", "skin-studio/7k/mania-key1");
  check("osu! 1/2/S pattern", (await label("KeyImage5"))?.includes("mania-key2") ?? false, await label("KeyImage5") ?? "");

  // ── OS-file drop: one valid PNG, one invalid file ─────────────────────────
  await page.evaluate(async () => {
    // A square test image: its thumbnail must show whole.
    const canvas = new OffscreenCanvas(64, 64);
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#e0405a";
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    const png = new File([await canvas.convertToBlob({ type: "image/png" })], "drop-note.png", { type: "image/png" });
    const bad = new File(["not an image"], "notes.txt", { type: "text/plain" });
    const data = new DataTransfer();
    data.items.add(png);
    data.items.add(bad);
    const target = document.querySelector('#km-grid [data-key="NoteImage6"]')!;
    for (const type of ["dragenter", "dragover", "drop"])
      target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await waitLabel("NoteImage6", "skin-studio/7k/drop-note");
  const error = await page.locator("#km-error").textContent();
  check("OS drop adds the PNG and reports the invalid file inline", !!error?.includes("notes.txt: only PNG and JPEG images") && (await page.locator("#km-error").isVisible()), error ?? "");
  const thumbs = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>("#keymodes-view .km-thumb img")].filter((img) => img.complete && img.naturalWidth).map((img) => {
        const box = img.parentElement!.getBoundingClientRect(), r = img.getBoundingClientRect();
        const fit = getComputedStyle(img).objectFit;
        return { ok: fit === "contain" && r.left >= box.left && r.top >= box.top && r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5, src: img.src.slice(-40), fit };
      }),
    );
  const square = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('#km-grid [data-key="NoteImage6"] .km-thumb img')!;
    const box = img.parentElement!.getBoundingClientRect(), r = img.getBoundingClientRect();
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    // The drawn square (contain): inside the thumbnail, nothing cut.
    const side = img.naturalWidth * scale;
    return { natural: [img.naturalWidth, img.naturalHeight], side, inside: getComputedStyle(img).objectFit === "contain" && r.left >= box.left && r.top >= box.top && r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5 && side <= Math.min(box.width, box.height) };
  });
  check("A square test image's thumbnail is fully visible", square.inside && square.natural[0] === 64, JSON.stringify(square));
  const state = await page.locator("#km-state").textContent();
  check("Status names the dropped file, not the upload folder", state === "Set column 7 note to drop-note.png", state ?? "");
  await shot("7k-drop-error");

  // ── Mirror, undo/redo across it ──────────────────────────────────────────
  await page.click("#km-mirror");
  await waitLabel("NoteImage6", "skin-studio/7k/left");
  check("Mirror: column 7 takes column 1", true);
  await slot("KeyImage0").focus();
  await page.keyboard.press("Control+z");
  await waitLabel("NoteImage6", "skin-studio/7k/drop-note");
  check("Undo restores the dropped image Mirror replaced", true);
  await page.keyboard.press("Control+Shift+z");
  await waitLabel("NoteImage6", "skin-studio/7k/left");
  check("Redo applies Mirror again", true);
  // Keyboard: arrows to NoteImage3H, Delete clears it, undo restores it.
  await slot("NoteImage3").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Delete");
  await until(async () => !(await label("NoteImage3H"))?.includes("cornflower"), "keyboard clear");
  await page.keyboard.press("Control+z");
  await waitLabel("NoteImage3H", "cornflower");
  check("Keyboard: arrows, Delete, Ctrl+Z", true);
  // The dropped image, picked again from the Dropped files source for a stage image.
  await source("Dropped files");
  await slot("StageHint").click();
  // Dropped files show by their file name (no upload folder).
  await page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: /^drop-note\.png$/ }) }).first().click();
  await waitLabel("StageHint", "skin-studio/7k/drop-note");
  check("Dropped files source assigns a stage image", true);
  const hashFree = (await page.locator("#km-state").textContent()) ?? "";
  check("Status after picking a dropped file has no upload hash", hashFree === "Set StageHint to drop-note.png" && !/[0-9a-f]{16}/.test(hashFree), hashFree);
  // ── Dropped files: kept until the user removes unused ones ───────────────
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext("2d")!.fillRect(0, 0, 8, 8);
    const data = new DataTransfer();
    data.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "spare.png", { type: "image/png" }));
    const picker = document.querySelector(".km-picker")!;
    for (const type of ["dragenter", "dragover", "drop"])
      picker.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await until(async () => (await page.locator("#mix-uploads-summary").textContent())?.startsWith("Dropped files: 2"), "two dropped files listed");
  await page.click("#mix-uploads-summary");
  const listed = await page.locator("#mix-uploads-list li").allTextContents();
  check("Mix panel lists dropped files with their use", listed.some((t) => t.includes("drop-note.png") && t.includes("used by this draft")) && listed.some((t) => t.includes("spare.png") && t.includes("unused")), listed.join(" | "));
  answer = false;
  await page.click("#mix-uploads-remove");
  await page.waitForTimeout(800);
  check("Declining the confirmation removes nothing", (await page.locator("#mix-uploads-list li").count()) === 2 && lastDialog.includes("Delete 1 dropped file") && lastDialog.includes("other browsers may still use these"), lastDialog.replace(/\n/g, " "));
  answer = true;
  await page.click("#mix-uploads-remove");
  await until(async () => (await page.locator("#mix-uploads-list li").count()) === 1, "unused upload removed");
  const left = await page.locator("#mix-uploads-list li").allTextContents();
  check("Remove unused deletes only the unused file; the draft's stays", left.length === 1 && left[0].includes("drop-note.png") && (await page.locator("#mix-uploads-remove").isDisabled()), left.join(" | "));
  // ── Colour swatches show the colour, the value on focus ─────────────────
  await page.locator("#km-grid .km-swatch input").first().fill("#ff0000");
  await until(() => page.locator("#km-grid .km-swatch").first().evaluate((s) => (s as HTMLElement).style.getPropertyValue("--c").startsWith("rgb(255 0 0")), "Colour1 swatch red");
  await page.locator("#km-grid .km-swatch input").first().focus();
  const swatch = await page.locator("#km-grid .km-swatch").first().evaluate((s) => ({
    value: s.querySelector(".km-swatch__value")!.textContent ?? "",
    shown: getComputedStyle(s.querySelector(".km-swatch__value")!).opacity,
    image: getComputedStyle(s).backgroundImage.slice(0, 60),
  }));
  check("Colour swatch shows the colour and, on focus, its value", swatch.value.startsWith("255,0,0") && swatch.shown === "1" && swatch.image.includes("255, 0, 0"), JSON.stringify(swatch));

  // ── Hand edit in skin.ini shows on the screen ────────────────────────────
  await page.click("#tab-ini");
  await page.click("#ini-mix");
  await page.waitForSelector("#editor .monaco-editor");
  await page.click("#editor .view-lines");
  await page.keyboard.press("Control+End");
  // 10K: a key count the base has no block for (a later duplicate block is ignored).
  for (const line of ["", "[Mania", "Keys: 10", "ColumnWidth: 44,44,44,44,44,44,44,44,44,44"]) {
    if (line) await page.keyboard.type(line);
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
  }
  await page.click("#tab-keymodes");
  await until(() => page.locator("#km-counts .km-count", { hasText: "10K" }).count(), "10K from the hand edit");
  await pick(10);
  check("Hand edit of skin.ini shows on the screen", (await page.locator("#km-grid .km-num").first().inputValue()) === "44");
  await pick(7);
  await source(opt.notes!);
  await slot("NoteImage2").click();

  // ── Screenshots ────────────────────────────────────────────────────────────
  const scroll = async () =>
    page.evaluate(() => {
      const e = document.scrollingElement!;
      return { h: e.scrollHeight - innerHeight, w: e.scrollWidth - innerWidth };
    });
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t: string) => (document.documentElement.dataset.theme = t), theme);
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(2500);
      await shot(`keymodes-${theme}-${w}x${h}`);
      if (theme === "light") continue;
      const bad = (await thumbs()).filter((t) => !t.ok);
      check(`Thumbnails contained, not cropped, at ${w}x${h}`, !bad.length, JSON.stringify(bad.slice(0, 3)));
      const rows = await page.evaluate(() => {
        const sheet = document.querySelector(".km-sheet")!.getBoundingClientRect();
        const heads = [...document.querySelectorAll<HTMLElement>("#km-grid .km-row:not(.km-row--head):not(.km-row--values) .km-rowhead")];
        return heads.map((el) => {
          const slot = el.nextElementSibling!.getBoundingClientRect();
          return { role: el.textContent, visible: slot.top >= sheet.top - 1 && slot.bottom <= sheet.bottom + 1 };
        });
      });
      check(`All six roles of a column visible at ${w}x${h}`, rows.length === 6 && rows.every((r) => r.visible), JSON.stringify(rows));
      const bar = await page.locator("#keymodes-view > .v-toolbar").evaluate((b) => b.getBoundingClientRect().height);
      check(`Keymodes toolbar on one row at ${w}x${h}`, bar < 60, String(bar));
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  for (const [w, h] of [[2560, 1440], [1920, 1080], [1280, 720], [960, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const s = await scroll();
    check(`No page scroll at ${w}x${h}`, s.h <= 0 && s.w <= 0, JSON.stringify(s));
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(2000);
  await shot("7k-after");
  // Mid-gesture: a picker image dragged over a slot.
  await page.evaluate(() => {
    const tile = document.querySelectorAll<HTMLElement>("#km-images .km-tile")[3];
    const target = document.querySelector('#km-grid [data-key="NoteImage2"]')!;
    const data = new DataTransfer();
    tile.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await shot("picker-drag-mid-gesture");
  await page.evaluate(() => {
    document.querySelector('#km-grid [data-key="NoteImage2"]')!.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
    document.querySelectorAll<HTMLElement>("#km-images .km-tile")[3].dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  });

  // ── Export ───────────────────────────────────────────────────────────────
  await slot("NoteImage2").press("Escape");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2500);
  const mixStage = await page.locator("#km-stage").screenshot({ path: join(out, "stage-mix.png") });
  await page.selectOption("#export-target", "osk");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-run")]);
  const osk = join(out, "mix.osk");
  await download.saveAs(osk);
  const listing = spawnSync("unzip", ["-Z1", osk], { encoding: "utf8" }).stdout.split("\n");
  const ini = spawnSync("unzip", ["-p", osk, "skin.ini"], { encoding: "utf8" }).stdout;
  writeFileSync(join(out, "mix-skin.ini"), ini);
  const block = /\[Mania\]\r?\nKeys: 7\r?\n([\s\S]*?)(\r?\n\r?\n|\r?\n\[|$)/.exec(ini)?.[1] ?? "";
  const keys = Object.fromEntries(block.split(/\r?\n/).map((l) => l.split(/:\s*/)).filter((p) => p.length === 2));
  const want: Record<string, string> = {
    KeyImage0: "skin-studio/7k/mania-key1", KeyImage1: "skin-studio/7k/mania-key2", KeyImage3: "skin-studio/7k/mania-keyS",
    KeyImage5: "skin-studio/7k/mania-key2", NoteImage1: "skin-studio/7k/mauve", NoteImage6: "skin-studio/7k/left",
    NoteImage4L: "skin-studio/7k/holdbody-50", NoteImage2T: "skin-studio/7k/holdcap",
  };
  const wrong = Object.entries(want).filter(([k, v]) => keys[k] !== v);
  check("Exported skin.ini 7K keys", !wrong.length, wrong.map(([k, v]) => `${k}=${keys[k]} (want ${v})`).join("; "));
  const missing = [...new Set(Object.values(keys).filter((v) => String(v).startsWith("skin-studio/")))].filter(
    (v) => !listing.some((f) => f.toLowerCase().startsWith(String(v).toLowerCase())),
  );
  check("Exported .osk has every file the 7K keys name", !missing.length, missing.join(", ") || `${listing.length} entries`);
  check("Dropped file carried", listing.includes("skin-studio/7k/drop-note.png") && keys.StageHint === "skin-studio/7k/drop-note");

  // ── Render the export with render-core and compare with the screen ──────
  await page.click("#tab-elements");
  await page.click("#add-toggle");
  await page.fill("#folder-path", osk);
  await page.click('#add-folder button[type="submit"]');
  await page.waitForTimeout(1500);
  await page.click("#mix-reset");
  await page.locator("#skins .skin", { hasText: /^My mix|mix/ }).last().click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await pick(7);
  check("The compared screen draws the export as the mix base, without Keymodes edits", Object.keys(await draft()).length === 0);
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(4000);
  const exportStage = await page.locator("#km-stage").screenshot({ path: join(out, "stage-export.png") });
  const diff = await page.evaluate(async ([a, b]: string[]) => {
    const load = async (data: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const g = canvas.getContext("2d")!;
      g.drawImage(image, 0, 0);
      return g.getImageData(0, 0, image.width, image.height);
    };
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return { size: false, mean: 1, changed: 1 };
    let sum = 0, changed = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs(x.data[i + c] - y.data[i + c])));
      sum += d;
      if (d > 16) changed++;
    }
    const n = x.data.length / 4;
    return { size: true, mean: sum / n / 255, changed: changed / n };
  }, [mixStage.toString("base64"), exportStage.toString("base64")]);
  check("render-core draws the exported .osk like the Keymodes stage", diff.size && diff.changed < 0.005, JSON.stringify(diff));
  check("No page errors", !pageErrors.length, pageErrors.join(" | "));

  // ── Stage defaults: a whole 7K stage group from a block naming no images ─
  await page.click("#mix-reset");
  await page.click("#tab-elements");
  await page.locator("#skins .skin", { hasText: opt.notes! }).click();
  await page.click("#use-base");
  await page.locator("#skins .skin", { hasText: opt.keys! }).click();
  await page.locator("#cats button", { hasText: "Mania" }).click();
  const group = page.locator("#groups section.group").filter({ has: page.locator("h3", { hasText: /^7K stage/ }) });
  await group.locator("button", { hasText: "Use this skin" }).click();
  await page.waitForTimeout(1500);
  const fallback = await page.locator("#mix-picks li", { hasText: "7K stage" }).locator(".pick-fallback").allTextContents();
  check("Mix panel: the 7K stage group draws nothing from the built-in look", fallback.length === 0, fallback.join("; "));
  const [download2] = await Promise.all([page.waitForEvent("download"), page.click("#export-run")]);
  const osk2 = join(out, "stage-group.osk");
  await download2.saveAs(osk2);
  const entries = spawnSync("unzip", ["-Z1", osk2], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const ini2 = spawnSync("unzip", ["-p", osk2, "skin.ini"], { encoding: "utf8" }).stdout;
  writeFileSync(join(out, "stage-group-skin.ini"), ini2);
  const block2 = /\[Mania\]\s*\r?\n\s*Keys: 7\r?\n([\s\S]*?)(\r?\n\s*\r?\n\s*\[|\r?\n\[|$)/.exec(ini2)?.[1] ?? "";
  const keys2 = Object.fromEntries(block2.split(/\r?\n/).map((l) => l.trim().split(/:\s*/)).filter((p) => p.length === 2));
  const pieces = Array.from({ length: 7 }, (_, c) => [`KeyImage${c}`, `KeyImage${c}D`, `NoteImage${c}`]).flat();
  const problems: string[] = [];
  for (const key of pieces) {
    const value = keys2[key];
    if (!value?.startsWith("skin-studio/7k/")) {
      problems.push(`${key}=${value}`);
      continue;
    }
    const files = entries.filter((e) => e.toLowerCase().startsWith(value.toLowerCase()));
    if (!files.length) problems.push(`${key}: no file`);
    for (const file of files) {
      const copied = spawnSync("unzip", ["-p", osk2, file]).stdout;
      const original = readFileSync(join(SKINS, opt.keys!, file.slice("skin-studio/7k/".length)));
      if (!copied.equals(original)) problems.push(`${file} differs from ${opt.keys}`);
    }
  }
  check("Stage group export: every receptor and note is the source's own file", !problems.length, problems.join("; ") || `${pieces.length} keys`);
  const processes = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((p) => {
    try {
      return readFileSync(`/proc/${p}/comm`, "utf8").trim();
    } catch {
      return "";
    }
  });
  // `vosu` itself contains "osu": match osu!/lazer process names, not substrings.
  check("No osu! or lazer process visible to the test vosu", !processes.some((c) => /^(osu!?(\.exe)?|lazer)$/i.test(c) || /^osu-/.test(c)) && !/osu!\.exe|PID \d+/.test(daemonLog.join("")), `${processes.length} processes: ${processes.join(", ")}`);
} catch (error) {
  check("run", false, error instanceof Error ? error.stack : String(error));
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "daemon.log"), daemonLog.join(""));
  await browser?.close();
  daemon.kill();
  spawnSync("chmod", ["-R", "u+w", LAB]);
  rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
