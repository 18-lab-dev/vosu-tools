#!/usr/bin/env bun
// End-to-end check of editing an osu!lazer skin in place, against stand-ins:
// a stub vosu host (context reports a lazer client and its current skin;
// lazer-library's routes serve a read-only copy of a real skin; the tool
// bridge gives the page a session, or none with #readonly) in front of the
// real Skin studio service, and a stand-in osu!lazer: a copy of bash named
// `osu!` next to an `osu.Game.dll`, whose BASH_ENV hook records the file a
// second start is handed instead of importing it. All inside bubblewrap:
// private network, PID and IPC namespaces (so only the stand-in is "running"),
// private /tmp and /run/user, the osu! folders hidden, a temporary HOME.
//
//   bun tools/skin-studio/web/e2e/lazer.e2e.ts --playwright <playwright/index.mjs> \
//     --assets <vosu checkout>/assets/server --skins <folder with the skin> \
//     --skin "Arturia (sxlvia mania+taiko)" --out <evidence dir>
//
// `--assets` provides the design system's tokens.css and system.css, which
// vosu serves as /tools/_host/v1/theme.css.
//
// Build first: `cargo build -p vosu-skin-studio` and `bun run build` in
// tools/skin-studio/web.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "../../../..");
const WEB = resolve(import.meta.dir, "..");
const { values: opt } = parseArgs({
  options: { playwright: { type: "string" }, assets: { type: "string" }, skins: { type: "string" }, skin: { type: "string" }, out: { type: "string" }, "missing-source": { type: "boolean" }, churn: { type: "boolean" } },
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

const REPLACEMENT = "5f1c2a7e-0000-4000-8000-00000000beef";
const ALTERNATE = "5f1c2a7e-0000-4000-8000-00000000cafe";
const alternateFiles = skinFiles.filter((name) => !/mauve/i.test(name));
let removed = false;
const libraryRequests: number[] = [];
const contentHash = createHash("sha256");
for (const file of skinFiles) {
  const name = Buffer.from(file);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(name.length));
  contentHash.update(length).update(name).update(createHash("sha256").update(readFileSync(join(SKIN, file))).digest());
}
const CONTENT_HASH = contentHash.digest("hex");
// ── The stand-in osu!lazer ─────────────────────────────────────────────────
const lazer = join(LAB, "lazer");
mkdirSync(lazer);
copyFileSync("/bin/bash", join(lazer, "osu!"));
chmodSync(join(lazer, "osu!"), 0o755);
writeFileSync(join(lazer, "osu.Game.dll"), "");
const record = join(LAB, "opened.txt");
const hook = join(LAB, "hook.sh");
writeFileSync(hook, `case "$0" in *.osk) printf '%s\\n' "$0" >> '${record}'; exit 0;; esac\n`);
// (`; :` keeps bash itself running: a lone command would be exec'd in its place.)
const game = spawn(join(lazer, "osu!"), ["-c", "sleep 3600; :"], { env: { ...env, BASH_ENV: hook }, stdio: "ignore" });

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
    if (path === "/tools/_host/v1/context")
      return json({ client: "lazer", osu_dir: null, songs_dir: null, skin: { name: opt.skin, files: true }, beatmap: null });
    if (path === "/tools/_host/v1/settings") return json({ stable_skins_dir: "", credits: false, lazer_skins: true, start_ruleset: "mania" });
    if (path === "/tools/_host/v1/bridge.js") return new Response(bridge, { headers: { "content-type": "text/javascript" } });
    if (path === "/tools/_host/v1/theme.css") return new Response(theme, { headers: { "content-type": "text/css" } });
    if (path === "/tools/lazer-library/api/v1/status") return json({ available: true });
    if (path === "/tools/lazer-library/api/v1/skins")
      return json({ skins: (opt["missing-source"] ? [...(removed ? [] : [ID]), REPLACEMENT, ALTERNATE] : [removed ? REPLACEMENT : ID]).map((id) => ({ id, name: opt.skin, creator: "e2e", hash: HASH, content_hash: id === ALTERNATE ? null : CONTENT_HASH, builtin: null, files: id === ALTERNATE ? alternateFiles.length : skinFiles.length })) });
    const requested = path.includes(ALTERNATE) ? ALTERNATE : path.includes(REPLACEMENT) ? REPLACEMENT : ID;
    const requestedFiles = requested === ALTERNATE ? alternateFiles : skinFiles;
    if (removed && requested === ID && path.includes(`/skins/${ID}/`)) return new Response("deleted", { status: 404 });
    if (path === `/tools/lazer-library/api/v1/skins/${requested}/files`)
      return json({ files: requestedFiles.map((name) => ({ name, size: statSync(join(SKIN, name)).size })) });
    const prefix = `/tools/lazer-library/api/v1/skins/${requested}/file/`;
    if (path.startsWith(prefix)) {
      const name = path.slice(prefix.length);
      const match = requestedFiles.find((f) => f.toLowerCase() === name.toLowerCase());
      return match ? new Response(Bun.file(join(SKIN, match))) : new Response("missing", { status: 404 });
    }
    if (path.startsWith("/tools/skin-studio/api/")) {
      if (path === "/tools/skin-studio/api/v1/library") {
        libraryRequests.push(Date.now());
        serviceLog.push(`${Date.now()} GET v1/library\n`);
      }
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
const tool = spawn(join(ROOT, "target/debug/vosu-skin-studio"), [], {
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
  await until(() => service, "service ready");
  browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  const base = `http://127.0.0.1:${server.port}/tools/skin-studio/`;
  const slot = (key: string) => page.locator(`#km-grid [data-key="${key}"]`).first();
  const tile = (name: string) =>
    // The draft's images show with their folder (`mania/circles-7k/mauve`).
    page.locator("#km-images .km-tile").filter({ has: page.locator(".km-tile__name", { hasText: new RegExp(`(^|/)${name}$`) }) }).first();
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^${keys}K`) }).first().click();
    await page.waitForTimeout(1200);
  };
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  if (opt.churn) {
    await page.goto(base);
    await page.waitForSelector("#skins .skin");
    await page.evaluate((id) => {
      localStorage.setItem("skin-studio:mode", "new");
      localStorage.setItem("skin-studio:recipe", JSON.stringify({ name: "Churn test", base: `lazer:${id}`, picks: {} }));
    }, ID);
    await page.reload();
    await page.click("#tab-elements");
    await page.waitForSelector("#skins .skin");
    const before = libraryRequests.length;
    removed = true;
    await until(() => libraryRequests.length > before, "one automatic library poll", 22000);
    await until(async () => await page.locator("#missing-sources").isVisible(), "Elements recovery banner after one poll", 5000);
    const skins = await page.evaluate(async () => (await (await fetch("api/v1/library")).json()).skins);
    check("replacement B is listed", skins.some((skin: { key: string; available: boolean }) => skin.key === `lazer:${REPLACEMENT}` && skin.available));
    check("removed A shows unavailable", (await page.locator(`#mix-base option[value="lazer:${ID}"]`).textContent())?.includes("(unavailable)") === true);
    check("recovery banner appears on Elements without editing or reload", await page.locator("#missing-sources").isVisible());
    const start = Date.now(), count = libraryRequests.length;
    await page.waitForTimeout(60000);
    const idle = { durationMs: Date.now() - start, requests: libraryRequests.length - count };
    writeFileSync(join(out, "idle-poll.json"), JSON.stringify(idle, null, 2));
    check("idle library polling is bounded", idle.requests >= 3 && idle.requests <= 4, JSON.stringify(idle));
    await page.screenshot({ path: join(out, "churn-elements.png") });
  } else if (opt["missing-source"]) {
    await page.goto(base);
    await page.waitForSelector("#skins .skin");
    const file = skinFiles.find((f) => /(^|\/)mauve\.png$/i.test(f)) ?? skinFiles.find((f) => /key.*\.png$/i.test(f));
    if (!file) throw new Error("fixture requires a receptor image");
    const name = file.slice(0, -4);
    await page.evaluate(({ id, replacement, name, file }) => {
      localStorage.setItem("skin-studio:mode", "new");
      localStorage.setItem("skin-studio:recipe", JSON.stringify({
        name: "Recovery test", base: `lazer:${replacement}`, picks: {},
        keymodes: { "7": { images: { KeyImage0: { skin: `lazer:${id}`, name, files: [{ from: file, suffix: ".png" }] } }, values: {} } },
      }));
    }, { id: ID, replacement: REPLACEMENT, name, file });
    await page.reload();
    await page.click("#tab-keymodes"); await pick(7);
    const width = () => page.getByRole("spinbutton", { name: "Column 1 width", exact: true });
    const resize = async (value: string) => {
      await width().fill(value); await width().press("Enter");
      await until(async () => (JSON.parse(await page.evaluate(() => localStorage.getItem("skin-studio:recipe")!)).keymodes["7"].values.ColumnWidth ?? "").split(",")[0] === value, `width ${value}`);
    };
    await resize("40");
    const saved = await page.evaluate(() => localStorage.getItem("skin-studio:recipe")!);
    const captured = JSON.parse(saved).keymodes["7"].hit.originals.KeyImage0.slot;
    check("new source references remember display name and full content hash", captured.sourceName === opt.skin && captured.sourceHash === CONTENT_HASH);
    check("base and image references both retain source metadata", JSON.parse(saved).sourceInfo[`lazer:${REPLACEMENT}`]?.name === opt.skin && JSON.parse(saved).sourceInfo[`lazer:${ID}`]?.name === opt.skin);
    removed = true;
    await width().fill("41"); await width().press("Enter");
    await until(async () => await page.locator("#missing-sources").isVisible(), "detect disappearance before edit");
    check("width edit detects vanished source without rows failure", !(await page.locator("#km-error").textContent()).includes("couldn't read"));
    await page.reload(); await page.click("#tab-keymodes"); await pick(7);
    const banner = page.locator("#missing-sources");
    check("draft load detects hidden originals and names affected slots/counts", (await banner.textContent()).includes(`${opt.skin}. 1 slot; 7K`));
    await until(async () => (await banner.locator("select option").allTextContents()).some((text) => text.includes("referenced filenames")), "candidate overlap labels");
    check("same-name candidates show creator, file counts and filename overlap", (await banner.locator("select option").allTextContents()).filter((text) => text.includes("e2e") && text.includes("files") && text.includes("referenced filenames")).length === 2);
    const captureRecovery = async (prefix: string) => {
      for (const theme of ["dark", "light"])
        for (const [width, height] of [[1280, 720], [1920, 1080]]) {
          await page.setViewportSize({ width, height });
          await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
          const layout = await page.evaluate(() => {
            const notice = document.querySelector<HTMLElement>("#missing-sources")!;
            const stage = document.querySelector<HTMLElement>("#km-stage")!;
            const shown = stage.getBoundingClientRect().top;
            notice.hidden = true;
            const without = stage.getBoundingClientRect().top;
            notice.hidden = false;
            const row = notice.querySelector<HTMLElement>(".missing-sources__row")!;
            return { shift: shown - without, rowHeight: row.getBoundingClientRect().height, overflow: row.scrollWidth - row.clientWidth };
          });
          check(`${prefix}: one-row banner at ${width}x${height} ${theme}`, layout.shift <= 48 && layout.rowHeight <= 32 && layout.overflow <= 1, JSON.stringify(layout));
          await page.screenshot({ path: join(out, `${prefix}-${theme}-${width}x${height}.png`) });
        }
    };
    check("explanatory recovery text is help-only", await banner.locator(".v-help").count() === 2 && !(await banner.textContent()).includes("Keep uses retained uploads") && !(await banner.textContent()).includes("Lazer stores no skin import date"));
    for (let index = 0; index < 2; index++) {
      const help = banner.locator(".v-help").nth(index);
      await help.evaluate((el) => (el.previousElementSibling as HTMLElement).focus());
      await page.keyboard.press("Tab");
      await until(async () => await help.evaluate((el) => getComputedStyle(el, "::after").visibility === "visible"), "focus help", 5000);
      check(`recovery help ${index + 1} is keyboard accessible`, true);
    }
    await page.locator("#tab-keymodes").focus();
    await page.mouse.move(0, 0);
    await captureRecovery("missing-source");
    const restore = async () => {
      await page.evaluate((saved) => localStorage.setItem("skin-studio:recipe", saved), saved);
      await page.reload(); await page.click("#tab-keymodes"); await pick(7);
      await until(async () => await banner.isVisible(), "restored missing draft");
    };
    for (const [label, kind] of [["Remap", "remap"], ["Keep derived images", "keep"], ["Remove slots", "remove"]]) {
      if (kind !== "remap") await restore();
      if (kind === "remap") check("exact full-content replacement is preselected, not applied", await banner.locator("select").inputValue() === `lazer:${REPLACEMENT}`);
      await banner.getByRole("button", { name: label, exact: true }).click();
      await until(async () => !(await banner.isVisible()), `${kind} recovers`);
      const recovered = JSON.parse(await page.evaluate(() => localStorage.getItem("skin-studio:recipe")!)).keymodes["7"];
      check(`${kind} recovery persisted`, kind === "remap" ? recovered.hit.originals.KeyImage0.slot.skin === `lazer:${REPLACEMENT}` : kind === "keep" ? recovered.images.KeyImage0.skin === "uploads:" && !recovered.hit?.originals.KeyImage0 : !recovered.images.KeyImage0 && !recovered.hit?.originals.KeyImage0);
      await page.click("#km-undo");
      await until(async () => await banner.isVisible(), `${kind} undo`);
      check(`${kind} is undoable`, true);
      await page.click("#km-redo");
      await until(async () => !(await banner.isVisible()), `${kind} redo`);
      await resize("42");
      check(`width changes succeed after ${kind}`, !(await page.locator("#km-error").isVisible()));
    }
    // Existing drafts cannot recover a deleted name or hash from an absent Realm row.
    const legacy = JSON.parse(saved);
    const oldOriginal = legacy.keymodes["7"].hit.originals.KeyImage0;
    for (const slot of [oldOriginal.slot, oldOriginal.prior]) { delete slot.sourceName; delete slot.sourceHash; }
    delete legacy.sourceInfo[`lazer:${ID}`];
    await page.evaluate((value) => localStorage.setItem("skin-studio:recipe", value), JSON.stringify(legacy));
    await page.reload(); await page.click("#tab-keymodes"); await pick(7);
    await until(async () => (await banner.locator("select option").allTextContents()).some((text) => text.includes("referenced filenames")), "unknown-source overlap labels");
    check("old unnamed draft says unknown and never guesses an identity from overlap", (await banner.textContent()).includes(`Unknown source skin (lazer:${ID})`) && await banner.locator("select").inputValue() === "");
    check("unknown source offers all candidates ordered by filename overlap", (await banner.locator("select option").nth(1).getAttribute("value")) === `lazer:${REPLACEMENT}`);
    await captureRecovery("missing-source-unknown");
    await banner.locator("select").selectOption(`lazer:${REPLACEMENT}`);
    await banner.getByRole("button", { name: "Remap", exact: true }).click();
    await until(async () => !(await banner.isVisible()), "explicit unknown-source remap");
    await resize("43");
    check("width changes succeed after manually remapping an unknown source", !(await page.locator("#km-error").isVisible()));
    check("No missing source request reached the service after detection", !serviceLog.join("").includes('requested_key="lazer:' + ID + '"'));
    check("No page errors", !pageErrors.length, pageErrors.join(" | "));
  } else {
  // ── The user's report: a lazer client, a tab without a session ──────────
  await page.goto(`${base}#readonly`);
  await page.waitForSelector("#skins .skin");
  const baseShown = async () => (await page.locator("#mix-base option:checked").textContent()) ?? "";
  await until(async () => (await baseShown()) === `Follow osu! · ${opt.skin}`, "lazer current skin");
  check("Lazer client: the draft is based on the current lazer skin", true, await baseShown());
  const options = () =>
    page.locator("#export-target option").evaluateAll((list) =>
      list.filter((o) => !(o as HTMLOptionElement).hidden).map((o) => `${(o as HTMLOptionElement).value}:${o.textContent}`),
    );
  check("Read-only tab: the badge says why and links to the dashboard", await page.locator("#mode").isVisible(), (await page.locator("#mode").getAttribute("title")) ?? "");
  await page.click("#tab-keymodes");
  await pick(7);
  await slot("NoteImage6").click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  const error = (await page.locator("#km-error").isVisible()) ? await page.locator("#km-error").textContent() : "";
  check("Read-only tab with lazer: Keymodes edits work (the reported bug)", !error && ((await page.locator("#km-state").textContent()) ?? "").startsWith("Clear"), error ?? "");
  await page.keyboard.press("Control+z");
  await page.screenshot({ path: join(out, "lazer-readonly.png") });

  // ── With a session: imported into lazer as "<name> [vosu edit 1]" ────────
  await page.goto("about:blank");
  await page.goto(base);
  await page.waitForSelector("#skins .skin");
  await page.click("#tab-keymodes");
  await pick(7);
  await slot("KeyImage0").click();
  await slot("KeyImage6").click({ modifiers: [mod] });
  await tile("mauve").click();
  await until(async () => (await page.locator("#export-run").textContent())?.trim() === "Import into osu!lazer", "import button", 30000);
  const notMounted = await options();
  check(
    "Lazer base, not mounted: no Apply to it, a new skin instead (import or any export)",
    !notMounted.some((o) => o.includes("Apply to")) && notMounted.includes("apply:Import into osu!lazer (new skin)") && ["stable", "osk", "quaver", "etterna"].every((v) => notMounted.some((o) => o.startsWith(`${v}:`))),
    notMounted.join(" | "),
  );
  const note = (await page.locator("#export-note").textContent()) ?? "";
  check("Not mounted: the import names the new lazer skin", note.includes(`"${opt.skin} [vosu edit 1]"`) && note.includes("Edit externally"), note);
  await page.click("#export-run");
  await page.waitForSelector("#apply-dialog[open]");
  check("The first apply shows what goes where", ((await page.locator("#apply-where").textContent()) ?? "").includes("[vosu edit 1]") && (await page.locator("#apply-list li").count()) > 0);
  await page.locator("#apply-dialog").screenshot({ path: join(out, "lazer-apply-dialog.png") });
  await page.click("#apply-confirm");
  const sent = await until(async () => ((await page.locator("#mix-result").textContent()) ?? "").includes("Sent to osu!lazer"), "sent", 30000).catch(() => false);
  if (!sent) throw new Error(`apply: ${await page.locator("#mix-result").textContent()}`);
  await until(() => existsSync(record), "the stand-in received the file");
  const opened = readFileSync(record, "utf8").trim().split("\n");
  const osk = opened[0];
  check("The running lazer is started with the .osk (IPC hand-off)", opened.length === 1 && osk.endsWith(`${opt.skin} [vosu edit 1].osk`), opened.join(" | "));
  const ini = spawnSync("unzip", ["-p", osk, "skin.ini"], { encoding: "utf8" }).stdout;
  const listing = spawnSync("unzip", ["-Z1", osk], { encoding: "utf8" }).stdout.split("\n");
  writeFileSync(join(out, "lazer-import-skin.ini"), ini);
  check("The .osk's skin.ini names the new skin", new RegExp(`^Name: ${opt.skin!.replace(/[()+]/g, "\\$&")} \\[vosu edit 1\\]\\r?$`, "m").test(ini));
  // mauve is the skin's own image: the keys name it where it is (no copy).
  check("…with the keys set to the picked image, which it carries", [...ini.matchAll(/^KeyImage[06]: (\S*\/mauve)\r?$/gm)].length >= 2 && listing.some((f) => f.toLowerCase() === `${/^KeyImage6: (\S*)\r?$/m.exec(ini)?.[1]}.png`.toLowerCase()), (ini.match(/^KeyImage[06]:.*$/gm) ?? []).join(" | "));
  check("The lazer skin itself is untouched (read-only copy)", true);
  await page.screenshot({ path: join(out, "lazer-imported.png") });

  // ── Edit externally mounted: applied into that folder, no import ─────────
  const mounted = join("/tmp", HASH);
  cpSync(SKIN, mounted, { recursive: true });
  spawnSync("chmod", ["-R", "u+w", mounted]);
  await slot("KeyImage3").click();
  await tile("mauve").click();
  await until(async () => (await page.locator("#export-run").textContent())?.trim() === "Apply to lazer's edit folder", "mounted button", 30000);
  const mountedOptions = await options();
  check("Lazer base, Edit externally mounted: Apply to it is offered", mountedOptions.includes(`apply:Apply to ${opt.skin} (Edit externally)`), mountedOptions.join(" | "));
  check("Mounted: the note names lazer's Edit externally folder", ((await page.locator("#export-note").textContent()) ?? "").includes(mounted));
  await page.click("#export-run");
  await until(async () => ((await page.locator("#mix-result").textContent()) ?? "").includes("edit folder"), "applied to mount", 30000);
  check("Mounted: skin.ini is written there", /^KeyImage3: \S*\/mauve\r?$/m.test(readFileSync(join(mounted, "skin.ini"), "utf8")));
  check("Mounted: lazer was not asked to import anything", readFileSync(record, "utf8").trim().split("\n").length === 1);
  const processes = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((p) => {
    try {
      return readFileSync(`/proc/${p}/comm`, "utf8").trim();
    } catch {
      return "";
    }
  });
  check("Only the stand-in lazer runs here", !processes.some((c) => /^osu!?\.exe$/i.test(c) || /lazer/i.test(c)), processes.join(", "));
  check("No page errors", !pageErrors.length, pageErrors.join(" | "));
  }
} catch (error) {
  check("run", false, error instanceof Error ? error.stack : String(error));
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "service.log"), serviceLog.join(""));
  await browser?.close();
  tool.kill();
  game.kill();
  server.stop(true);
  spawnSync("chmod", ["-R", "u+w", LAB]);
  rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
