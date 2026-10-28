#!/usr/bin/env bun
// End-to-end check of the Mix panel's Quaver and Etterna exports on a real
// skin, in an isolated vosu (`vosu --tool tools/skin-studio`): private
// network, IPC and PID namespaces, a /dev without GPU nodes (Chromium draws
// with SwiftShader), private /tmp, hidden /run/user and osu! folders, a
// temporary HOME with every XDG directory. The skin is copied read-only.
//
//   bun tools/skin-studio/web/e2e/export.e2e.ts --vosu <vosu binary> \
//     --playwright <playwright/index.mjs> --skins <folder with the skin> \
//     --skin "Arturia (sxlvia mania+taiko)" --out <evidence dir>
//
// Build first: `cargo build -p vosu-skin-studio` and `bun run build` in
// tools/skin-studio/web. Writes to --out: screenshots of the export area in
// both themes, the downloaded `.qs` and Etterna `.zip`, both extracted, and
// results.json.
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
    skin: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["vosu", "playwright", "skins", "skin", "out"] as const)
  if (!opt[name]) throw new Error(`--${name} is required`);
const out = resolve(opt.out!);
mkdirSync(out, { recursive: true });

if (process.env.EXPORT_E2E_SANDBOX !== "1") {
  const osuWine = join(homedir(), ".local/share/osu-wine");
  const run = spawnSync(
    "bwrap",
    [
      "--dev-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run/user",
      // The skin is read from a copy made before osu!'s folder is hidden.
      ...(resolve(opt.skins!).startsWith(osuWine) ? [] : ["--tmpfs", osuWine]),
      "--unshare-net", "--unshare-ipc", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
      "--setenv", "EXPORT_E2E_SANDBOX", "1",
      process.execPath, ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

// ── Isolated vosu ─────────────────────────────────────────────────────────
const LAB = mkdtempSync(join(tmpdir(), "export-e2e-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
cpSync(join(opt.skins!, opt.skin!), join(SKINS, opt.skin!), { recursive: true });
spawnSync("chmod", ["-R", "a-w", SKINS]);
const SERVER = 25960, DASHBOARD = 25961;
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

function sleep(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
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
const listing = (archive: string) =>
  spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Playwright is not a dependency of this repository: its path comes from --playwright.
const { chromium } = await import(resolve(opt.playwright!));
let browser: { close(): Promise<void> } | undefined;
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
  const launched = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  browser = launched;
  const context = await launched.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("dialog", (d: { accept(): Promise<void> }) => d.accept());

  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");
  await page.locator("#skins .skin", { hasText: opt.skin! }).click();
  await page.click("#use-base");
  const NAME = "Arturia export";
  // Apply keeps the skin's own name (the field is disabled): name the export.
  await page.selectOption("#export-target", "stable");
  await page.fill("#mix-name", NAME);
  await page.locator("#mix-name").press("Tab");
  await until(async () => (await page.evaluate(() => document.querySelector("#mix-tally .v-help")?.getAttribute("aria-label")))?.includes("files"), "mix composed");

  // ── The choice: keyboard operable, per-target notes and buttons ─────────
  const exportTarget = page.locator("#export-target");
  await exportTarget.focus();
  const seen: Record<string, { note: string; button: string; disabled: boolean }> = {};
  for (const target of ["stable", "osk", "quaver", "etterna"]) {
    await exportTarget.selectOption(target);
    await page.waitForTimeout(200);
    seen[target] = {
      note: (await page.locator("#export-note").textContent()) ?? "",
      button: (await page.locator("#export-run").textContent())?.trim() ?? "",
      disabled: await page.locator("#export-run").isDisabled(),
    };
  }
  check("Quaver note names the skipped key counts", !/skips/.test(seen.quaver.note) && seen.quaver.note.startsWith("1K, 2K, 3K"), seen.quaver.note);
  check("Etterna note skips 1K and 2K", seen.etterna.note.includes("skips 1K, 2K"), seen.etterna.note);
  check("Button follows the target", seen.quaver.button === "Download Quaver skin" && seen.etterna.button === "Download Etterna noteskins", JSON.stringify(seen));
  await page.keyboard.press("Tab");
  check("Tab moves from the choice to its button", await page.evaluate(() => document.activeElement?.id === "export-run"));
  const scroll = async () => page.evaluate(() => ({ page: document.scrollingElement!.scrollHeight - innerHeight, body: document.body.scrollHeight - innerHeight }));
  for (const [width, height] of [[1920, 1080], [1366, 768], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    const s = await scroll();
    check(`No page scroll at ${width}×${height}`, s.page <= 0 && s.body <= 0, JSON.stringify(s));
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  // ── Downloads ────────────────────────────────────────────────────────────
  const exportAs = async (target: string, file: string) => {
    await exportTarget.selectOption(target);
    const started = Date.now();
    const downloaded = page.waitForEvent("download", { timeout: 300000 });
    await page.click("#export-run");
    // A conversion error shows under the button instead of a download.
    const failed = page
      .waitForSelector("#mix-result .error", { timeout: 300000 })
      .then(async () => {
        throw new Error(`${target}: ${await page.locator("#mix-result").innerText()}`);
      });
    const download = await Promise.race([downloaded, failed]);
    const path = join(out, file);
    await download.saveAs(path);
    await until(async () => (await page.locator("#mix-result").textContent())?.includes("Exported"), `${target} report`);
    check(`${target} export took ${((Date.now() - started) / 1000).toFixed(1)} s`, true);
    return { path, name: download.suggestedFilename(), report: (await page.locator("#mix-result").innerText()) ?? "" };
  };
  const quaver = await exportAs("quaver", "quaver.qs");
  await page.locator(".mix").screenshot({ path: join(out, "export-quaver-dark.png") });
  check("Quaver download name", quaver.name === `${NAME}.qs`, quaver.name);
  check("Quaver report lists the export", quaver.report.includes("Exported 1K, 2K, 3K, 4K, 5K, 6K, 7K, 8K, 9K"), quaver.report);
  const etterna = await exportAs("etterna", "etterna.zip");
  await page.locator(".mix").screenshot({ path: join(out, "export-etterna-dark.png") });
  check("Etterna download name", etterna.name === `${NAME} (Etterna).zip`, etterna.name);
  check("Etterna report lists exported and skipped counts", etterna.report.includes("Exported 3K, 4K, 5K, 6K, 7K, 8K, 9K") && etterna.report.includes("Skipped 1K") && etterna.report.includes("Skipped 2K"), etterna.report);
  await page.screenshot({ path: join(out, "studio-dark.png") });

  // Light theme: a fresh light context (the host theme follows the colour
  // scheme; no earlier export result), checked by the shell's computed
  // background before any screenshot.
  const background = (p: typeof page) =>
    p.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g)!.map(Number);
      return { css: getComputedStyle(document.body).backgroundColor, luminance: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 };
    });
  const dark = await background(page);
  check("Dark shell background is the dark token", dark.luminance < 0.3, dark.css);
  const lightContext = await launched.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "light" });
  const light = await lightContext.newPage();
  light.on("pageerror", (e: Error) => pageErrors.push(e.message));
  await light.goto(await launch("light"));
  await light.waitForSelector("#skins .skin");
  await light.locator("#skins .skin", { hasText: opt.skin! }).click();
  await light.click("#use-base");
  await light.selectOption("#export-target", "stable");
  await light.fill("#mix-name", NAME);
  await light.locator("#mix-name").press("Tab");
  await until(async () => (await light.evaluate(() => document.querySelector("#mix-tally .v-help")?.getAttribute("aria-label")))?.includes("files"), "light mix composed");
  const lit = await background(light);
  check("Light shell background is the light token", lit.luminance > 0.7 && lit.css !== dark.css, lit.css);
  check("Light page shows no earlier export result", ((await light.locator("#mix-result").textContent()) ?? "").trim() === "");
  for (const [width, height] of [[1920, 1080], [1280, 720]]) {
    const size = `${width}x${height}`;
    await light.setViewportSize({ width, height });
    await page.setViewportSize({ width, height });
    for (const target of ["quaver", "etterna"]) {
      for (const [p, theme] of [[light, "light"], [page, "dark"]] as const) {
        await p.locator("#export-target").selectOption(target);
        await p.waitForTimeout(400);
        await p.locator(".mix").screenshot({ path: join(out, `export-${target}-${theme}-${size}.png`) });
      }
    }
    await light.screenshot({ path: join(out, `studio-light-${size}.png`) });
    await page.screenshot({ path: join(out, `studio-dark-${size}.png`) });
  }
  await lightContext.close();

  // ── Archives ─────────────────────────────────────────────────────────────
  const qs = listing(quaver.path);
  const want = ["skin.ini", "Judgements/judge-marv.png"];
  for (const keys of [4, 7])
    for (let lane = 1; lane <= keys; lane++)
      want.push(
        `${keys}k/Receptors/receptor-up-${lane}.png`,
        `${keys}k/Receptors/receptor-down-${lane}.png`,
        `${keys}k/HitObjects/note-hitobject-${lane}.png`,
        `${keys}k/HitObjects/note-holdhitobject-${lane}.png`,
        `${keys}k/HitObjects/note-holdend-${lane}.png`,
      );
  const missing = want.filter((p) => !qs.includes(p));
  check("Quaver skin has Quaver's element names for 4K and 7K", !missing.length, missing.join(", ") || `${qs.length} entries`);
  const ini = spawnSync("unzip", ["-p", quaver.path, "skin.ini"], { encoding: "utf8" }).stdout;
  check("Quaver skin.ini has a section per key count", [1, 4, 7, 9].every((k) => ini.includes(`[${k}K]\r\n`)) && !ini.includes("[10K]"), ini.split("\r\n").filter((l) => l.startsWith("[")).join(" "));
  const etternaFiles = listing(etterna.path);
  const skins = [...new Set(etternaFiles.filter((p) => p.startsWith("NoteSkins/")).map((p) => p.split("/").slice(0, 3).join("/")))];
  check(
    "Etterna noteskins per game",
    JSON.stringify(skins) === JSON.stringify(["3K", "4K", "5K", "6K", "7K", "8K", "9K"].map((k) => {
      const game = { "3K": "dance", "4K": "dance", "5K": "pump", "6K": "dance", "7K": "kb7", "8K": "dance", "9K": "popn" }[k];
      return `NoteSkins/${game}/${NAME} ${k}`;
    })),
    skins.join(", "),
  );
  check("Every Etterna noteskin has NoteSkin.lua and metrics.ini", skins.every((s) => etternaFiles.includes(`${s}/NoteSkin.lua`) && etternaFiles.includes(`${s}/metrics.ini`)));
  // Extract both for the loader checks.
  for (const [archive, dir] of [[quaver.path, join(out, "quaver")], [etterna.path, join(out, "etterna")]]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    spawnSync("unzip", ["-q", archive, "-d", dir]);
  }
  const pngs = [...qs.filter((p) => p.endsWith(".png")).map((p) => join(out, "quaver", p)), ...etternaFiles.filter((p) => p.endsWith(".png")).map((p) => join(out, "etterna", p))];
  const notPng = pngs.filter((p) => !readFileSync(p).subarray(0, 4).equals(PNG));
  check("Every exported image is a PNG", !notPng.length && pngs.length > 100, `${pngs.length} images${notPng.length ? `; not PNG: ${notPng.join(", ")}` : ""}`);
  const untouched = spawnSync("diff", ["-rq", join(opt.skins!, opt.skin!), join(SKINS, opt.skin!)], { encoding: "utf8" });
  check("The skin copy is unchanged", untouched.status === 0, untouched.stdout.slice(0, 300));
  check("No page errors", !pageErrors.length, pageErrors.join("; "));
  const processes = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).map((p) => {
    try {
      return readFileSync(`/proc/${p}/comm`, "utf8").trim();
    } catch {
      return "";
    }
  });
  check("No osu! or lazer process visible to the test vosu", !processes.some((c) => /^(osu!?(\.exe)?|lazer)$/i.test(c) || /^osu-/.test(c)), `${processes.length} processes`);
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
