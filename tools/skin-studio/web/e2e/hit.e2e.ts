#!/usr/bin/env bun
// End-to-end check of hit position and hold-end calibration on a real skin
// and copies of real osu!stable plays, in an isolated vosu
// (`vosu --tool tools/skin-studio`): private network namespace, a /dev without
// GPU nodes (Chromium draws with SwiftShader), private /tmp, hidden
// /run/user and osu! folders, a temporary HOME with every XDG directory.
//
//   bun tools/skin-studio/web/e2e/hit.e2e.ts --vosu <vosu binary> \
//     --playwright <playwright/index.mjs> --skins <folder with skins> \
//     --skin "Arturia (sxlvia mania+taiko)" --play <osu! folder copy> --out <evidence dir>
//
// `--play` holds read-only copies: osu!.db, Songs/<folder>/<map>.osu,
// Data/r/<7K replay>.osr, and a 4K replay at its top level, which the run
// moves into Data/r (with a newer time) to make it the last play.
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
    skin: { type: "string" },
    play: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["vosu", "playwright", "skins", "skin", "play", "out"] as const)
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
const LAB = mkdtempSync(join(cache, "km-hit-"));
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: join(LAB, "home"), VOSU_PROCESS_EVENTS: "poll" };
for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) delete env[key];
for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"], ["XDG_RUNTIME_DIR", "runtime"]]) {
  env[key] = join(LAB, dir);
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
}
mkdirSync(env.HOME, { recursive: true });
const SKINS = join(LAB, "Skins");
cpSync(join(opt.skins!, opt.skin!), join(SKINS, opt.skin!), { recursive: true });
// The Skins folder's parent is the osu! folder (no client attached here).
for (const name of ["osu!.db", "Songs", "Data"]) cpSync(join(opt.play!, name), join(LAB, name), { recursive: true });
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
  // These checks build new skins (the Mix panel's New skin mode).
  await page.click("#mode-new");

  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) });
  const slot = (key: string) => page.locator(`#km-grid [data-key="${key}"]`).first();
  const label = async (key: string) => (await slot(key).getAttribute("aria-label")) ?? "";
  const hitValue = () => page.locator("#km-hit .km-hit__value").first().inputValue();
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`${keys}K`) }).first().click();
    await page.waitForTimeout(1500);
  };
  await page.locator("#skins .skin", { hasText: opt.skin! }).click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await page.waitForSelector("#km-counts .km-count");
  await pick(7);
  check("7K HitPosition from the skin", (await hitValue()) === "455");
  // No client attached: vosu reports no scroll speed, so it is typed in.
  const speedNote = await page.locator("#km-hit").textContent();
  check("Without a client, vosu reports no scroll speed (typed in)", speedNote?.includes("vosu reports no scroll speed") ?? false);
  await page.locator('#km-hit input[aria-label="Your osu!mania scroll speed"]').fill("24");
  await page.locator('#km-hit input[aria-label="Your osu!mania scroll speed"]').blur();
  await page.waitForTimeout(300);
  await shot("hit-7k-before");

  // ── Stepper: −5 moves the hit line and the receptors up 8 px (16 @2x) ──
  const before = await label("KeyImage0");
  await page.locator('#km-hit button[aria-label^="Raise the hit line"]').click();
  await until(async () => (await hitValue()) === "450", "HitPosition 450");
  const after = await label("KeyImage0");
  check("Stepper −5: HitPosition 455 → 450, receptors replaced by moved copies", after.includes("mania/7k/kd_left1") && after !== before, after);
  await page.keyboard.press("Control+z");
  await until(async () => (await hitValue()) === "455", "undo");
  check("Undo restores HitPosition and the original receptors", (await label("KeyImage0")) === before);
  await page.keyboard.press("Control+Shift+z");
  await until(async () => (await hitValue()) === "450", "redo");
  // Back to 455 by hand: the originals come back (no shift of a shift).
  await page.locator("#km-hit .km-hit__value").first().fill("455");
  await page.locator("#km-hit .km-hit__value").first().blur();
  await until(async () => (await hitValue()) === "455", "455 again");
  check("Typing the original HitPosition restores the original receptors", (await label("KeyImage0")) === before, await label("KeyImage0"));

  // ── Calibrate receptors from the last play (7K, osu!stable) ─────────────
  await page.click("#km-calibrate");
  await until(() => page.locator(".km-hit__play").count(), "proposal", 120000);
  const proposal = (await page.locator("#km-hit").textContent()) ?? "";
  check("Proposal names the last play, its key count and speed", /Last play: MYUKKE\. - FULi AUTO BUSTER \[Ignition x1\.1\], 7K, osu!stable \(Data\/r\/09be4f5b.*\), speed 24/.test(proposal), proposal.slice(proposal.indexOf("Last play"), proposal.indexOf("Last play") + 160));
  const press = /You pressed 6.5 ms early on average \(mean -6.5 ms ± [\d.]+ over 2,420 hits\) → receptors down 8 px so you press later \(HitPosition 455 → 460\)/.exec(proposal);
  check("Early presses correct down: 455 → 460 (deliberately reverses 0.4.x)", !!press, press?.[0] ?? proposal);
  check("Hit calibration alone does not propose LN changes", !(await page.locator("#km-hit").textContent())?.includes("You released") && await page.locator("#km-ln .km-hit__play").count() === 0);
  check("Play date is explicit and stale attempts are flagged", (await page.locator("#km-hit").textContent())?.includes("Older play:") ?? false);
  await page.click("#km-calibrate-ln");
  await until(() => page.locator("#km-ln .km-hit__play").count(), "independent LN proposal", 120000);
  check("Both calibrations read one play independently", (await page.locator("#km-ln .km-hit__play").textContent()) === (await page.locator("#km-hit .km-hit__play").textContent()));
  check("LN group has no press proposal", !(await page.locator("#km-ln").textContent())?.includes("You pressed"));
  const sevenReleases = (await page.locator("#km-ln").textContent()) ?? "";
  check("7K LN proposal reports used/excluded releases", /\d+ of \d+ hold releases used; \d+ excluded \(\d+ early, \d+ late\)/.test(sevenReleases), sevenReleases);
  await page.locator("#km-hit button", { hasText: "Apply to receptors" }).click();
  await until(async () => (await hitValue()) === "460", "calibrated 460");
  check("Applied: HitPosition 460", true);
  await shot("hit-7k-after");

  // ── Hold ends from a 4K play (made the newest replay) ────────────────────
  const replay = "92a540fc22102bc423daac8693030616-134285366675131726.osr";
  spawnSync("chmod", ["u+w", join(LAB, "Data/r")]);
  cpSync(join(opt.play!, replay), join(LAB, "Data/r", replay.replace("134285366675131726", "134357000000000000")));
  await pick(4);
  const before4 = await label("NoteImage0L");
  await page.click("#km-calibrate-ln");
  await until(() => page.locator("#km-ln .km-hit__play").filter({ hasText: "Sheriruth" }).count(), "4K proposal", 120000);
  const tails = (await page.locator("#km-ln").textContent()) ?? "";
  const release = /You released ([\d.]+) ms late on average \(mean \+?[\d.]+ ms ± [\d.]+ over ([\d,]+) holds\) → LNs [\d.]+ px shorter so you release earlier/.exec(tails);
  check("Rate mods: DT play judged in real ms; late releases shorten LNs", !!release && release[1] === "5.1" && release[2] === "424", release?.[0] ?? tails.slice(0, 300));
  check("4K LN proposal reports used/excluded releases", /\d+ of \d+ hold releases used; \d+ excluded \(\d+ early, \d+ late\)/.test(tails), tails);
  await shot("hit-4k-proposal");
  await page.locator("#km-ln button", { hasText: "Apply to hold tails" }).click();
  await until(async () => (await label("NoteImage0L")) !== before4, "hold ends applied");
  const state = (await page.locator("#km-state").textContent()) ?? "";
  check("Percy skin: late release correction moves body down 8 rows", state.includes("the body's end moves down 8 rows (late: shorter)"), state);
  await page.click("#km-undo");
  await until(async () => (await label("NoteImage0L")) === before4, "undo LN calibration");
  await page.click("#km-redo");
  await until(async () => (await label("NoteImage0L")) !== before4, "redo LN calibration");
  check("LN calibration undo and redo restore the whole change", true);
  check("7K stays calibrated; only 4K hold ends change", (await label("NoteImage0L")).includes("mania/4k/holdbody-50"));
  await pick(7);
  check("7K HitPosition unchanged by the 4K calibration", (await hitValue()) === "460");

  // ── Screenshots ───────────────────────────────────────────────────────────
  for (const theme of ["dark", "light"])
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      await page.evaluate((t: string) => (document.documentElement.dataset.theme = t), theme);
      await page.setViewportSize({ width: w, height: h });
      await page.locator("#km-hit").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await shot(`hit-${theme}-${w}x${h}`);
      const scroll = await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight);
      check(`No page scroll at ${w}x${h} (${theme})`, scroll <= 0, String(scroll));
      await pick(4);
      await page.evaluate(() => document.querySelector("#km-hit")!.closest("details")!.removeAttribute("open"));
      await page.locator("#km-ln").scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shot(`ln-${theme}-${w}x${h}`);
      await page.evaluate(() => document.querySelector("#km-hit")!.closest("details")!.setAttribute("open", ""));
      await pick(7);
    }
  await page.setViewportSize({ width: 1920, height: 1080 });

  // ── Export, read back ────────────────────────────────────────────────────
  const [download] = await Promise.all([page.waitForEvent("download"), (async () => {
    await page.selectOption("#export-target", "osk");
    await page.click("#export-run");
  })()]);
  const osk = join(out, "hit.osk");
  await download.saveAs(osk);
  const ini = spawnSync("unzip", ["-p", osk, "skin.ini"], { encoding: "utf8" }).stdout;
  writeFileSync(join(out, "hit-skin.ini"), ini);
  const block = (keys: number) => {
    const at = ini.search(new RegExp(`Keys: ${keys}\\r?\\n`));
    const rest = ini.slice(at);
    const end = rest.search(/\r?\n\[/);
    return Object.fromEntries(rest.slice(0, end < 0 ? undefined : end).split(/\r?\n/).map((l) => l.trim().split(/:\s*/)).filter((p) => p.length === 2));
  };
  const seven = block(7), four = block(4);
  check("Export: 7K HitPosition 460, receptors from mania/7k", seven.HitPosition === "460" && seven.KeyImage0 === "mania/7k/kd_left1" && seven.KeyImage0D === "mania/7k/kd_left", JSON.stringify({ hp: seven.HitPosition, k: seven.KeyImage0, kd: seven.KeyImage0D }));
  check("Export: 4K HitPosition untouched, body from mania/4k", four.HitPosition === "457" && four.NoteImage0L === "mania/4k/holdbody-50", JSON.stringify({ hp: four.HitPosition, l: four.NoteImage0L }));
  // Pixel check: early timing correction moves the receptors down 8/16 rows.
  const source = join(SKINS, opt.skin!, "mania/circles-7k");
  const pairs: [string, string, number][] = [
    ["kd_left1.png", "mania/7k/kd_left1.png", 8],
    ["kd_left1@2x.png", "mania/7k/kd_left1@2x.png", 16],
    ["kd_left@2x.png", "mania/7k/kd_left@2x.png", 16],
  ];
  for (const [from, to, rows] of pairs) {
    const a = readFileSync(join(source, from)).toString("base64");
    const b = spawnSync("unzip", ["-p", osk, to]).stdout.toString("base64");
    const result = await page.evaluate(async ([a, b, rows]: [string, string, number]) => {
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
      if (x.width !== y.width || x.height !== y.height) return `size ${x.width}x${x.height} → ${y.width}x${y.height}`;
      let bad = 0;
      for (let row = 0; row < y.height; row++) {
        const src = Math.max(0, row - rows);
        for (let col = 0; col < y.width; col++) if (y.data[(row * y.width + col) * 4 + 3] !== x.data[(src * x.width + col) * 4 + 3]) bad++;
      }
      return bad ? `${bad} alpha values differ` : "ok";
    }, [a, b, rows] as [string, string, number]);
    check(`Exported ${to}: the source moved down ${rows} rows, same canvas, edge clamp`, result === "ok", result);
  }
  // render-core draws the export like the screen.
  await page.click("#tab-elements");
  await page.click("#add-toggle");
  await page.fill("#folder-path", osk);
  await page.click('#add-folder button[type="submit"]');
  await page.waitForTimeout(1500);
  await page.click("#tab-keymodes");
  const mixStage = await page.locator("#km-stage").screenshot({ path: join(out, "hit-stage-mix.png") });
  await page.click("#mix-reset");
  await page.click("#tab-elements");
  await page.locator("#skins .skin", { hasText: /My mix/ }).last().click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await pick(7);
  await page.waitForTimeout(3000);
  const exportStage = await page.locator("#km-stage").screenshot({ path: join(out, "hit-stage-export.png") });
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
    if (x.width !== y.width || x.height !== y.height) return 1;
    let changed = 0;
    for (let i = 0; i < x.data.length; i += 4) if (Math.max(...[0, 1, 2].map((c) => Math.abs(x.data[i + c] - y.data[i + c]))) > 16) changed++;
    return changed / (x.data.length / 4);
  }, [mixStage.toString("base64"), exportStage.toString("base64")]);
  check("render-core draws the exported 7K like the calibrated draft", diff < 0.005, String(diff));

  // ── Keep proportions when changing column width ─────────────────────────
  const width = (c: number) => page.locator(`#km-grid input[aria-label="Column ${c} width"]`);
  const kmState = async () => (await page.locator("#km-state").textContent()) ?? "";
  const timings: number[] = [];
  // Service time of each derive request, to tell resampling from waiting
  // for the page's main thread (SwiftShader frames of the preview).
  const served: number[] = [];
  page.on("requestfinished", (request: any) => {
    if (request.url().includes("/v1/derive")) served.push(Math.round(request.timing().responseEnd));
  });
  const setWidth = async (c: number, value: number) => {
    await width(c).fill(String(value));
    await width(c).press("Tab");
    await until(async () => (await width(c).inputValue()) === String(value) && new RegExp(`^Set column ${c} width: kept proportions \\((\\d+) images in (\\d+) ms\\)`).test(await kmState()), `column ${c} width`, 60000).catch(async (error) => {
      throw new Error(`${error.message}: state "${await kmState()}", error "${await page.locator("#km-error").textContent()}", value ${await width(c).inputValue()}`);
    });
    timings.push(Number(/in (\d+) ms/.exec(await kmState())![1]));
  };
  const hp0 = Number(await hitValue());
  const w0 = Number(await width(1).inputValue());
  const key0 = await label("KeyImage0"), note0 = await label("NoteImage0"), note1 = await label("NoteImage1");
  await setWidth(1, w0 * 1.25);
  check("Keep proportions is on by default and says so the first time", (await page.locator("#km-keep").isChecked()) && (await kmState()).includes("Keep proportions when changing column width"), await kmState());
  check("One wider column: HitPosition stays (most columns keep their scale)", Number(await hitValue()) === hp0, String(await hitValue()));
  check("…its receptor and note are rescaled, the other columns' are not", (await label("KeyImage0")) !== key0 && (await label("NoteImage0")) !== note0 && (await label("NoteImage1")) === note1);
  await page.keyboard.press("Control+z");
  await until(async () => (await width(1).inputValue()) === String(w0), "width undo");
  check("One undo step restores the width and the images", (await label("KeyImage0")) === key0 && (await label("NoteImage0")) === note0);
  for (let c = 1; c <= 7; c++) await setWidth(c, w0 * 1.25);
  const hp1 = Math.round(480 - (480 - hp0) * 1.25);
  check(`Every column 1.25×: HitPosition = round(480 − (480 − ${hp0}) × 1.25) = ${hp1}`, Number(await hitValue()) === hp1, String(await hitValue()));
  check("Uniform widths keep notes as they are (the note height follows the narrowest column)", (await label("NoteImage1")) === note1);
  // Widening scales whole images: nothing is cut, so nothing is reported
  // (a repeated body's rows scale; the HitPosition it derives is reached by
  // the scaling, not a move inside the receptor images). A HitPosition
  // change after it moves only the keys and says nothing about bodies.
  const kmError = async () => ((await page.locator("#km-error").isVisible()) ? ((await page.locator("#km-error").textContent()) ?? "") : "");
  const widened = await kmError();
  check("Widening every column cuts nothing and reports nothing", widened === "", widened || "(none)");
  const bodies = await Promise.all(Array.from({ length: 7 }, (_, c) => label(`NoteImage${c}L`)));
  const hpBefore = await hitValue();
  await page.locator('#km-hit button[aria-label^="Raise the hit line"]').click();
  await until(async () => (await hitValue()) !== hpBefore, "hit position after widths", 30000);
  await page.waitForTimeout(500);
  const afterHit = await kmError();
  await page.locator("#km-error").scrollIntoViewIfNeeded().catch(() => undefined);
  await page.screenshot({ path: join(out, "hitpos-after-widths.png") });
  const bodiesAfter = await Promise.all(Array.from({ length: 7 }, (_, c) => label(`NoteImage${c}L`)));
  check("After a width change, a HitPosition change leaves the hold bodies alone and reports nothing", afterHit === "" && bodiesAfter.every((b, c) => b === bodies[c]), afterHit || "no message");
  await page.keyboard.press("Control+z");
  await until(async () => (await hitValue()) === hpBefore, "hit position undo", 30000);
  const first = timings[0],
    order = [...timings];
  timings.sort((a, b) => a - b);
  check("Time per width change (resample + store), ms", true, `in order ${order.join(", ")}; derive requests served in ${served.join(", ")} ms; first ${first}, median ${timings[timings.length >> 1]}, max ${timings.at(-1)} over ${timings.length}`);
  await page.locator("#export-target").selectOption("osk");
  const [download3] = await Promise.all([page.waitForEvent("download"), page.click("#export-run")]);
  const osk3 = join(out, "proportions.osk");
  await download3.saveAs(osk3);
  const ini3 = spawnSync("unzip", ["-p", osk3, "skin.ini"], { encoding: "utf8" }).stdout;
  writeFileSync(join(out, "proportions-skin.ini"), ini3);
  const at7 = ini3.search(/Keys: 7\r?\n/);
  const block7 = ini3.slice(at7, ini3.indexOf("[", at7));
  const value = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(block7)?.[1]?.trim() ?? "";
  const size = (file: string) => {
    const png = spawnSync("unzip", ["-p", osk3, file]).stdout;
    return png.length > 24 ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
  };
  const key2x = size(`${value("KeyImage0")}@2x.png`);
  check("Exported receptor @2x is 1.25× in both axes (192×347 → 240×434, plus the row or two the HitPosition rounding moves it up into)", key2x[0] === 240 && key2x[1] >= 434 && key2x[1] <= 436, `${value("KeyImage0")}@2x.png ${key2x.join("×")}`);
  check("Exported HitPosition and widths", value("HitPosition") === String(hp1) && value("ColumnWidth").split(",").every((w) => Number(w) === w0 * 1.25), `${value("HitPosition")} ${value("ColumnWidth")}`);
  // Exercise blocked states with the same real replay and a reduced map copy.
  await page.click("#km-calibrate-ln");
  await until(async () => (await page.locator("#km-ln").textContent())?.includes("Select 4K."), "LN key mismatch");
  check("LN key mismatch is explained in its own group", true);
  await page.click("#km-calibrate");
  await until(async () => (await page.locator("#km-hit").textContent())?.includes("Select 4K."), "hit key mismatch");
  check("Hit key mismatch is explained in its own group", true);
  await pick(4);
  let holdLimit = 0;
  let objectLimit = Infinity;
  await page.route("**/v1/plays/last", async (route: { fetch(): Promise<{ json(): Promise<{ osu: string }> }>; fulfill(options: { response: unknown; json: unknown }): Promise<void> }) => {
    const response = await route.fetch();
    const play = await response.json();
    const [header, objects] = play.osu.split("[HitObjects]");
    let holds = 0;
    play.osu = header + "[HitObjects]" + objects.split("\n").slice(0, objectLimit).map((line: string) => {
      const fields = line.trim().split(",");
      if (fields.length < 6 || !(Number(fields[3]) & 128)) return line;
      if (holds++ < holdLimit) return line;
      fields[3] = String((Number(fields[3]) & ~128) | 1);
      fields[5] = "0:0:0:0:";
      return fields.join(",");
    }).join("\n");
    await route.fulfill({ response, json: play });
  });
  await page.click("#km-calibrate-ln");
  await until(async () => (await page.locator("#km-ln").textContent())?.includes("no released holds"), "no holds");
  check("No holds explains why LN calibration is blocked", await page.locator("#km-ln button", { hasText: "Apply to hold tails" }).count() === 0);
  holdLimit = 10;
  await page.click("#km-calibrate-ln");
  await until(async () => (await page.locator("#km-ln").textContent())?.includes("at least 50"), "few releases");
  check("Too few releases explains why LN calibration is blocked", await page.locator("#km-ln button", { hasText: "Apply to hold tails" }).count() === 0);
  objectLimit = 10;
  await page.click("#km-calibrate");
  await until(async () => (await page.locator("#km-hit").textContent())?.includes("at least 50"), "few presses");
  check("Too few presses blocks only the hit-position proposal", await page.locator("#km-hit button", { hasText: "Apply to receptors" }).count() === 0);
  await page.unroute("**/v1/plays/last");
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

