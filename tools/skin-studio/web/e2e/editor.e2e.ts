#!/usr/bin/env bun
// Isolated real-service editor acceptance using a read-only real skin copy.
// Arguments match lazer.e2e.ts; --service optionally selects a built backend.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "../../../..");
const WEB = resolve(import.meta.dir, "..");
const { values: opt } = parseArgs({
  options: { playwright: { type: "string" }, assets: { type: "string" }, skins: { type: "string" }, skin: { type: "string" }, out: { type: "string" }, service: { type: "string" } },
});
for (const name of ["playwright", "assets", "skins", "skin", "out"] as const) if (!opt[name]) throw new Error(`--${name} is required`);
const out = resolve(opt.out!);
mkdirSync(out, { recursive: true });

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

const LAB = mkdtempSync(join(out, "lab-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home") };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });

const results: { check: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
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

// ── The lazer skin: a read-only copy, its hash as lazer computes it ────────
const SKIN = join(LAB, "skin");
cpSync(join(opt.skins!, opt.skin!), SKIN, { recursive: true });
spawnSync("chmod", ["-R", "a-w", SKIN]);
const ID = "5f1c2a7e-0000-4000-8000-00000000c0de";
const files = (dir: string, rel = ""): string[] =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(rel, e.name)) : e.isFile() ? [join(rel, e.name)] : [],
  );
const skinFiles = files(SKIN).sort();
// SkinImporter.HashableFileTypes: the .ini and .json files, by name.
const hash = createHash("sha256");
for (const f of skinFiles.filter((f) => /\.(ini|json)$/i.test(f))) hash.update(readFileSync(join(SKIN, f)));
const HASH = hash.digest("hex");

