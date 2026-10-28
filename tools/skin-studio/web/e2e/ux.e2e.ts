#!/usr/bin/env bun
// End-to-end check of the studio's shell: collapsed Keymodes groups, the
// keyboard shortcuts and their sheet, the single mix draft (Discard draft
// with undo, migration of both legacy drafts), the Export choices of a
// stable base, and the Keymodes layout at 1920×1080 and 1280×720 — in an
// isolated vosu (`vosu --tool <tool>`): private network, PID and IPC
// namespaces, a /dev without GPU nodes (Chromium draws with SwiftShader),
// private /tmp and /run/user, the osu! folders hidden, a temporary HOME
// with every XDG directory.
//
//   bun tools/skin-studio/web/e2e/ux.e2e.ts --vosu <vosu binary> \
//     --playwright <playwright/index.mjs> --skins <folder with two skins> \
//     --base "Arturia (sxlvia mania+taiko)" --other "Orchids Garden" --out <evidence dir> \
//     [--tool <tool folder>] [--shots-only]
//
// `--tool` defaults to this checkout's tools/skin-studio (build it first:
// `cargo build -p vosu-skin-studio`, `bun run build` in its web folder).
// `--shots-only` takes just the layout measurements and screenshots (used
// on the previous build for before/after). The skins are copied read-only.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "../../../..");
const { values: opt } = parseArgs({
  options: {
    vosu: { type: "string" },
    playwright: { type: "string" },
    skins: { type: "string" },
    base: { type: "string" },
    other: { type: "string" },
    out: { type: "string" },
    tool: { type: "string" },
    "shots-only": { type: "boolean" },
  },
});
for (const name of ["vosu", "playwright", "skins", "base", "other", "out"] as const)
  if (!opt[name]) throw new Error(`--${name} is required`);
const out = resolve(opt.out!);
mkdirSync(out, { recursive: true });
const TOOL = resolve(opt.tool ?? join(ROOT, "tools/skin-studio"));

