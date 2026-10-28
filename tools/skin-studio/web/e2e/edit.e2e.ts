#!/usr/bin/env bun
// End-to-end check of applying the draft to its base skin in place (Apply) on a
// writable copy of a real stable skin, in an isolated vosu
// (`vosu --tool tools/skin-studio`): private network namespace, a /dev without
// GPU nodes (Chromium draws with SwiftShader), private /tmp, hidden
// /run/user and osu! folders, a temporary HOME with every XDG directory.
//
//   bun tools/skin-studio/web/e2e/edit.e2e.ts --vosu <vosu binary> \
//     --playwright <playwright/index.mjs> --skins <folder with skins> \
//     --skin "Arturia (sxlvia mania+taiko)" --other "Orchids Garden" --out <evidence dir>
//
// `--skin` is copied writable (it is edited and restored), `--other` read-only.
// Covers: the staged draft (nothing written before Apply), Ctrl/Shift/Ctrl+A
// multi-selection with one undo step, the Explorer's "Use for N slots", the
// first-apply confirmation, line endings kept, backups and Restore, a
// read-only tab, and a vosu restart taking the session away.
//
// Build first: `cargo build -p vosu-skin-studio` and `bun run build` in
// tools/skin-studio/web. The skins are copied; the originals are only read.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "../../../..");
const { values: opt } = parseArgs({
  options: {
    vosu: { type: "string" },
    playwright: { type: "string" },
    skins: { type: "string" },
    skin: { type: "string" },
    other: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["vosu", "playwright", "skins", "skin", "other", "out"] as const)
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
const LAB = mkdtempSync(join(tmpdir(), "km-edit-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
const EDITED = join(SKINS, opt.skin!);
cpSync(join(opt.skins!, opt.skin!), EDITED, { recursive: true });
cpSync(join(opt.skins!, opt.other!), join(SKINS, opt.other!), { recursive: true });
spawnSync("chmod", ["-R", "u+w", EDITED]);
spawnSync("chmod", ["-R", "a-w", join(SKINS, opt.other!)]);
const SERVER = 25970, DASHBOARD = 25971;
mkdirSync(join(env.XDG_CONFIG_HOME, "vosu"), { recursive: true });
writeFileSync(join(env.XDG_CONFIG_HOME, "vosu/vosu.toml"), [
  "ENABLE_AUTOUPDATE = false", "OPEN_DASHBOARD_ON_STARTUP = false", "START_AT_LOGIN = false",
  'SERVER_IP = "127.0.0.1"', `SERVER_PORT = ${SERVER}`, 'DASHBOARD_IP = "127.0.0.1"', `DASHBOARD_PORT = ${DASHBOARD}`,
  `STATIC_FOLDER_PATH = "${join(LAB, "static")}"`, "",
].join("\n"));
mkdirSync(join(LAB, "static"));
const daemonLog: string[] = [];
const startDaemon = () => {
  const child = spawn(resolve(opt.vosu!), ["--update=false", "--tool", join(ROOT, "tools/skin-studio")], { cwd: LAB, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => daemonLog.push(String(c)));
  child.stderr.on("data", (c) => daemonLog.push(String(c)));
  return child;
};
let daemon = startDaemon();

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
  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");

  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
  const slot = (key: string) => page.locator(`#km-grid [data-key="${key}"]`).first();
  const label = async (key: string) => (await slot(key).getAttribute("aria-label")) ?? "";
  const selected = () => page.locator('#km-grid .km-slot[aria-selected="true"]').count();
  const tile = (name: string) =>
    page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: new RegExp(`^${name}$`) }) }).first();
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^${keys}K`) }).first().click();
    await page.waitForTimeout(1200);
  };
  const files = (dir: string, rel = ""): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(dir, join(rel, e.name)) : e.isFile() ? [join(rel, e.name)] : [],
    );
  /** The folder's files and contents, so "nothing written" is exact. */
  const digest = (dir: string) => {
    const hash = createHash("sha256");
    for (const f of files(dir).sort()) hash.update(f).update(readFileSync(join(dir, f)));
    return hash.digest("hex");
  };
  const original = digest(EDITED);
  const originalIni = readFileSync(join(EDITED, "skin.ini"));
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // ── One draft; with no client it follows no skin until one is chosen ──────
  const baseShown = async () => (await page.locator("#mix-base option:checked").textContent()) ?? "";
  check("Without a client the draft's base follows osu!, which reports no skin", (await baseShown()) === "Follow osu! · no skin reported", await baseShown());
  await page.locator("#skins .skin", { hasText: opt.skin! }).click();
  await page.click("#use-base");
  await until(async () => (await baseShown()).startsWith(opt.skin!), "base");
  check("Use as mix base sets the base Apply writes into", true);

  // ── Keymodes: Ctrl+click, Shift+click, Shift+arrows, Ctrl+A, Esc ──────────
  await page.click("#tab-keymodes");
  await page.waitForSelector("#km-counts .km-count");
  await pick(7);
  await slot("KeyImage0").click();
  await slot("KeyImage3").click({ modifiers: [mod] });
  await slot("NoteImage5").click({ modifiers: [mod] });
  check("Ctrl+click selects 3 slots", (await selected()) === 3 && ((await page.locator("#km-for").textContent()) ?? "") === "For 3 slots (key, note)", (await page.locator("#km-for").textContent()) ?? "");
  check("Grid is aria-multiselectable", (await page.locator("#km-grid").getAttribute("aria-multiselectable")) === "true");
  await shot("multi-select-3");
  // One image for the three: one undo step.
  await page.selectOption("#km-source", { label: opt.other! });
  await page.waitForTimeout(1500);
  await tile("mania-key1").click();
  const set = async () => Promise.all(["KeyImage0", "KeyImage3", "NoteImage5"].map(async (k) => (await label(k)).includes("mania/7k/mania-key1")));
  await until(async () => (await set()).every(Boolean), "multi-assign");
  const status = (await page.locator("#km-state").textContent()) ?? "";
  check("Picking an image sets all 3 slots; the status names the mixed roles", status.includes("Set 3 slots to mania-key1") && status.includes("different roles (key, note)"), status);
  await slot("KeyImage0").focus();
  await page.keyboard.press("Control+z");
  await until(async () => (await set()).every((s) => !s), "undo");
  check("One undo step restores all 3", true);
  await page.keyboard.press("Control+Shift+z");
  await until(async () => (await set()).every(Boolean), "redo");
  check("Redo sets all 3 again", true);
  // Shift+click: the rectangle from the anchor.
  await slot("NoteImage0").click();
  await slot("NoteImage2H").click({ modifiers: ["Shift"] });
  check("Shift+click selects a 2×3 rectangle", (await selected()) === 6, String(await selected()));
  await page.keyboard.press("Escape");
  check("Esc clears the selection", (await selected()) === 0);
  await slot("KeyImage0D").click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  check("Shift+arrows extend the selection", (await selected()) === 3, String(await selected()));
  await page.keyboard.press("Control+a");
  check("Ctrl+A selects every slot (7 columns × 6 roles)", (await selected()) === 42, String(await selected()));
  await page.keyboard.press("Escape");
  // Explorer: "Use for N slots".
  await slot("KeyImage1D").click();
  await slot("KeyImage2D").click({ modifiers: [mod] });
  await slot("KeyImage4D").click({ modifiers: [mod] });
  await page.click("#tab-explorer");
  await page.selectOption("#x-skin", { label: `${opt.other!}` }).catch(() => undefined);
  await page.waitForTimeout(1200);
  await page.fill("#x-filter", "mania-key1D");
  await page.waitForTimeout(500);
  await page.locator("#x-list .x-row", { hasText: /mania-key1D/ }).first().click();
  const use = (await page.locator("#x-keymodes").textContent()) ?? "";
  check("Explorer button: Use for 3 slots", use.trim() === "Use for 3 slots", use);
  await page.click("#x-keymodes");
  await until(async () => (await label("KeyImage4D")).includes("mania-key1D"), "explorer multi-assign");
  check("Explorer assigns all 3 selected slots", (await label("KeyImage1D")).includes("mania-key1D") && (await label("KeyImage2D")).includes("mania-key1D"));

  // ── Staged: nothing written, N unapplied changes ──────────────────────────
  await until(async () => /\d+ unapplied change/.test((await page.locator("#apply-count").textContent()) ?? ""), "review count", 30000);
  const count = (await page.locator("#apply-count").textContent()) ?? "";
  check("The draft shows its unapplied changes", true, count);
  check("Nothing is written before Apply", digest(EDITED) === original);
  for (const [theme, w, h] of [["dark", 1920, 1080], ["light", 1280, 720]] as const) {
    await page.evaluate((t: string) => (document.documentElement.dataset.theme = t), theme);
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    await shot(`edit-current-${theme}-${w}x${h}`);
    const scroll = await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight);
    check(`No page scroll at ${w}x${h}`, scroll <= 0, String(scroll));
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.setViewportSize({ width: 1920, height: 1080 });

  // ── A read-only tab keeps and edits the draft, cannot apply ───────────────
  await page.reload();
  await page.waitForSelector("#skins .skin");
  await page.waitForTimeout(1500);
  const badge = page.locator("#mode");
  const href = (await badge.getAttribute("href")) ?? "";
  check("Read-only tab: the badge links to the dashboard's Tools page", (await badge.isVisible()) && href === `${dash}/tools`, href);
  await page.click("#tab-keymodes");
  await pick(7);
  check("Read-only tab: the draft is still there", (await label("KeyImage3")).includes("mania-key1"));
  await slot("NoteImage6").click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  const error = (await page.locator("#km-error").isVisible()) ? await page.locator("#km-error").textContent() : "";
  check("Read-only tab: Keymodes edits work (drafts need no session)", !error && ((await page.locator("#km-state").textContent()) ?? "").startsWith("Clear"), error ?? "");
  await page.keyboard.press("Control+z");
  check("Read-only tab: Apply is the export choice, disabled, and says why", (await page.locator("#export-target").inputValue()) === "apply" && (await page.locator("#export-run").isDisabled()) && ((await page.locator("#apply-count").textContent()) ?? "").includes("needs a session from the dashboard"));
  await shot("edit-readonly");

  // ── Apply with a session: the first apply shows what goes where ───────────
  // (A URL differing only in its fragment would not reload the page.)
  await page.goto("about:blank");
  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");
  await page.click("#tab-keymodes");
  await pick(7);
  check("Apply to the base skin is the default export choice", (await page.locator("#export-target").inputValue()) === "apply");
  check("Name is export-only while Apply is selected", await page.locator("#mix-name").isDisabled() && await page.locator("#mix-name").getAttribute("title") === "Apply keeps the skin's own name");
  await until(async () => !(await page.locator("#export-run").isDisabled()), "apply enabled", 30000);
  answer = true;
  await page.click("#export-run");
  await page.waitForSelector("#apply-dialog[open]");
  check("Applying is not announced before confirmation", (await page.locator("#export-run").textContent()) !== "Applying…");
  const listed = await page.locator("#apply-list li").allTextContents();
  const where = (await page.locator("#apply-where").textContent()) ?? "";
  check("The first apply lists every change and the folder", listed.length > 0 && where.includes(EDITED), `${listed.length} changes; ${where}`);
  check("Nothing is written while confirming", digest(EDITED) === original);
  await page.locator("#apply-dialog").screenshot({ path: join(out, "apply-dialog.png") });
  await page.click("#apply-confirm");
  await until(async () => ((await page.locator("#mix-result").textContent()) ?? "").includes("Applied"), "applied", 30000);
  const ini = readFileSync(join(EDITED, "skin.ini"));
  writeFileSync(join(out, "applied-skin.ini"), ini);
  const text = ini.toString("latin1"), before = originalIni.toString("latin1");
  const block = (t: string) => {
    const at = t.indexOf("Keys: 7");
    const start = t.lastIndexOf("[Mania]", at);
    const end = t.indexOf("[", at);
    return [t.slice(0, start), t.slice(end)];
  };
  const [pre0, post0] = block(before), [pre1, post1] = block(text);
  check("skin.ini outside the 7K block is byte-identical (mixed line endings kept)", pre0 === pre1 && post0 === post1);
  const seven = text.slice(text.indexOf("Keys: 7"), text.indexOf("[", text.indexOf("Keys: 7")));
  check("7K keys point at the applied copies", /KeyImage3: mania\/7k\/mania-key1\r?\n/.test(seven) && /KeyImage4D: mania\/7k\/mania-key1D\r?\n/.test(seven), seven.split(/\r?\n/).filter((l) => /KeyImage[034]D?:|NoteImage5:/.test(l)).join(" | "));
  check("The images are in the skin folder", existsSync(join(EDITED, "mania/7k/mania-key1.png")) && existsSync(join(EDITED, "mania/7k/mania-key1@2x.png")));
  const manifests = files(LAB).filter((f) => /backups\/[^/]+\/manifest\.json$/.test(f));
  const manifest = manifests.length === 1 ? JSON.parse(readFileSync(join(LAB, manifests[0]), "utf8")) : null;
  check("A backup holds every replaced file", !!manifest && manifest.changes.some((c: { path: string; action: string }) => c.path === "skin.ini" && c.action === "replace") && existsSync(join(LAB, manifests[0], "../files/skin.ini")), manifests.join(", "));
  await until(async () => ((await page.locator("#apply-count").textContent()) ?? "").includes("No unapplied changes") || ((await page.locator("#apply-count").textContent()) ?? "") === "No changes", "draft cleared", 30000);
  check("After apply the draft is empty", true, (await page.locator("#apply-count").textContent()) ?? "");
  await shot("edit-applied");
  await page.locator("summary").filter({ hasText: /^Hit position$/ }).click();
  await page.locator("#km-move-receptors").uncheck();
  check("A new draft change clears the old Apply result", (await page.locator("#mix-result").textContent()) === "");
  await page.click("#km-undo");
  await page.locator("summary").filter({ hasText: /^Hit position$/ }).click();

  // ── An unfinished apply is offered for restore when the studio opens ──────
  // The backup is marked as a rollback that could not put skin.ini back
  // (what the service writes when a restore step fails; the failure itself
  // is covered by apply.rs's fault-injection tests).
  await until(() => page.locator("#restore").isVisible(), "restore button");
  await page.selectOption("#export-target", "osk");
  check("Restore remains visible when an export destination is selected", await page.locator("#restore").isVisible());
  await page.selectOption("#export-target", "apply");
  const beforeBaseChange = await page.evaluate(() => localStorage.getItem("skin-studio:recipe"));
  await page.selectOption("#mix-base", "#none");
  const forcedDestination = await page.locator("#export-target").inputValue();
  check("No base cannot keep Apply selected", forcedDestination !== "apply");
  await page.click("#km-undo");
  await until(() => page.locator("#restore").isVisible(), "restore after undoing No base");
  check("Base Undo restores Apply and the last-apply restore action", await page.locator("#export-target").inputValue() === "apply" && await page.locator("#restore").isVisible());
  check("Base Undo restores the exact recipe", await page.evaluate(() => localStorage.getItem("skin-studio:recipe")) === beforeBaseChange);
  await page.click("#km-redo");
  check("Base Redo restores the forced destination with No base", await page.locator("#mix-base").inputValue() === "#none" && await page.locator("#export-target").inputValue() === forcedDestination);
  await page.click("#km-undo");
  await until(() => page.locator("#restore").isVisible(), "restore after second base undo");
  writeFileSync(join(LAB, manifests[0]), JSON.stringify({ ...manifest, status: "rollback_incomplete", failed: [{ path: "skin.ini", error: "injected: file in use" }] }, null, 2));
  await page.goto("about:blank");
  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");
  await until(() => page.locator("#unfinished").isVisible(), "unfinished apply shown", 30000);
  const banner = (await page.locator("#unfinished").textContent()) ?? "";
  check("An unfinished apply is reported when the studio opens", banner.includes("Last apply to Arturia (sxlvia mania+taiko) didn't finish") && banner.includes("skin.ini"), banner);
  await shot("edit-unfinished");
  await page.locator("#unfinished button", { hasText: "Restore" }).click();
  await until(async () => ((await page.locator("#mix-result").textContent()) ?? "").includes("Restored"), "restored", 30000);
  await until(async () => !(await page.locator("#unfinished").isVisible()), "unfinished cleared", 30000);
  check("Its Restore returns the folder to its original files and clears the notice", digest(EDITED) === original && !(await page.locator("#restore").isVisible()), (await page.locator("#mix-result").textContent()) ?? "");
  await page.click("#tab-keymodes");
  await pick(7);

  // ── vosu restarts: the tab loses its session and says so ──────────────────
  await slot("KeyImage0").click();
  await page.keyboard.press("Delete");
  daemon.kill();
  await new Promise((r) => daemon.once("exit", r));
  daemon = startDaemon();
  await until(async () => (await fetch(`${dash}/tools`)).ok, "vosu again");
  await page.waitForTimeout(1500);
  await page.click("#export-run").catch(() => undefined);
  await until(async () => await page.locator("#mode").isVisible(), "session loss shown", 30000);
  const lost = `${await page.locator("#apply-count").textContent()} ${await page.locator("#mode").getAttribute("title")}`;
  check("After a vosu restart the tab turns read-only and says why", lost.includes("vosu restarted"), lost);
  check("…and nothing was written", digest(EDITED) === original);
  await shot("edit-session-lost");
  check("No page errors", !pageErrors.length, pageErrors.join(" | "));
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
