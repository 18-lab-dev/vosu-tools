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
import { homedir } from "node:os";
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
    // A 10K skin (the user's 「シルビア」 v1.2, copied out of lazer): blank
    // 1-px keys, one column with a line. Multi-select and the width change
    // that said "Invalid resize." run on it.
    ten: { type: "string" },
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
const cache = join(homedir(), ".cache/vosu-agents/LnCalibration");
mkdirSync(cache, { recursive: true });
const LAB = mkdtempSync(join(cache, "km-e2e-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
for (const name of [opt.keys!, opt.notes!, ...(opt.ten ? [opt.ten] : [])]) cpSync(join(opt.skins!, name), join(SKINS, name), { recursive: true });
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
  // Stage images starts collapsed; it stays open while the page does.
  await page.locator("#keymodes-view details.km-shared:not(.km-settings) > summary").click();
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^.*${keys}K`) }).first().click();
    await page.waitForSelector(`#km-grid .km-colhead:nth-of-type(${keys})`);
    await page.waitForTimeout(1500);
  };
  await pick(4);
  await page.waitForTimeout(2500);
  await shot("4k-before");
  check("4K rows from the base's block", (await page.locator("#km-grid .km-slot").count()) === 4 * 6);
  await slot("NoteImage0").click();
  await page.evaluate(() => Reflect.set(window, "pickerFirstTile", document.querySelector("#km-images .km-tile")));
  await slot("NoteImage1").click();
  check("Selecting another slot reuses unchanged picker image nodes", await page.evaluate(() => {
    const tile = Reflect.get(window, "pickerFirstTile") as HTMLElement | null;
    return !!tile?.isConnected && !!document.querySelector("#km-images")?.contains(tile);
  }));
  // Default preference roundtrips must not manufacture dirty count drafts.
  for (const summary of await page.locator("#keymodes-view details.km-hit > summary").all()) await summary.click();
  for (const preference of ["#km-keep", "#km-move-receptors"]) {
    const before = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
    const beforeApply = await page.locator("#apply-count").textContent();
    await page.locator(preference).uncheck();
    const changed = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
    await page.click("#km-undo");
    check(`${preference}: first preference Undo restores exact inherited recipe`, await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === before);
    await page.click("#km-redo");
    check(`${preference}: preference Redo restores exact changed recipe`, await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === changed);
    await page.locator(preference).check();
    check(`${preference}: return to default removes the count and dirty state`, await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === before && await page.locator("#apply-count").textContent() === beforeApply);
    await page.click("#km-undo");
    check(`${preference}: undoing the return restores the false preference exactly`, await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === changed);
    await page.click("#km-redo");
    check(`${preference}: redoing the return restores exact absent-count recipe`, await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === before);
  }
  for (const summary of await page.locator("#keymodes-view details.km-hit > summary").all()) await summary.click();
  const beforeAdd = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  const addedKeys = await page.locator("#km-add option").evaluateAll((options: HTMLOptionElement[]) => options.find((option) => option.value)?.value);
  if (!addedKeys) throw new Error("Preference regression fixture needs an unused key count");
  await page.selectOption("#km-add", addedKeys);
  await page.waitForTimeout(500);
  const added = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  for (const summary of await page.locator("#keymodes-view details.km-hit > summary").all()) await summary.click();
  await page.locator("#km-move-receptors").uncheck();
  await page.locator("#km-move-receptors").check();
  check("Explicitly added empty count survives a preference roundtrip", await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === added && !!(await draft())[addedKeys]);
  await page.click("#km-undo");
  await page.click("#km-undo");
  check("Undo of both preference changes restores exact added count", await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === added);
  await page.click("#km-undo");
  check("Undo of Add removes the count and restores exact prior recipe", await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === beforeAdd);
  for (const summary of await page.locator("#keymodes-view details.km-hit > summary").all()) await summary.click();
  await pick(4);
  const recipeBeforeWidth = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  await page.evaluate(() => Reflect.set(window, "unchangedCursorTile", [...document.querySelectorAll("#km-images .km-tile")].find((tile) => /cursor/i.test(tile.querySelector(".km-tile__name")?.textContent ?? ""))));
  const untouchedWidth = await page.locator("#km-grid .km-num").first().inputValue();
  await page.locator("#km-grid .km-num").first().fill(String(Number(untouchedWidth) + 1));
  await page.locator("#km-grid .km-num").first().press("Tab");
  await until(async () => !!(await draft())["4"]?.values.ColumnWidth, "first width committed");
  const recipeAfterWidth = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  check("Width-derived uploads preserve unrelated ordinary-source thumbnail nodes", await page.evaluate(() => {
    const tile = Reflect.get(window, "unchangedCursorTile") as HTMLElement | undefined;
    return !!tile?.isConnected && !!document.querySelector("#km-images")?.contains(tile);
  }));
  await page.click("#km-undo");
  await until(async () => await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === recipeBeforeWidth, "undo restores exact original recipe");
  check("Undo of the first width edit removes the key count override and restores exact recipe bytes", !(await draft())["4"]);
  await page.click("#km-redo");
  await until(async () => await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === recipeAfterWidth, "redo restores exact changed recipe");
  await page.click("#km-undo");
  await until(async () => await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === recipeBeforeWidth, "second undo restores recipe");
  await pick(7);
  await page.waitForTimeout(2500);
  await shot("7k-before");
  check("7K rows from the base's block", (await page.locator("#km-grid .km-slot").count()) === 7 * 6);
  check("7K note resolves from skin.ini", (await label("NoteImage1"))?.includes("NoteImage1: mania/circles-7k/mauve") ?? false, await label("NoteImage1") ?? "");

  // ── The 1/2/S pattern sets only the slots it changes ────────────────────
  // The base's 7K already follows 1/2/S. With column 1's note changed, the
  // pattern changes columns 3, 5 and 7's notes; no other slot may get the
  // "set here" dot.
  const pristine = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  const slotMarks = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("#km-grid .km-slot[data-key]")].map((el) => [
    el.dataset.key!,
    { set: el.classList.contains("km-slot--set"), shows: (el.getAttribute("aria-label") ?? "").replace(/ · set here$/, "") },
  ])));
  await source(opt.notes!);
  await slot("NoteImage0").click();
  await tile("mania/circles-7k/mauve").click();
  await waitLabel("NoteImage0", "mania/7k/mauve");
  const beforePattern = await slotMarks();
  await page.click(".km-copy-menu > summary");
  await page.click("#km-pattern");
  await page.click(".km-copy-menu > summary");
  await waitLabel("NoteImage2", "mania/7k/mauve");
  const afterPattern = await slotMarks();
  const patterned = Object.keys(afterPattern).filter((key) => afterPattern[key].shows !== beforePattern[key]?.shows);
  const strayDots = Object.keys(afterPattern).filter((key) => afterPattern[key].set && !beforePattern[key]?.set && !patterned.includes(key));
  check(
    "The 1/2/S pattern marks only the slots it changes (no set-here dot on unchanged slots)",
    patterned.join() === "NoteImage2,NoteImage4,NoteImage6" && patterned.every((key) => afterPattern[key].set) && !strayDots.length,
    `changed ${patterned.join(", ") || "none"}; stray dots ${strayDots.join(", ") || "none"}`,
  );
  await page.click("#km-undo");
  await page.click("#km-undo");
  await until(async () => await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === pristine, "undo the pattern check");

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
  await waitLabel("KeyImage0", "mania/4k/");
  await page.waitForTimeout(2500);
  await shot("4k-after");
  check("Copy key count from another skin's 4K", true, await label("KeyImage0") ?? "");

  // ── 7K: copy from this mix's 4K, keys from one skin, notes from the other ─
  await pick(7);
  await copyFrom("This mix", 4);
  await waitLabel("KeyImage6", "mania/7k/");
  check("Copy key count from 4K remaps 4 → 7 columns", true, await label("KeyImage3") ?? "");
  await source(opt.keys!);
  await slot("KeyImage0").click();
  await tile("mania-key1").click();
  await waitLabel("KeyImage0", "mania/7k/mania-key1");
  check("Click assign (slot, then picker image)", true);
  await tile("mania-key2").dragTo(slot("KeyImage1"));
  await waitLabel("KeyImage1", "mania/7k/mania-key2");
  check("Picker drag onto a slot", true);
  for (const [key, name] of [["KeyImage0D", "mania-key1D"], ["KeyImage1D", "mania-key2D"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `mania/7k/${name}`);
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
  await waitLabel("KeyImage3", "mania/7k/mania-keyS");
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
  await waitLabel("KeyImage3D", "mania/7k/mania-keySD");
  check("Explorer drag: the Keymodes tab opens on hover, the image drops on a slot", true);
  await source(opt.notes!);
  for (const [key, name] of [["NoteImage0", "mania/circles-7k/left"], ["NoteImage0H", "mania/circles-7k/left"], ["NoteImage3", "mania/circles-7k/cornflower"], ["NoteImage3H", "mania/circles-7k/cornflower"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `mania/7k/${name.split("/").pop()}`);
  }
  await slot("NoteImage0").click();
  await tile("mania/circles-7k/mauve").dragTo(page.locator('#km-columns .km-column[data-col="1"]'));
  await waitLabel("NoteImage1", "mania/7k/mauve");
  check("Picker drag onto a stage column", true);
  for (const [key, name] of [["NoteImage0L", "mania/circles-7k/holdbody-50"], ["NoteImage0T", "mania/circles-7k/holdcap"]]) {
    await slot(key).click();
    await tile(name).click();
    await waitLabel(key, `mania/7k/${name.split("/").pop()}`);
    await page.click("#km-all");
    await waitLabel(key.replace("0", "6"), `mania/7k/${name.split("/").pop()}`);
  }
  check("Apply to all columns", true);
  // Mirror and the pattern sit in the Column tools menu.
  await page.click(".km-copy-menu > summary");
  await page.click("#km-pattern");
  await page.click(".km-copy-menu > summary");
  await waitLabel("KeyImage2", "mania/7k/mania-key1");
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
  await waitLabel("NoteImage6", "mania/7k/drop-note");
  // The exact-undo width regression made temporary derives; its redo branch
  // is now gone. Remove only those unreachable fixtures before counting drops.
  await until(async () => !await page.locator("#mix-uploads-remove").isDisabled(), "derived fixture catalog refreshed after drop");
  await page.evaluate(() => document.querySelector("#mix-uploads")!.setAttribute("open", ""));
  await page.click("#mix-uploads-remove");
  await until(async () => await page.locator("#mix-uploads-remove").isDisabled(), "unreachable width fixtures removed");
  await page.evaluate(() => document.querySelector("#mix-uploads")!.removeAttribute("open"));
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
  await page.click(".km-copy-menu > summary");
  await page.click("#km-mirror");
  await page.click(".km-copy-menu > summary");
  await waitLabel("NoteImage6", "mania/7k/left");
  check("Mirror: column 7 takes column 1", true);
  await slot("KeyImage0").focus();
  await page.keyboard.press("Control+z");
  await waitLabel("NoteImage6", "mania/7k/drop-note");
  check("Undo restores the dropped image Mirror replaced", true);
  await page.keyboard.press("Control+Shift+z");
  await waitLabel("NoteImage6", "mania/7k/left");
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
  await source("Added images");
  await slot("StageHint").click();
  // Dropped files show by their file name (no upload folder).
  await page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: /^drop-note\.png$/ }) }).first().click();
  await waitLabel("StageHint", "mania/7k/drop-note");
  check("Dropped files source assigns a stage image", true);
  const hashFree = (await page.locator("#km-state").textContent()) ?? "";
  check("Status after picking a dropped file has no upload hash", hashFree === "Set StageHint to drop-note.png" && !/[0-9a-f]{16}/.test(hashFree), hashFree);
  check("A new Keymodes status clears the mirrored header message", (await page.locator("#status").textContent()) === "");
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
  try {
    await until(async () => await page.locator("#mix-uploads-list li").count() === 2, "two added images listed");
  } catch (error) {
    writeFileSync(join(out, "upload-count-failure.json"), JSON.stringify({
      summary: await page.locator("#mix-uploads-summary").textContent(),
      files: await page.locator("#mix-uploads-list li").allTextContents(),
      recipe: await page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:recipe") ?? "{}")),
    }, null, 2));
    throw error;
  }
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

  // A real uploaded receptor must survive both hidden captures and history.
  const receptorBytes = readFileSync(join(SKINS, opt.keys!, "mania-key1.png")).toString("base64");
  const dropReceptor = async (name: string, target: string) => page.evaluate(({ bytes, name, target }: { bytes: string; name: string; target: string }) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "image/png" }));
    const element = document.querySelector(target)!;
    for (const type of ["dragenter", "dragover", "drop"])
      element.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { bytes: receptorBytes, name, target });
  await dropReceptor("captured-key.png", '#km-grid [data-key="KeyImage0"]');
  await until(async () => (await draft())["7"]?.images.KeyImage0?.name === "captured-key", "real receptor upload assigned");
  const capturedSource = (await draft())["7"].images.KeyImage0.files[0].from;
  const widthBeforeCapture = await page.locator("#km-grid .km-num").first().inputValue();
  await page.locator("#km-grid .km-num").first().fill(String(Number(widthBeforeCapture) + 3));
  await page.locator("#km-grid .km-num").first().press("Tab");
  await until(async () => {
    const state = (await draft())["7"];
    return state?.hit?.originals.KeyImage0 && state.images.KeyImage0?.files[0].from !== capturedSource;
  }, "uploaded receptor becomes a hidden geometry dependency");
  await until(async () => (await page.locator("#mix-uploads-list li").allTextContents()).some((line: string) => line.includes("captured-key.png") && line.includes("used by this draft")), "capture-only upload remains used");
  check("Resizing an upload keeps its hidden original out of Remove unused", true);
  await slot("KeyImage0").locator(".km-clear").click();
  await until(async () => (await page.locator("#mix-uploads-list li").allTextContents()).some((line: string) => line.includes("captured-key.png") && line.includes("kept for undo")), "cleared source remains protected by history");
  await dropReceptor("retention-spare.png", ".km-picker");
  await until(async () => (await page.locator("#mix-uploads-list li").allTextContents()).some((line: string) => line.includes("retention-spare.png") && line.includes("unused")), "unreachable upload is offered");
  answer = false;
  await page.click("#mix-uploads-remove");
  check("Remove unused explains files retained only by undo", lastDialog.includes("kept for undo") && lastDialog.includes("1 unused"), lastDialog.replace(/\n/g, " "));
  answer = true;
  const removalRequest = page.waitForRequest((request: { url(): string }) => request.url().includes("/v1/uploads/remove"));
  await page.click("#mix-uploads-remove");
  const removalNames = (await removalRequest).postDataJSON().names as string[];
  check("Removal sends only unreachable names, never capture/history dependencies", removalNames.length === 1 && removalNames[0].endsWith("/retention-spare.png"), removalNames.join(", "));
  await until(async () => !(await page.locator("#mix-uploads-list li").allTextContents()).some((line: string) => line.includes("retention-spare.png")), "unreachable file removed");
  await page.click("#km-undo"); // clear
  await page.click("#km-undo"); // width
  await page.click("#km-undo"); // uploaded selection
  check("Undo after cleanup restores the source selection and width", (await page.locator("#km-grid .km-num").first().inputValue()) === widthBeforeCapture);

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
  for (const line of ["", "[Mania]", "Keys: 10", "ColumnWidth: 44,44,44,44,44,44,44,44,44,44", "ColumnStart: 222", "ColourHold: 10,20,30,40"]) {
    if (line) await page.keyboard.type(line);
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
  }
  await page.click("#tab-keymodes");
  await until(() => page.locator("#km-counts .km-count", { hasText: "10K" }).count(), "10K from the hand edit");
  await pick(10);
  check("Hand edit of skin.ini shows on the screen", (await page.locator("#km-grid .km-num").first().inputValue()) === "44");
  const handEditedRecipe = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  await page.locator("#km-grid .km-num").first().fill("45");
  await page.locator("#km-grid .km-num").first().press("Tab");
  await until(async () => (await draft())["10"]?.values.ColumnWidth?.startsWith("45"), "hand-edited width changed");
  await page.click("#km-undo");
  await until(async () => await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === handEditedRecipe, "undo restores hand-edited ini and recipe");
  check("Keymodes Undo preserves hand-edited skin.ini byte-for-byte without seeding overrides", !(await draft())["10"]);
  // The 10K block names no images: like lazer, every column draws osu!'s
  // built-in look; the 9K block before it keeps its own images.
  const tenK: string[] = [];
  for (let c = 0; c < 10; c++) for (const k of [`KeyImage${c}`, `NoteImage${c}`]) tenK.push(`${k}: ${(await label(k)) ?? ""}`);
  check("10K without images: every column is osu!'s built-in look", tenK.every((l) => l.includes("osu!'s built-in look")), tenK.filter((l) => !l.includes("built-in")).join(" | "));
  const nineK = (await page.locator("#km-counts .km-count", { hasText: "9K" }).textContent()) ?? "";
  check("The 9K block before it is unaffected", nineK.includes("complete"), nineK);

  // ── All [Mania] settings: the form from skin-spec's schema ────────────────
  await page.locator(".km-settings > summary").click();
  const setting = (label: string) => page.locator(`#km-settings [aria-label="${label}"]`).first();
  check("Form shows hand-edited values", (await setting("Stage left edge").inputValue()) === "222" && (await setting("Hold combo alpha").inputValue()) === "40");
  check("Unset keys show their default", (await setting("Light position").getAttribute("placeholder")) === "413" && (await setting("Combo burst side").inputValue()) === "" && (await setting("Combo burst side").locator("option").allTextContents()).includes("Right (default)"));
  // Keyboard: a field, a select, a per-column gap, a switch.
  await setting("Light position").focus();
  await page.keyboard.type("420");
  await page.keyboard.press("Tab");
  await until(async () => (await setting("Light position").inputValue()) === "420", "light position set");
  await setting("Special column").selectOption("1");
  await setting("Gap after column 2").fill("5");
  await setting("Gap after column 2").press("Tab");
  await until(async () => (await setting("Gap after column 2").inputValue()) === "5", "gap set");
  // A switch flips its key (this mix's block may already set it).
  const wasOn = await setting("Keys under notes").isChecked();
  await setting("Keys under notes").click();
  check("A switch is one undo step and shows its new state at once", ((await page.locator("#km-undo").getAttribute("title")) ?? "").includes("keys under notes") && (await setting("Keys under notes").isChecked()) === !wasOn, `${wasOn} → ${await setting("Keys under notes").isChecked()}`);
  check("Form edits land in the draft's [Mania] block", (await setting("Special column").inputValue()) === "1" && (await setting("Gap after column 1").inputValue()) === "0");
  // One undo step per edit (the toolbar's Undo names it).
  const undoLabel = (await page.locator("#km-undo").getAttribute("title")) ?? (await page.locator("#km-undo").textContent()) ?? "";
  await page.click("#km-undo");
  const undone = await until(async () => (await setting("Keys under notes").isChecked()) === wasOn, "switch undo", 8000).catch(() => false);
  const after = `undo was "${undoLabel}"; now "${await page.locator("#km-undo").getAttribute("title")}" / redo "${await page.locator("#km-redo").getAttribute("title")}"; state "${await page.locator("#km-state").textContent()}"; checked ${await setting("Keys under notes").isChecked()}`;
  check("Undo reverts the last form edit only", !!undone && (await setting("Gap after column 2").inputValue()) === "5", after);
  await page.locator("#km-settings .km-settings__field", { hasText: "Light position" }).locator(".km-reset").click();
  await until(async () => (await setting("Light position").inputValue()) === "", "light position reset");
  check("Reset to default leaves the key out", true);
  // Labels only: no truncated label, default or option (at every size
  // below), no explanatory lines; an ambiguous name has a hover tip.
  const clippedNow = () => page.evaluate(() => {
    const g = document.createElement("canvas").getContext("2d")!;
    // A select's text: its width plus the padding and the arrow must fit.
    const cut = (el: HTMLElement) => {
      if (!(el instanceof HTMLSelectElement)) {
        // Text and tip icon inside the label's box (a tip's hidden bubble
        // is overflow of its own, not of the label).
        const box = el.getBoundingClientRect(),
          range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()].some((r) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1));
      }
      const style = getComputedStyle(el);
      g.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = g.measureText(el.selectedOptions[0]?.text ?? "").width;
      return text + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) > el.clientWidth + 1;
    };
    return [...document.querySelectorAll<HTMLElement>("#km-settings .km-settings__label, #km-settings .km-rowhead, #km-settings select")]
      .filter(cut)
      .map((el) => el.getAttribute("aria-label") ?? el.textContent);
  });
  const tips = await page.locator("#km-settings .v-help").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  const notes = await page.locator("#km-settings .km-settings__note").count();
  const defaults = await page.locator("#km-settings option", { hasText: "Default (" }).count();
  check("Explanations are hover tips (v-help), not lines under fields", notes === 0 && defaults === 0 && tips.some((t) => t.includes("osu!lazer ignores it")), `${tips.length} tips; ${notes} notes; ${defaults} "Default (…)" options`);
  await page.locator("#km-settings .km-settings__field", { hasText: "Special column" }).locator(".v-help").hover();
  await page.waitForTimeout(300);
  await page.locator("#km-settings").screenshot({ path: join(out, "mania-settings-help.png") });
  for (const [theme, w, h] of [["dark", 1920, 1080], ["light", 1280, 720]] as const) {
    await page.evaluate((t: string) => (document.documentElement.dataset.theme = t), theme);
    await page.setViewportSize({ width: w, height: h });
    await page.locator("#km-settings").scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `mania-settings-${theme}-${w}x${h}.png`) });
    const scroll = await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight);
    check(`Settings form: no page scroll at ${w}x${h}`, scroll <= 0, String(scroll));
    const clipped = await clippedNow();
    check(`No control label or option is cut off at ${w}x${h}`, clipped.length === 0, clipped.join(" | "));
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 1920, height: 1080 });
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
    KeyImage0: "mania/7k/mania-key1", KeyImage1: "mania/7k/mania-key2", KeyImage3: "mania/7k/mania-keyS",
    KeyImage5: "mania/7k/mania-key2", NoteImage1: "mania/7k/mauve", NoteImage6: "mania/7k/left",
    NoteImage4L: "mania/7k/holdbody-50", NoteImage2T: "mania/7k/holdcap",
  };
  const wrong = Object.entries(want).filter(([k, v]) => keys[k] !== v);
  check("Exported skin.ini 7K keys", !wrong.length, wrong.map(([k, v]) => `${k}=${keys[k]} (want ${v})`).join("; "));
  const missing = [...new Set(Object.values(keys).filter((v) => String(v).startsWith("skin-studio/")))].filter(
    (v) => !listing.some((f) => f.toLowerCase().startsWith(String(v).toLowerCase())),
  );
  check("Exported .osk has every file the 7K keys name", !missing.length, missing.join(", ") || `${listing.length} entries`);
  check("Dropped file carried", listing.includes("mania/7k/drop-note.png") && keys.StageHint === "mania/7k/drop-note");

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

  // ── 10K: select value cells like slots, edit them together ─────────────
  if (opt.ten) {
    await page.click("#mix-reset");
    await page.click("#tab-elements");
    await page.locator("#skins .skin", { hasText: opt.ten }).first().click();
    await page.click("#use-base");
    await page.click("#tab-keymodes");
    await pick(10);
    const width = (c: number) => page.locator(`#km-grid input[aria-label="Column ${c} width"]`);
    const widths = () => Promise.all(Array.from({ length: 10 }, (_, c) => width(c + 1).inputValue()));
    const cell = (row: string, c: number) => page.locator(`#keymodes-view [data-vrow="${row}"][data-vcol="${c - 1}"]`).first();
    const kmError = async () => ((await page.locator("#km-error").isVisible()) ? ((await page.locator("#km-error").textContent()) ?? "") : "");
    const undoTitle = async () => (await page.locator("#km-undo").getAttribute("title")) ?? "";
    const before = await widths();
    // Ctrl+click columns 1–3, type 50 into the first: all three, one step.
    for (const c of [1, 2, 3]) await width(c).click({ modifiers: ["Control"] });
    const selected = await page.locator('#km-grid [data-vrow="ColumnWidth"][aria-selected="true"]').count();
    await width(1).fill("50");
    await width(1).press("Tab");
    await until(async () => (await widths()).slice(0, 3).every((w) => w === "50"), "three widths", 60000);
    await page.waitForTimeout(800);
    const after = await widths();
    const state = (await page.locator("#km-state").textContent()) ?? "";
    check("Ctrl-selected widths: typing 50 sets all three, one undo step, no invalid resize", selected === 3 && after.slice(3).join() === before.slice(3).join() && (await undoTitle()).startsWith("Undo Set width of columns 1, 2 and 3") && !/Invalid resize/.test(await kmError()), `${selected} selected; ${after.join(",")}; ${await undoTitle()}; ${state}; ${await kmError()}`);
    check("Blank 1-px keys are left as they are, and said so", /10K columns [\d, and]+ key: blank image, left as it is/.test(state), state);
    await page.screenshot({ path: join(out, "ten-widths-selected.png") });
    await page.click("#km-undo");
    await until(async () => (await widths()).join() === before.join(), "width undo", 30000);
    await page.click("#km-redo");
    await until(async () => (await widths()).slice(0, 3).every((w) => w === "50"), "width redo", 30000);
    check("Undo and redo restore and repeat the three widths", true);
    // Apply to all columns from a focused width.
    await width(1).focus();
    const allLabel = (await page.locator("#km-all").textContent()) ?? "";
    await page.click("#km-all");
    await until(async () => (await widths()).every((w) => w === "50"), "all widths", 60000);
    check("Apply to all columns copies the focused width to every column", allLabel === "Apply width to all columns" && !/Invalid resize/.test(await kmError()), `${allLabel}; ${await kmError()}`);
    // Colours: Ctrl+click two swatches, pick one colour for both.
    const colour = (c: number) => page.locator(`#km-grid input[aria-label^="Column ${c} colour"]`);
    const colourOf = async (c: number) => (await cell("Colour", c).locator(".km-swatch__value").textContent()) ?? "";
    const alphaOf = async (c: number) => (await colourOf(c)).split(",")[3];
    const a2 = await alphaOf(2);
    await cell("Colour", 2).click({ modifiers: ["Control"] });
    await cell("Colour", 4).click({ modifiers: ["Control"] });
    const pickerShown = await colour(2).evaluate((el) => el === document.activeElement);
    await colour(2).fill("#ff0000");
    await until(async () => (await colourOf(2)).startsWith("255,0,0") && (await colourOf(4)).startsWith("255,0,0"), "two colours", 30000);
    check("Ctrl-selected colours: one pick sets both (each keeps its alpha), one undo step", (await alphaOf(2)) === a2 && (await undoTitle()).startsWith("Undo Set colour of columns 2 and 4") && !(await colourOf(3)).startsWith("255,0,0"), `${await colourOf(2)} / ${await colourOf(4)} / ${await colourOf(3)}; focus ${pickerShown}; ${await undoTitle()}`);
    await page.screenshot({ path: join(out, "ten-colours-selected.png") });
    await page.keyboard.press("Escape");
    // Apply to all from a focused colour.
    await colour(2).focus();
    await page.click("#km-all");
    await until(async () => (await Promise.all(Array.from({ length: 10 }, (_, c) => colourOf(c + 1)))).every((v) => v.startsWith("255,0,0")), "all colours", 30000);
    check("Apply to all columns copies the focused colour", true);
    // A flip in the [Mania] form: Shift+click selects a run; Apply to all.
    if (!(await page.locator("details.km-settings").evaluate((d) => (d as HTMLDetailsElement).open)))
      await page.locator(".km-settings > summary").click();
    const flip = (c: number) => page.locator(`#km-settings input[aria-label="Column ${c} key flip"]`);
    const flips = () => Promise.all(Array.from({ length: 10 }, (_, c) => flip(c + 1).isChecked()));
    const flip1 = await flip(1).isChecked();
    await flip(1).click({ modifiers: ["Control"] });
    await flip(4).click({ modifiers: ["Shift"] });
    const run = await page.locator('#km-settings [data-vrow="KeyFlipWhenUpsideDown#"][aria-selected="true"]').count();
    const unchangedByClicks = (await flip(1).isChecked()) === flip1;
    await flip(2).press("Space");
    await until(async () => (await flips()).slice(0, 4).every((f) => f !== flip1), "four flips", 30000);
    check("Shift-selected flips: a run of four, Space flips all four, modifier clicks flip nothing", run === 4 && unchangedByClicks && (await flips()).slice(4).every((f) => f === flip1), `${run} selected; ${(await flips()).join(",")}`);
    await flip(5).focus();
    await page.click("#km-all");
    await until(async () => (await flips()).every((f) => f === flip1), "all flips", 30000);
    check("Apply to all columns copies the focused flip", ((await page.locator("#km-undo").getAttribute("title")) ?? "").includes("Apply key flip to all columns"));
    // Keyboard: Shift+arrows grow, Ctrl+A takes the row, Escape clears.
    await width(5).focus();
    await width(5).press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    const grown = await page.locator('#km-grid [data-vrow="ColumnWidth"][aria-selected="true"]').count();
    await page.keyboard.press("Control+a");
    const rowAll = await page.locator('#km-grid [data-vrow="ColumnWidth"][aria-selected="true"]').count();
    await page.keyboard.press("Escape");
    const cleared = await page.locator('#keymodes-view [data-vrow][aria-selected="true"]').count();
    check("Keyboard: Shift+arrows grow the run, Ctrl+A selects the row, Escape clears", grown === 3 && rowAll === 10 && cleared === 0, `${grown}, ${rowAll}, ${cleared}`);
    check("No page errors on the 10K skin", !pageErrors.length, pageErrors.join(" | "));
  }

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
    if (!value?.startsWith("mania/7k/")) {
      problems.push(`${key}=${value}`);
      continue;
    }
    const files = entries.filter((e) => e.toLowerCase().startsWith(value.toLowerCase()));
    if (!files.length) problems.push(`${key}: no file`);
    for (const file of files) {
      const copied = spawnSync("unzip", ["-p", osk2, file]).stdout;
      const original = readFileSync(join(SKINS, opt.keys!, file.slice("mania/7k/".length)));
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