if (process.env.KM_E2E_SANDBOX !== "1") {
  const osuWine = join(homedir(), ".local/share/osu-wine");
  const run = spawnSync(
    "bwrap",
    [
      "--dev-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run/user",
      "--tmpfs", osuWine, "--tmpfs", join(homedir(), ".local/share/osu"),
      "--unshare-net", "--unshare-ipc", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
      "--setenv", "KM_E2E_SANDBOX", "1",
      process.execPath, ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

// ── Isolated vosu ─────────────────────────────────────────────────────────
const cache = join(homedir(), ".cache/vosu-agents/StudioUX");
mkdirSync(cache, { recursive: true });
const LAB = mkdtempSync(join(cache, "lab-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
for (const name of [opt.base!, opt.other!]) cpSync(join(opt.skins!, name), join(SKINS, name), { recursive: true });
spawnSync("chmod", ["-R", "a-w", SKINS]);
const SERVER = 25990, DASHBOARD = 25991;
mkdirSync(join(env.XDG_CONFIG_HOME, "vosu"), { recursive: true });
writeFileSync(join(env.XDG_CONFIG_HOME, "vosu/vosu.toml"), [
  "ENABLE_AUTOUPDATE = false", "OPEN_DASHBOARD_ON_STARTUP = false", "START_AT_LOGIN = false",
  'SERVER_IP = "127.0.0.1"', `SERVER_PORT = ${SERVER}`, 'DASHBOARD_IP = "127.0.0.1"', `DASHBOARD_PORT = ${DASHBOARD}`,
  `STATIC_FOLDER_PATH = "${join(LAB, "static")}"`, "",
].join("\n"));
mkdirSync(join(LAB, "static"));
const daemonLog: string[] = [];
const daemon = spawn(resolve(opt.vosu!), ["--update=false", "--tool", TOOL], { cwd: LAB, env, stdio: ["ignore", "pipe", "pipe"] });
daemon.stdout.on("data", (c) => daemonLog.push(String(c)));
daemon.stderr.on("data", (c) => daemonLog.push(String(c)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(test: () => Promise<T> | T, what: string, timeout = 60000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await test();
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
const layout: Record<string, unknown> = {};
try {
  csrf = await until(async () => {
    const page = await (await fetch(`${dash}/tools`)).text();
    return JSON.parse(/<script[^>]*id="vosu-context"[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]).csrf;
  }, "dashboard");
  await api("/api/tools/skin-studio/settings", [
    { uniqueID: "stable_skins_dir", value: SKINS },
    { uniqueID: "lazer_skins", value: false },
    { uniqueID: "start_ruleset", value: "mania" },
    { uniqueID: "credits", value: false },
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
  const open = async () => {
    await page.goto("about:blank");
    await page.goto(await launch("dark"));
    await page.waitForSelector("#skins .skin");
    await page.waitForTimeout(800);
  };
  await open();
  const slot = (key: string) => page.locator(`#km-grid [data-key="${key}"]`).first();
  const label = async (key: string) => (await slot(key).getAttribute("aria-label")) ?? "";
  const selected = () => page.locator('#km-grid .km-slot[aria-selected="true"]').count();
  const tile = (name: string) =>
    page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: new RegExp(`^${name}$`) }) }).first();
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^${keys}K`) }).first().click();
    await page.waitForTimeout(1200);
  };
  const shownKeys = async () => (await page.locator('#km-counts .km-count[aria-current="true"] .km-count__name').textContent()) ?? "";
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:recipe") ?? "null"));
  const active = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.id || el?.getAttribute("aria-label") || el?.className || el?.tagName || "";
  });

  // ── A base and one Keymodes edit, so every panel has content ──────────────
  await page.locator("#skins .skin", { hasText: opt.base! }).click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await page.waitForSelector("#km-counts .km-count");
  await pick(7);
  await slot("KeyImage0").click();
  await page.selectOption("#km-source", { label: opt.other! });
  await page.waitForTimeout(1500);
  await tile("mania-key1").click();
  await until(async () => (await label("KeyImage0")).includes("mania-key1"), "first assignment");

  // ── Layout: measured widths, no page scroll or overflow; screenshots ──────
  const capture = async (prefix: string) => {
    for (const [width, height] of [[1920, 1080], [1280, 720]] as const)
      for (const theme of ["dark", "light"]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((t: string) => (document.documentElement.dataset.theme = t), theme);
        await page.click("#tab-keymodes");
        await page.mouse.move(0, 0);
        await page.waitForTimeout(1500);
        if (theme === "dark") {
          const measured = await page.evaluate(() => {
            const box = (selector: string) => {
              const r = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
              return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
            };
            const root = document.scrollingElement!;
            const clipped = [...document.querySelectorAll<HTMLElement>(".keymodes-view > .v-toolbar, .km-picker__head, .mix > .v-panel__head")]
              .filter((el) => el.scrollWidth - el.clientWidth > 1)
              .map((el) => el.className);
            return {
              picker: box(".km-picker"),
              stage: box("#km-stage"),
              editor: box(".km-editor"),
              rail: box(".km-rail"),
              mix: box(".mix"),
              pageScrollY: root.scrollHeight - innerHeight,
              pageScrollX: root.scrollWidth - innerWidth,
              clipped,
            };
          });
          layout[`${prefix} ${width}x${height}`] = measured;
          check(`${prefix}: no page scroll or overflow at ${width}x${height}`, measured.pageScrollY <= 0 && measured.pageScrollX <= 0 && !measured.clipped.length, JSON.stringify(measured));
        }
        await page.screenshot({ path: join(out, `${prefix}-keymodes-${theme}-${width}x${height}.png`) });
        await page.locator("section.mix").screenshot({ path: join(out, `${prefix}-mix-${theme}-${width}x${height}.png`) });
        await page.click("#tab-explorer");
        await page.waitForTimeout(1200);
        await page.screenshot({ path: join(out, `${prefix}-explorer-${theme}-${width}x${height}.png`) });
      }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.click("#tab-keymodes");
    await page.waitForTimeout(800);
  };
  const prefix = opt["shots-only"] ? "before" : "after";
  await capture(prefix);
  writeFileSync(join(out, `layout-${prefix}.json`), JSON.stringify(layout, null, 2));

  if (!opt["shots-only"]) {
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    // ── Collapsed groups: closed on load, open while the page stays ─────────
    const groupsOpen = () => page.$$eval("#keymodes-view details", (list) => list.map((d) => `${d.querySelector("summary")?.textContent?.trim()}=${(d as HTMLDetailsElement).open}`));
    const initial = await groupsOpen();
    check("Every Keymodes group starts collapsed", initial.length >= 4 && initial.every((s) => s.endsWith("=false")), initial.join(", "));
    await page.locator("details.km-settings > summary").click();
    await page.locator("#keymodes-view details.km-hit > summary").first().click();
    await page.click("#tab-elements");
    await page.click("#tab-keymodes");
    await pick(4);
    await pick(7);
    const kept = await groupsOpen();
    check("Opened groups stay open across tabs and key counts", kept.filter((s) => s.endsWith("=true")).length === 2, kept.join(", "));
    await open();
    await page.click("#tab-keymodes");
    await pick(7);
    const reloaded = await groupsOpen();
    check("…and are collapsed again after a reload", reloaded.every((s) => s.endsWith("=false")), reloaded.join(", "));

    // ── Undo / redo: global for the draft, native in text fields ────────────
    const undoTitle = async () => (await page.locator("#km-undo").getAttribute("title")) ?? "";
    await slot("KeyImage1").click();
    await tile("mania-key1").click().catch(async () => {
      await page.selectOption("#km-source", { label: opt.other! });
      await page.waitForTimeout(1500);
      await tile("mania-key1").click();
    });
    await until(async () => (await label("KeyImage1")).includes("mania-key1"), "second assignment");
    await page.click("#tab-elements");
    await page.locator("body").press("Control+z");
    await page.click("#tab-keymodes");
    await pick(7);
    check("Ctrl+Z on another tab undoes the last draft change", !(await label("KeyImage1")).includes("mania-key1"), await label("KeyImage1"));
    await page.locator("body").press("Control+Shift+z");
    await until(async () => (await label("KeyImage1")).includes("mania-key1"), "redo", 10000).catch(() => false);
    check("Ctrl+Shift+Z redoes it", (await label("KeyImage1")).includes("mania-key1"));
    await page.locator("body").press("Control+z");
    await page.locator("body").press("Control+y");
    await until(async () => (await label("KeyImage1")).includes("mania-key1"), "redo y", 10000).catch(() => false);
    check("Ctrl+Y redoes too", (await label("KeyImage1")).includes("mania-key1"), await undoTitle());
    // In a text field: the browser's own undo, the draft stays.
    await page.selectOption("#export-target", "osk");
    const name = page.locator("#mix-name");
    await name.click();
    await name.press("End");
    await name.pressSequentially(" X");
    await name.press("Control+z");
    const nameAfter = await name.inputValue();
    check("Ctrl+Z in a text field is the field's own undo, not the draft's", !nameAfter.endsWith(" X") && (await label("KeyImage1")).includes("mania-key1"), `name "${nameAfter}"`);
    await name.fill("My mix");
    // Arrows in a number field stay native (the HitPosition spin button).
    await page.locator("#keymodes-view details.km-hit > summary").first().click();
    const hit = page.locator('#km-hit input[type="number"]').first();
    if (await hit.count()) {
      const before = await hit.inputValue();
      await hit.focus();
      await hit.press("ArrowUp");
      check("Arrows in a number field step its value", (await hit.inputValue()) !== before, `${before} → ${await hit.inputValue()}`);
      await hit.press("Escape");
      await hit.fill(before);
      await hit.evaluate((el: HTMLInputElement) => el.blur());
    }
    await page.locator("#keymodes-view details.km-hit > summary").first().click();

    // ── Ctrl+F: Filter images; inside a text field the browser's ────────────
    await slot("KeyImage2").click();
    await page.keyboard.press("Control+f");
    check("Ctrl+F on Keymodes focuses Filter images", (await active()) === "km-filter", await active());
    await page.click("#tab-explorer");
    await page.locator("#x-list").focus();
    await page.keyboard.press("Control+f");
    check("Ctrl+F on Explorer focuses Filter files", (await active()) === "x-filter", await active());
    await page.click("#tab-elements");
    await page.locator("#tab-elements").focus();
    await page.keyboard.press("Control+f");
    check("Ctrl+F on Elements focuses Filter skins", (await active()) === "filter", await active());

    // ── skin.ini editor: Monaco keeps Ctrl+Z, Ctrl+F and Ctrl+/ ─────────────
    await page.click("#tab-ini");
    await page.waitForSelector("#editor .monaco-editor");
    await page.click("#ini-mix").catch(() => undefined);
    await page.waitForTimeout(800);
    await page.locator("#editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n// e2e line");
    await page.waitForTimeout(300);
    const undoBefore = await undoTitle();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    const editorText = await page.evaluate(() => document.querySelector("#editor .view-lines")?.textContent ?? "");
    check("Ctrl+Z in the editor undoes the typing, not the draft", !editorText.includes("e2e line") && (await undoTitle()) === undoBefore, undoBefore);
    await page.keyboard.press("Control+f");
    await until(() => page.locator("#editor .find-widget.visible").count(), "editor find", 5000).catch(() => 0);
    check("Ctrl+F in the skin.ini tab opens the editor's find", (await page.locator("#editor .find-widget.visible").count()) > 0);
    await page.keyboard.press("Escape");
    await page.locator("#tab-ini").focus();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(300);
    check("…also when focus is outside the editor", (await page.locator("#editor .find-widget.visible").count()) > 0);
    await page.keyboard.press("Escape");
    await page.locator("#editor .view-lines").click();
    await page.keyboard.press("Control+/");
    await page.waitForTimeout(300);
    check("Ctrl+/ in the editor is Monaco's, no shortcut sheet", !(await page.locator("#keys-dialog").evaluate((d) => (d as HTMLDialogElement).open)));
    await page.keyboard.press("Control+z");

    // ── The shortcut sheet: ? and Ctrl+/ ────────────────────────────────────
    await page.click("#tab-keymodes");
    await pick(7);
    await page.locator("#tab-keymodes").focus();
    await page.keyboard.press("Shift+?");
    const sheetOpen = () => page.locator("#keys-dialog").evaluate((d) => (d as HTMLDialogElement).open);
    check("? opens the shortcut sheet", await sheetOpen());
    const rows = await page.locator("#keys-dialog kbd").allTextContents();
    const sheet = (await page.locator("#keys-dialog").textContent()) ?? "";
    const listed = ["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y", "Ctrl+F", "Ctrl+Enter", "Ctrl+S", "?", "Ctrl+/", "[", "]", "Delete", "Esc", "Enter", "Ctrl+A", "Shift+click"];
    const absent = listed.filter((k) => !rows.includes(k) && !sheet.includes(k));
    check("The sheet lists every binding", !absent.length, absent.join(", ") || `${rows.length} keys`);
    await page.locator("#keys-dialog").screenshot({ path: join(out, "shortcut-sheet.png") });
    await page.keyboard.press("Escape");
    check("Esc closes it", !(await sheetOpen()));
    await page.locator("#tab-keymodes").focus();
    await page.keyboard.press("Control+/");
    check("Ctrl+/ opens it outside the editor", await sheetOpen());
    await page.keyboard.press("Escape");
    await name.focus();
    await name.press("Shift+?");
    check("? in a text field types", !(await sheetOpen()) && (await name.inputValue()).endsWith("?"));
    await name.fill("My mix");
    await page.locator("#keys-open").click();
    check("The header's shortcut button opens it", await sheetOpen());
    await page.keyboard.press("Escape");

    // ── Keymodes keys: [ ] key counts, Delete, Esc, Enter in the picker ─────
    await slot("KeyImage0").click();
    await page.keyboard.press("BracketLeft");
    await page.waitForTimeout(800);
    const prev = await shownKeys();
    await page.keyboard.press("BracketRight");
    await page.waitForTimeout(800);
    check("[ and ] step through key counts", prev !== "7K" && (await shownKeys()) === "7K", `${prev} → ${await shownKeys()}`);
    await slot("KeyImage0").click();
    await slot("KeyImage1").click({ modifiers: [mod] });
    await page.locator("#km-filter").focus();
    await page.locator("#km-filter").press("Backspace");
    const slotOf = async (key: string) => {
      const images = (await stored()).keymodes?.["7"]?.images ?? {};
      return key in images ? JSON.stringify(images[key]) : "unset";
    };
    check("Backspace in Filter images edits the filter, clears no slot", (await slotOf("KeyImage0")).includes("mania-key1"));
    await page.locator("#km-all").focus();
    await page.keyboard.press("Delete");
    await until(async () => (await slotOf("KeyImage0")) === "null" && (await slotOf("KeyImage1")) === "null", "delete", 10000).catch(() => false);
    check("Delete clears the selected slots wherever focus is on the screen", (await slotOf("KeyImage0")) === "null" && (await slotOf("KeyImage1")) === "null" && (await undoTitle()).includes("Clear 2 slots"), `${await slotOf("KeyImage0")}; ${await undoTitle()}`);
    await page.locator("body").press("Control+z");
    await until(async () => (await slotOf("KeyImage0")).includes("mania-key1"), "undo delete", 10000).catch(() => false);
    check("Ctrl+Z puts both slots back", (await slotOf("KeyImage0")).includes("mania-key1") && (await slotOf("KeyImage1")).includes("mania-key1"));
    await slot("KeyImage3").click();
    await page.locator("#km-all").focus();
    await page.keyboard.press("Escape");
    check("Esc clears the selection", (await selected()) === 0);
    await slot("KeyImage3").click();
    await page.keyboard.press("Enter");
    check("Enter on a slot moves to the picker", ((await active()) ?? "").includes("mania") || (await page.evaluate(() => document.activeElement?.classList.contains("km-tile"))));
    await page.keyboard.press("Enter");
    await until(async () => (await label("KeyImage3")).includes(`${await page.locator("#km-images .km-tile").first().locator(".km-tile__name").textContent()}`), "enter assigns", 10000).catch(() => false);
    check("Enter on a picker image assigns it", (await undoTitle()).startsWith("Undo Set column 4 key"), await undoTitle());

    // ── Ctrl+Enter: the primary export ──────────────────────────────────────
    await page.selectOption("#export-target", "osk");
    await page.locator("#km-filter").focus();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }).catch(() => null), page.keyboard.press("Control+Enter")]);
    check("Ctrl+Enter runs the chosen export", !!download, download?.suggestedFilename() ?? "");

    // ── Export choices with a stable base ───────────────────────────────────
    const options = async () => (await page.locator("#export-target option").evaluateAll((list) => list.filter((o) => !(o as HTMLOptionElement).hidden).map((o) => `${(o as HTMLOptionElement).value}:${o.textContent}`)));
    const stableOptions = await options();
    check("Stable base: Apply to the base skin plus every new-skin export", stableOptions.some((o) => o.startsWith("apply:Apply to")) && ["stable", "osk", "quaver", "etterna"].every((v) => stableOptions.some((o) => o.startsWith(`${v}:`))), stableOptions.join(" | "));

    // ── Discard draft: confirmation names the loss; Ctrl+Z brings it back ──
    const draftBefore = JSON.stringify((await stored()).keymodes);
    answer = false;
    await page.click("#mix-reset");
    const question = lastDialog;
    check("Discard draft asks first and says what is lost", /Discard the draft/.test(question) && /7K/.test(question), question);
    check("Declining keeps the draft", JSON.stringify((await stored()).keymodes) === draftBefore);
    answer = true;
    await page.click("#mix-reset");
    await until(async () => !Object.keys((await stored()).keymodes ?? {}).length, "discarded", 10000).catch(() => false);
    check("Discard draft empties it", !Object.keys((await stored()).keymodes ?? {}).length);
    await page.screenshot({ path: join(out, "discarded.png") });
    await page.locator("body").press("Control+z");
    await until(async () => JSON.stringify((await stored()).keymodes) === draftBefore, "discard undone", 10000).catch(() => false);
    check("Ctrl+Z restores the discarded draft", JSON.stringify((await stored()).keymodes) === draftBefore);
    check("The mode switch is gone", !(await page.locator("#mode-current, #mode-new").count()));

    // ── Migration: both legacy drafts ───────────────────────────────────────
    const baseKey = (await stored()).base as string;
    const legacyNew = { name: "Legacy mix", base: baseKey, picks: {}, keymodes: { "4": { images: { KeyImage0: null }, values: {} } } };
    const legacyEdit = { name: "", base: baseKey, picks: {}, inPlace: true, pinned: true, keymodes: { "7": { images: { NoteImage0: null }, values: {} } } };
    const seed = (mode: string, recipe: object, edit: object) =>
      page.evaluate(([mode, recipe, edit]) => {
        localStorage.clear();
        localStorage.setItem("skin-studio:mode", mode as string);
        localStorage.setItem("skin-studio:recipe", JSON.stringify(recipe));
        localStorage.setItem("skin-studio:edit", JSON.stringify(edit));
      }, [mode, recipe, edit] as const);
    for (const mode of ["current", "new"]) {
      await seed(mode, legacyNew, legacyEdit);
      await open();
      const banner = page.locator("#saved-draft");
      const now = await stored();
      check(`Migration (${mode} mode): the new-mix draft is the draft`, now?.name === "Legacy mix" && !!now.keymodes?.["4"] && !now.inPlace, JSON.stringify(now));
      check(`Migration (${mode} mode): legacy keys are gone, the in-place draft is kept aside`, await page.evaluate(() => localStorage.getItem("skin-studio:edit") === null && localStorage.getItem("skin-studio:mode") === null && !!localStorage.getItem("skin-studio:saved-draft")));
      check(`Migration (${mode} mode): a banner offers the in-place draft`, (await banner.isVisible()) && /Open/.test((await banner.textContent()) ?? "") && /Discard/.test((await banner.textContent()) ?? ""), (await banner.textContent()) ?? "");
      await page.screenshot({ path: join(out, `migration-${mode}.png`) });
      if (mode === "current") {
        await banner.getByRole("button", { name: "Open" }).click();
        await page.waitForTimeout(500);
        const opened = await stored();
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:saved-draft") ?? "null"));
        check("Open: the in-place draft becomes the draft, the mix is kept as the saved draft", !!opened.keymodes?.["7"] && !opened.inPlace && saved?.name === "Legacy mix" && !!saved.keymodes?.["4"], `${JSON.stringify(opened)} / ${JSON.stringify(saved)}`);
        await open();
        check("Open: the choice survives a reload", !!(await stored()).keymodes?.["7"] && !!(await page.evaluate(() => localStorage.getItem("skin-studio:saved-draft"))));
        check("The other draft stays recoverable from the banner", await banner.isVisible(), (await banner.textContent()) ?? "");
      } else {
        answer = false;
        await banner.getByRole("button", { name: "Discard" }).click();
        check("Discard asks first", /Discard/.test(lastDialog) && !!(await page.evaluate(() => localStorage.getItem("skin-studio:saved-draft"))), lastDialog);
        answer = true;
        await banner.getByRole("button", { name: "Discard" }).click();
        await page.waitForTimeout(300);
        check("Discard drops the in-place draft only", !(await page.evaluate(() => localStorage.getItem("skin-studio:saved-draft"))) && (await stored()).name === "Legacy mix" && !(await banner.isVisible()));
        await open();
        check("…and the banner does not come back", !(await banner.isVisible()));
      }
    }
    // An in-place draft without changes is not offered.
    await seed("current", legacyNew, { name: "", base: baseKey, picks: {}, inPlace: true });
    await open();
    check("An empty in-place draft is dropped without a banner", !(await page.locator("#saved-draft").isVisible()) && !(await page.evaluate(() => localStorage.getItem("skin-studio:saved-draft"))));
    check("No page errors", !pageErrors.length, pageErrors.join(" | "));
  }
} catch (error) {
  check("run", false, error instanceof Error ? error.stack : String(error));
} finally {
  writeFileSync(join(out, opt["shots-only"] ? "results-before.json" : "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "daemon.log"), daemonLog.join(""));
  await browser?.close();
  daemon.kill();
  spawnSync("chmod", ["-R", "u+w", LAB]);
  rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