const contentHash = createHash("sha256");
for (const file of skinFiles) {
  const name = Buffer.from(file);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(name.length));
  contentHash.update(length).update(name).update(createHash("sha256").update(readFileSync(join(SKIN, file))).digest());
}
const CONTENT_HASH = contentHash.digest("hex");
// ── The stub host ──────────────────────────────────────────────────────────
const TOKEN = "e2e-token";
const theme = ["tokens.css", "system.css"].map((f) => readFileSync(join(resolve(opt.assets!), f), "utf8")).join("\n");
const bridge = `
const write = !new URLSearchParams(location.hash.slice(1)).has("readonly");
export const vosu = Object.freeze({
  ready: Promise.resolve(),
  tool: { id: "skin-studio", name: "Skin studio", version: "0" },
  dashboardUrl: location.origin + "/",
  colorScheme: "dark",
  get canWrite() { return write; },
  fetch(path, options = {}) {
    const url = new URL(path, location.origin + "/tools/skin-studio/api/");
    const headers = new Headers(options.headers);
    if (write) headers.set("x-stub-session", "1");
    return fetch(url, { ...options, headers });
  },
  async settings() { return {}; },
  subscribe(fields, onFrame, onStatus) { onStatus?.("open"); return () => {}; },
});`;
let service = 0;
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const json = (value: unknown) => Response.json(value);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/assets/")) {
      const name = path.slice("/assets/".length);
      if (name.includes("/") || name.includes("..")) return new Response("invalid", { status: 400 });
      const file = Bun.file(join(resolve(opt.assets!), name));
      return await file.exists() ? new Response(file) : new Response("missing", { status: 404 });
    }
    if (path === "/tools/_host/v1/context")
      return json({ client: "lazer", osu_dir: null, songs_dir: null, skin: { name: opt.skin, files: true }, beatmap: null });
    if (path === "/tools/_host/v1/settings") return json({ stable_skins_dir: "", credits: false, lazer_skins: true, start_ruleset: "mania" });
    if (path === "/tools/_host/v1/bridge.js") return new Response(bridge, { headers: { "content-type": "text/javascript" } });
    if (path === "/tools/_host/v1/theme.css") return new Response(theme, { headers: { "content-type": "text/css" } });
    if (path === "/tools/lazer-library/api/v1/status") return json({ available: true });
    if (path === "/tools/lazer-library/api/v1/skins")
      return json({ skins: [{ id: ID, name: opt.skin, creator: "e2e", hash: HASH, content_hash: CONTENT_HASH, builtin: null, files: skinFiles.length }] });
    if (path === `/tools/lazer-library/api/v1/skins/${ID}/files`)
      return json({ files: skinFiles.map((name) => ({ name, size: statSync(join(SKIN, name)).size })) });
    const prefix = `/tools/lazer-library/api/v1/skins/${ID}/file/`;
    if (path.startsWith(prefix)) {
      const name = path.slice(prefix.length);
      const match = skinFiles.find((file) => file.toLowerCase() === name.toLowerCase());
      return match ? new Response(Bun.file(join(SKIN, match))) : new Response("missing", { status: 404 });
    }
    if (path.startsWith("/tools/skin-studio/api/")) {
      // vosu's proxy: POSTs need the page's session; the tool gets its token.
      if (request.method !== "GET" && !request.headers.get("x-stub-session"))
        return new Response("tool UI session or dependent tool token required", { status: 403 });
      const target = `http://127.0.0.1:${service}/${path.slice("/tools/skin-studio/api/".length)}${url.search}`;
      const headers = new Headers(request.headers);
      headers.set("x-vosu-tool-token", TOKEN);
      headers.set("x-vosu-caller", "ui");
      headers.delete("host");
      const body = request.method === "GET" ? undefined : await request.arrayBuffer();
      const response = await fetch(target, { method: request.method, headers, body });
      return new Response(response.body, { status: response.status, headers: response.headers });
    }
    if (path.startsWith("/tools/skin-studio/")) {
      const rel = path.slice("/tools/skin-studio/".length) || "index.html";
      const file = join(WEB, "dist", rel);
      if (!file.startsWith(join(WEB, "dist")) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

// ── The real service, as vosu starts it ────────────────────────────────────
const dataDir = join(LAB, "tool-data"), cacheDir = join(LAB, "tool-cache");
mkdirSync(dataDir);
mkdirSync(cacheDir);
const serviceLog: string[] = [];
const tool = spawn(opt.service ?? join(ROOT, "target/debug/vosu-skin-studio"), [], {
  env: {
    ...env,
    VOSU_TOOL_PROTOCOL: "1",
    VOSU_TOOL_ID: "skin-studio",
    VOSU_TOOL_TOKEN: TOKEN,
    VOSU_URL: `http://127.0.0.1:${server.port}`,
    VOSU_TOOL_DATA_DIR: dataDir,
    VOSU_TOOL_CACHE_DIR: cacheDir,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
tool.stdout.on("data", (c) => {
  serviceLog.push(String(c));
  const ready = /vosu-tool-ready (\d+)/.exec(String(c));
  if (ready) service = Number(ready[1]);
});
tool.stderr.on("data", (c) => serviceLog.push(String(c)));

const { chromium } = await import(resolve(opt.playwright!));
let browser: any;
try {
  await until(() => service, "service");
  browser = await chromium.launch({ headless: true, env, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/tools/skin-studio/`);
  await page.waitForSelector("#skins .skin");
  await page.locator("#skins .skin", { hasText: opt.skin! }).click();
  await page.click("#use-base");
  await page.click("#tab-ini");
  await page.waitForSelector("#editor .monaco-editor");
  check("Draft by default", await page.locator("#ini-mix").getAttribute("aria-pressed") === "true");
  // Native actions use real keyboard/pointer input, with no editor test hook.
  const edit = page.locator("#editor textarea").first();
  await edit.focus();
  const text = "[Mania]\nKeys: 4\nNoteImage0: alpha\nNoteImage1: alpha\nNoteImage2: ALPHA\nNoteImage3: alphabet\n";
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Control+h");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  const replace = page.getByRole("textbox", { name: "Replace", exact: true });
  await find.fill("alpha");
  await replace.fill("beta");
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("4"), "four matches");
  check("Ctrl+H opens find and replace with match count", true);
  await page.getByRole("checkbox", { name: /Match Case/ }).click();
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("3"), "case match count");
  await page.getByRole("checkbox", { name: /Match Whole Word/ }).click();
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("2"), "whole word match count");
  check("Case and whole word toggles", true);
  await page.getByRole("checkbox", { name: /Use Regular Expression/ }).click();
  await find.fill("a(lpha)");
  await replace.fill("b$1");
  await page.getByRole("button", { name: /Replace All/ }).click();
  await page.keyboard.press("Escape");
  await edit.focus();
  // Clipboard-free copy of editor text via its accessible textarea is not
  // reliable (Monaco uses a sliding input window). Select-all + find counts
  // asserts the document's content through the same public UI instead.
  await page.keyboard.press("Control+f");
  await find.fill("blpha");
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("2"), "regex replacements");
  check("Regex replace-all expands capture groups", true);
  await page.keyboard.press("Escape");
  await edit.focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+f");
  await find.fill("a(lpha)");
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("2"), "replace all undone");
  check("Replace-all is one undo", true);
  await page.keyboard.press("Escape");
  await edit.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("[Mania]\nKeys: 4\nNoteImage0: alpha\nNoteImage1: alpha\nNoteImage2: alpha\n");
  // Let type-triggered suggestions settle before testing pointer gestures.
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  const rectangleText = await page.locator("#editor .view-lines").innerText();
  const line = page.locator("#editor .view-line").filter({ hasText: "NoteImage0:" }).first();
  const last = page.locator("#editor .view-line").filter({ hasText: "NoteImage2:" }).first();
  const firstBox = await line.boundingBox(), lastBox = await last.boundingBox();
  if (!firstBox || !lastBox) throw new Error("No editor line geometry");
  await page.mouse.click(firstBox.x + 8, firstBox.y + 10);
  await page.keyboard.down("Alt");
  await page.mouse.click(lastBox.x + 8, lastBox.y + 10);
  await page.keyboard.up("Alt");
  await until(async () => await page.locator("#editor .cursor").count() === 2, "Alt+click cursors");
  check("Alt+click adds a cursor", true);
  for (const [label, modifiers, button] of [
    ["Shift+Alt-drag", ["Shift", "Alt"], "left"],
    ["Middle-drag", [], "middle"],
    ["Alt-drag", ["Alt"], "left"],
  ] as const) {
    await page.keyboard.press("Escape");
    await page.mouse.click(firstBox.x + 8, firstBox.y + 10);
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await page.mouse.move(firstBox.x + 8, firstBox.y + 10);
    await page.mouse.down({ button });
    await page.mouse.move(lastBox.x + 8, lastBox.y + 10, { steps: 8 });
    await page.mouse.up({ button });
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
    await until(async () => await page.locator("#editor .cursor").count() === 3, label);
    check(`${label} produces three cursors`, true);
    const unchanged = await page.locator("#editor .view-lines").innerText() === rectangleText;
    check(`${label} never pastes or changes text`, unchanged);
    if (!unchanged) throw new Error(`${label} changed the document`);
  }
  await page.keyboard.insertText("X");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+f");
  await find.fill("X");
  // Regex whole-word search is reset for the multicursor insertion.
  await page.getByRole("checkbox", { name: /Match Whole Word/ }).click();
  await page.getByRole("checkbox", { name: /Use Regular Expression/ }).click();
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("3"), "three inserted characters");
  check("Box selection edits all three lines", true);
  await page.keyboard.press("Escape");
  await edit.focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+d");
  await until(async () => await page.locator("#editor .cursor").count() === 2, "Ctrl+D cursors");
  check("Ctrl+D adds next matching selection", true);
  await page.keyboard.press("Control+Shift+l");
  await until(async () => await page.locator("#editor .cursor").count() === 3, "all matching cursors");
  check("Ctrl+Shift+L selects all matches", true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+/");
  await until(async () => (await page.locator("#editor .view-lines").innerText()).includes("//"), "line comment");
  check("Ctrl+/ toggles // comment", true);
  await page.keyboard.press("Control+/");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await until(async () => (await page.locator("#editor .view-line").nth(1).innerText()).includes("alpha"), "move line");
  check("Alt+Down moves line", true);
  await page.keyboard.press("Shift+Alt+ArrowDown");
  await until(async () => await page.locator("#editor .view-line").filter({ hasText: "Keys:" }).count() === 2, "copy line");
  check("Shift+Alt+Down copies line", true);
  // Completion uses the real skin's paths, not a synthetic file inventory.
  const image = skinFiles.find((file) => /\/[^/]+(?:@2x)?\.png$/i.test(file));
  if (!image) throw new Error("Real skin needs a subfolder PNG");
  const stem = image.replace(/\.png$/i, "").replace(/@2x$/i, "");
  const folder = stem.slice(0, stem.lastIndexOf("/") + 1);
  await edit.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(`[Mania]\nKeys: 4\nNoteImage0: ${folder}`);
  await page.keyboard.press("Control+Space");
  await page.waitForSelector(".suggest-widget.visible");
  const leaf = stem.slice(folder.length);
  await until(async () => (await page.locator(".suggest-widget").textContent())?.includes(leaf), "real path completion");
  check("Real skin folder-by-folder completion", true, stem);
  await page.keyboard.insertText(leaf);
  await page.keyboard.press("Enter");
  await until(async () => (await page.locator("#editor .view-lines").innerText()).replace(/\u00a0/g, " ").includes(`NoteImage0: ${stem}`), "inserted path");
  check("Completion inserts the full extensionless path", true);
  await page.keyboard.press("Escape");
  await edit.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(`[Mania]\nKeys: 4\nNoteImage0: ${stem}\nNoteImage1: this-file-does-not-exist\n`);
  await until(async () => (await page.locator("#diagnostics").textContent())?.includes("Missing image"), "unresolved path diagnostic");
  check("Unresolved draft paths are diagnosed", true);
  await edit.focus();
  await page.keyboard.press("Control+h");
  await find.fill("NoteImage\\d");
  await page.getByRole("checkbox", { name: /Use Regular Expression/ }).click();
  await replace.fill("NoteImage0");
  await until(async () => (await page.locator(".matchesCount").textContent())?.includes("2"), "screenshot find count");
  for (const mode of ["dark", "light"]) {
    await page.evaluate((mode: string) => { document.documentElement.dataset.theme = mode; }, mode);
    await page.screenshot({ path: join(out, `editor-${mode}.png`) });
  }
  check("No page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("run", false, error instanceof Error ? error.stack : String(error));
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    await failedPage.screenshot({ path: join(out, "failure.png") });
    writeFileSync(join(out, "failure.txt"), await failedPage.locator("body").innerText());
  }
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "service.log"), serviceLog.join(""));
  await browser?.close();
  tool.kill();
  server.stop(true);
  spawnSync("chmod", ["-R", "u+w", LAB]);
  rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
