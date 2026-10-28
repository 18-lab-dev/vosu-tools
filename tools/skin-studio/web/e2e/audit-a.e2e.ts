#!/usr/bin/env bun
// Read-only real-skin sources plus a disposable writable target for save/apply race audits.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(process.env.SKIN_STUDIO_ROOT ?? join(import.meta.dir, "../../../.."));
const { values: opt } = parseArgs({
  options: {
    vosu: { type: "string" },
    playwright: { type: "string" },
    skins: { type: "string" },
    skin: { type: "string" },
    other: { type: "string" },
    out: { type: "string" },
    scenario: { type: "string" },
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
const LAB = mkdtempSync(join(out, "lab-"));
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
spawnSync("chmod", ["-R", "a-w", EDITED]);
const TARGET = join(SKINS, "Audit Target");
cpSync(EDITED, TARGET, { recursive: true });
spawnSync("chmod", ["-R", "u+w", TARGET]);
spawnSync("chmod", ["-R", "a-w", join(SKINS, opt.other!)]);
const SERVER = 26070, DASHBOARD = 26071;
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
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
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
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
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
  const failures: string[] = [];
  const heldCleanups: (() => Promise<void>)[] = [];
  const scenario = async (name: string, action: () => Promise<void>) => {
    if (opt.scenario && !opt.scenario.split(",").includes(name)) return;
    writeFileSync(join(out, "current-scenario.json"), JSON.stringify({ name, state: "started" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([action(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Scenario deadline: ${name}`)), 45000); })]);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
      await page.screenshot({ path: join(out, `${name}-error.png`), timeout: 5000 }).catch(() => {});
      writeFileSync(join(out, `${name}-error.txt`), await page.locator("body").innerText({ timeout: 5000 }).catch(String));
    } finally {
      clearTimeout(timer);
      for (const cleanup of heldCleanups.splice(0)) await cleanup();
    }
  };
  const reset = async () => {
    const origin = new URL(page.url()).origin;
    // Launch URLs differ only in their fragment; goto alone can keep the
    // old document, in-memory recipe and consumed session alive.
    await page.goto("about:blank");
    // Clear storage after the old page is gone, so its pending timers cannot
    // repopulate a supposedly clean scenario.
    const storage = await context.newCDPSession(page);
    await storage.send("Storage.clearDataForOrigin", { origin, storageTypes: "local_storage" });
    await storage.detach();
    await page.goto(await launch("dark"));
    await page.waitForSelector("#skins .skin");
  };
  const pick = async (name: string) => {
    await page.locator("#skins .skin", { hasText: name }).click();
    await until(async () => (await page.locator("#focus-name").textContent()) === name, `focus ${name}`);
    await until(async () => !(await page.locator("#focus-osk").isDisabled()), `loaded source ${name}`);
    await page.waitForTimeout(250);
  };
  const plan = async (name: string) => {
    const pending = page.waitForEvent("download", { timeout: 30000 });
    await page.click("#mix-more > summary"); await page.click("#mix-plan");
    const item = await pending;
    const file = join(out, `${name}.json`);
    await item.saveAs(file);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const editText = async (text: string, focus = false) => {
    await page.click("#tab-ini");
    await page.click(focus ? "#ini-focus" : "#ini-mix");
    await page.waitForSelector("#editor .monaco-editor", { timeout: 10000 });
    const input = page.locator("#editor textarea").first();
    await input.focus();
    await page.keyboard.press("Control+a");
    // Input.insertText is keyboard typing in Monaco: it applies each character
    // separately. A full ini fixture must use the user's bulk-paste path.
    await page.evaluate((value: string) => navigator.clipboard.writeText(value), text);
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
  };
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:recipe") ?? "{}"));
  const group = (name: string) => page.locator("#groups .group").filter({ has: page.locator("h3", { hasText: new RegExp(`^${name}`) }) }).first();

  // Delays are response barriers around the real service, never mock data.
  const hold = async (pattern: string, matches = (_route: any) => true) => {
    const pending = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    let first = true;
    const handler = async (route: any) => {
      if (!matches(route)) return route.continue();
      const response = await route.fetch();
      first = false;
      await pending.promise;
      await route.fulfill({ response });
      finished.resolve();
    };
    await page.route(pattern, handler);
    heldCleanups.push(async () => { pending.resolve(); await page.unroute(pattern, handler); });
    return { get ready() { return until(() => !first, `response barrier ${pattern}`, 15000); }, release: async () => { pending.resolve(); await finished.promise; await page.unroute(pattern, handler); await page.waitForTimeout(300); } };
  };
  const editorText = async () => {
    // Monaco virtualizes visible lines; native Copy reads the whole model,
    // not a viewport-dependent fragment or a production test hook.
    await page.locator("#editor textarea").first().focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press("ArrowRight");
    return text.replace(/\r\n/g, "\n");
  };

  await scenario("editor-typing-latency", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    const text = readFileSync(join(opt.skins!, opt.skin!, "skin.ini"), "utf8");
    await editText(text);
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const metrics = { frames: [] as number[], events: [] as number[], longTasks: [] as number[], keys: [] as number[], repeats: 0 };
      const observers = [
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration); }),
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.name === "keydown") metrics.events.push(entry.duration); }),
      ];
      observers[0].observe({ type: "longtask" });
      observers[1].observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
      const listener = (event: KeyboardEvent) => {
        if (event.key.length !== 1) return;
        const start = performance.now();
        metrics.keys.push(start);
        if (event.repeat) metrics.repeats++;
        // The second rAF follows the first frame's paint: a conservative
        // input-to-paint proxy alongside native EventTiming durations.
        requestAnimationFrame(() => requestAnimationFrame(() => metrics.frames.push(performance.now() - start)));
      };
      document.querySelector("#editor")!.addEventListener("keydown", listener as EventListener, true);
      (globalThis as any).finishTypingMetrics = () => {
        observers.forEach(observer => observer.disconnect());
        document.querySelector("#editor")!.removeEventListener("keydown", listener as EventListener, true);
        return metrics;
      };
    });
    const normal = "abcdefghijklmnopqrstuvwxyz", cadence = 80;
    let next = performance.now();
    for (const character of normal) {
      await sleep(Math.max(0, next - performance.now()));
      await page.keyboard.press(character);
      next += cadence;
    }
    for (let index = 0; index < normal.length; index++) {
      await sleep(Math.max(0, next - performance.now()));
      await page.keyboard.down("x");
      next += cadence;
    }
    await page.keyboard.up("x");
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(() => (globalThis as any).finishTypingMetrics());
    const summary = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return { count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) };
    };
    const report = { lines: text.split(/\r?\n/).length, keystrokes: normal.length * 2, requestedCharactersPerSecond: 1000 / cadence, actualCharactersPerSecond: (metrics.keys.length - 1) * 1000 / (metrics.keys.at(-1) - metrics.keys[0]), inputToPaintProxyMs: summary(metrics.frames), eventTimingMs: summary(metrics.events), longTasks: summary(metrics.longTasks), raw: metrics };
    writeFileSync(join(out, "typing-latency.json"), JSON.stringify(report, null, 2));
    check("Normal typing and held-key repeat preserve every character", (await state()).ini.includes(normal + "x".repeat(normal.length)), JSON.stringify({ lines: report.lines, cps: report.actualCharactersPerSecond, paintProxyP95: report.inputToPaintProxyMs.p95, eventTimingP95: report.eventTimingMs.p95, longTasks: report.longTasks.count }));
    check("Held-key input emits native repeat events", metrics.repeats === normal.length - 1, String(metrics.repeats));
    await editText(text.replace(/^NoteImage0:.*/m, "NoteImage0: definitely-missing-after-typing"));
    await page.keyboard.press("Control+f");
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("definitely-missing-after-typing");
    await page.keyboard.press("Escape");
    await until(async () => await page.locator("#editor .squiggly-warning").count() && (await page.locator("#diagnostics").textContent())!.includes("Missing image"), "idle path squiggle");
    check("A paused edit publishes the correct missing-path squiggle", true);
  });

  await scenario("empty-draft-text", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    const original = (await plan("empty-before")).ini;
    await editText(original);
    await page.keyboard.press("Control+a"); await page.keyboard.press("Backspace");
    await until(async () => (await state()).ini === "", "intentional empty draft persisted");
    check("Deleting the whole ini persists an intentionally empty draft", true);
    check("An empty hand edit is labelled without claiming no changes", (await page.locator("#mix-picks").textContent())!.includes("skin.ini edits"));
    check("Plan export preserves an intentionally empty ini", (await plan("empty-after")).ini === "");
    await page.click("#tab-keymodes");
    await until(async () => await page.locator("#km-counts .km-count").count() === 0, "empty ini has no source key-count fallback");
    check("Keymodes reads the empty ini rather than the base fallback", true);
    await page.click("#tab-ini"); await page.click("#ini-mix");
    await page.locator("#editor textarea").first().focus();
    await page.keyboard.press("Control+z");
    await until(async () => await editorText() === original.replace(/\r\n/g, "\n"), "empty ini undo");
    check("One native undo restores the entire deleted ini", true);
  });

  await scenario("upload-catalog-read-order", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    await page.click("#tab-keymodes");
    const drop = (name: string, color: string) => page.evaluate(async ({ name, color }: { name: string; color: string }) => {
      const canvas = new OffscreenCanvas(8, 8), context = canvas.getContext("2d")!;
      context.fillStyle = color; context.fillRect(0, 0, 8, 8);
      const data = new DataTransfer();
      data.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png" }));
      for (const type of ["dragenter", "dragover", "drop"])
        document.querySelector(".km-picker")!.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }, { name, color });
    await drop("catalog-first.png", "#ff0000");
    await until(async () => await page.locator("#mix-uploads-list li").count() === 1 && (await page.locator("#km-images").textContent())?.includes("catalog-first"), "first upload catalog settled");
    let reads = 0;
    const uploads = (url: string) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith("/v1/skin") && parsed.searchParams.get("skin") === "uploads:";
    };
    const barrier = await hold("**/api/v1/skin?*", (route) => uploads(route.request().url()) && ++reads === 2);
    const firstResponse = page.waitForResponse((response: any) => uploads(response.url()) && response.request().method() === "GET");
    const catalogRendered = page.evaluate(() => new Promise<void>(resolve => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(document.querySelector("#mix-uploads-list")!, { childList: true });
    }));
    await drop("catalog-second.png", "#0000ff");
    await barrier.ready;
    await (await firstResponse).finished();
    await catalogRendered;
    await barrier.release();
    await until(async () => await page.locator("#mix-uploads-list li").count() === 2, "winning upload snapshot publishes management catalog");
    check("Picker and management catalog share the winning upload snapshot", (await page.locator("#mix-uploads-list").textContent())!.includes("catalog-second.png"));
    await page.click("#mix-uploads-summary");
    await page.click("#mix-uploads-remove");
    await until(async () => await page.locator("#mix-uploads").isHidden(), "temporary upload fixture removed");
  });

  await scenario("save-source-context", async () => {
    await reset(); await pick("Audit Target");
    await editText("// SAVE_RACE_A\n" + readFileSync(join(TARGET, "skin.ini"), "utf8"), true);
    const barrier = await hold("**/api/v1/save");
    await page.click("#save"); await barrier.ready;
    await pick(opt.other!);
    const otherText = await editorText();
    await barrier.release();
    check("Save response leaves the newly selected document intact", await editorText() === otherText);
    await page.click("#use-base");
    const mixed = await plan("save-source-context");
    check("Save response never contaminates another source cache", !mixed.ini.includes("SAVE_RACE_A"));
  });

  await scenario("apply-preserves-newer-draft", async () => {
    await reset(); await pick("Audit Target"); await page.click("#use-base");
    await editText("// APPLY_BEFORE\n" + readFileSync(join(TARGET, "skin.ini"), "utf8"));
    await page.selectOption("#export-target", "apply");
    await until(async () => !(await page.locator("#export-run").isDisabled()), "apply enabled");
    const barrier = await hold("**/api/v1/apply");
    await page.click("#export-run"); await page.click("#apply-confirm"); await barrier.ready;
    const input = page.locator("#editor textarea").first();
    await input.focus(); await page.keyboard.press("Control+Home"); await page.keyboard.insertText("// NEWER_UNAPPLIED\n");
    await pick(opt.other!); await page.click("#tab-elements");
    await page.locator("#cats button", { hasText: /^Cursor & numbers$/ }).click();
    await group("Cursor").getByRole("button", { name: "Use this skin", exact: true }).click();
    await until(async () => (await state()).picks.cursor, "newer group pick");
    const before = await state();
    await barrier.release();
    await until(async () => (await page.locator("#mix-result").textContent())?.includes("Applied"), "apply response");
    check("Apply retains newer text and group picks", (await state()).ini?.includes("NEWER_UNAPPLIED") && JSON.stringify((await state()).picks) === JSON.stringify(before.picks));
    check("Newer edits were not included in the reviewed disk write", !readFileSync(join(TARGET, "skin.ini"), "utf8").includes("NEWER_UNAPPLIED"));
    check("Apply retains the draft history", !(await page.locator("#km-undo").isDisabled()));
    await page.click("#km-undo"); await page.waitForTimeout(300);
    check("Preserved history can undo the newer pick", !(await state()).picks.cursor && (await state()).ini?.includes("NEWER_UNAPPLIED"));
    await page.click("#km-redo"); await page.waitForTimeout(300);
    check("Preserved history can redo the newer pick", JSON.stringify((await state()).picks) === JSON.stringify(before.picks));
  });

  await scenario("same-key-focus-order", async () => {
    await reset(); await pick("Audit Target"); await page.click("#tab-ini"); await page.click("#ini-focus");
    let intercepted = false;
    const barrier = await hold("**/api/v1/skin?*", (route) => {
      if (intercepted || new URL(route.request().url()).searchParams.get("skin") !== TARGET) return false;
      intercepted = true; return true;
    });
    await page.click("#reload"); await barrier.ready;
    await page.locator("#editor textarea").first().focus();
    await page.keyboard.insertText("// NO_EDIT_DURING_LOAD\n");
    check("A pending source load cannot accept edits into the previous document", !(await editorText()).includes("NO_EDIT_DURING_LOAD"));
    writeFileSync(join(TARGET, "skin.ini"), "// NEWEST_A_SNAPSHOT\n" + readFileSync(join(TARGET, "skin.ini"), "utf8"));
    await pick(opt.other!); await pick("Audit Target");
    await until(async () => (await editorText()).includes("NEWEST_A_SNAPSHOT"), "new A snapshot");
    await barrier.release();
    check("Late A response cannot replace A after A -> B -> A", (await editorText()).includes("NEWEST_A_SNAPSHOT"));
    await page.click("#use-base");
    check("Late same-key response cannot regress the source cache", (await plan("same-key-order")).ini.includes("NEWEST_A_SNAPSHOT"));
  });

  await scenario("late-composition-and-plan", async () => {
    await reset(); await pick(opt.other!); await page.click("#use-base");
    await page.click("#tab-ini");
    const baseline = (await plan("late-baseline")).ini.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    await until(async () => await editorText() === baseline, "baseline editor composition");
    const barrier = await hold("**/api/v1/skin?*", (route) => new URL(route.request().url()).searchParams.get("skin") === TARGET);
    await page.locator("#skins .skin", { hasText: "Audit Target" }).click();
    await barrier.ready; await page.click("#use-base"); await page.waitForTimeout(250);
    const downloads: any[] = [];
    const receive = (item: any) => downloads.push(item);
    page.on("download", receive);
    await page.click("#mix-more > summary"); await page.click("#mix-plan"); await page.waitForTimeout(150);
    await pick(opt.other!); await page.click("#use-base"); await page.waitForTimeout(350);
    const newer = await editorText();
    await barrier.release();
    const after = await editorText();
    writeFileSync(join(out, "late-composition-buffers.json"), JSON.stringify({ baseline, newer, after }, null, 2));
    check("Late composition leaves the newer draft visible", after === newer && newer === baseline);
    check("A stale plan is rejected instead of exporting mixed snapshots", downloads.length === 0);
    page.off("download", receive);
  });

  await scenario("group-and-asset-after-manual-ini", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    const baseline = await plan("group-before");
    const manual = "// RETAIN_MY_COMMENT\n" + baseline.ini.replace(/Author:.*/, "Author: My hand edit");
    await editText(manual);
    writeFileSync(join(out, "manual-before-pick.json"), JSON.stringify({ manual, recipe: await state(), visible: await editorText() }, null, 2));
    check("Manual unrelated value exists before the pick", (await state()).ini?.includes("Author: My hand edit") === true);
    await pick(opt.other!); await page.click("#tab-elements");
    await page.locator("#cats button", { hasText: /^Mania$/ }).click();
    await group("7K stage").getByRole("button", { name: "Use this skin", exact: true }).click();
    await page.waitForTimeout(400);
    const picked = await plan("group-after");
    const staged = picked.sources.flatMap((source: any) => source.files.map((file: any) => typeof file === "string" ? file : file[1])).filter((file: string) => file.startsWith("mania/7k/"));
    check("Group updates image keys in an already hand-edited draft", staged.length > 0 && picked.ini.includes("mania/7k/"));
    check("Group preserves unrelated comments and manual values", picked.ini.includes("RETAIN_MY_COMMENT") && picked.ini.includes("Author: My hand edit"));
    await page.click("#km-undo"); await page.waitForTimeout(350);
    check("Undo restores exact pre-pick ini", (await plan("group-undo")).ini === manual.replace(/\r?\n/g, "\r\n"));
    await page.click("#km-redo"); await page.waitForTimeout(350);
    check("Redo restores exact post-pick plan", JSON.stringify(await plan("group-redo")) === JSON.stringify(picked));
    await page.click("#tab-explorer");
    await page.locator("#x-filter").fill("default");
    await until(async () => await page.locator("#x-list .x-row").count(), "font rows");
    const font = page.locator("#x-list .x-row").filter({ hasText: "glyphs" }).first();
    if (await font.count()) {
      const before = await plan("font-before");
      await font.click();
      await page.click("#x-use"); await page.waitForTimeout(350);
      const after = await plan("font-after");
      check("A single font pick carries its naming ini after manual edits", after.ini.includes("RETAIN_MY_COMMENT") && after.ini !== before.ini);
    } else throw new Error("Real alternate skin must provide its explicit default combo font");
  });

  await scenario("tab-aligned-box-selection", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    await editText("[Mania]\nKeys: 4\n\tNoteImage0: alpha\n    NoteImage1: alpha\n");
    const before = (await state()).ini;
    const first = await page.locator("#editor .view-line").filter({ hasText: "NoteImage0" }).evaluate((line: HTMLElement) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.textContent!.indexOf("NoteImage0");
        if (offset < 0) continue;
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y + rect.height / 2 };
      }
      throw new Error("No note token");
    });
    const last = await page.locator("#editor .view-line").filter({ hasText: "NoteImage1" }).boundingBox();
    await page.keyboard.down("Alt"); await page.mouse.move(first.x, first.y); await page.mouse.down();
    await page.mouse.move(first.x, last!.y + last!.height / 2, { steps: 8 }); await page.mouse.up(); await page.keyboard.up("Alt");
    check("Alt-box creates one cursor per visual row", await page.locator("#editor .cursor").count() === 2);
    await page.keyboard.insertText("X"); await page.keyboard.press("Escape");
    check("Zero-width Alt-box never deletes tab-aligned text", (await state()).ini.replace(/X/g, "") === before);
    await page.keyboard.press("Control+z"); await page.keyboard.press("Escape");
    check("One undo restores the box insertion", (await state()).ini === before);
  });

  await scenario("real-path-policy", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    const current = await plan("path-tree");
    const files: string[] = current.sources.flatMap((source: any) => source.files.map((file: any) => typeof file === "string" ? file : file[1]));
    const image = files.find((file) => /\/.*\.png$/i.test(file));
    if (!image) throw new Error("Real skin must provide a subfolder PNG");
    const stem = image.replace(/\.png$/i, "").replace(/@2x$/i, "");
    const hand = `[Mania]\nKeys: 4\nNoteImage0: ${stem.toUpperCase().replace(/\//g, "\\")}\n`;
    await editText(hand);
    await until(async () => (await page.locator("#issue-count").textContent()) === "0 errors · 0 warnings", "normalized path validation");
    check("Base publication preserves a hand-replaced ini exactly", (await state()).ini === hand.replace(/\r?\n/g, "\r\n"));
    writeFileSync(join(out, "path-validation-state.json"), JSON.stringify({ image, stem, recipe: await state(), diagnostics: await page.locator("#diagnostics").textContent() }, null, 2));
    check("Real PNG paths resolve across case, slash and HD spelling", !(await page.locator("#diagnostics").textContent())!.includes("Missing image"));
    const folder = stem.slice(0, stem.lastIndexOf("/") + 1);
    await editText(`[Mania]\nKeys: 4\nNoteImage0: ${folder.toUpperCase()}`);
    await page.keyboard.press("Control+Space");
    await until(async () => await page.locator(".suggest-widget:visible").count(), "case-normalized completion");
    check("Folder completion uses the real draft tree despite typed case", (await page.locator(".suggest-widget:visible").textContent())!.toLowerCase().includes(stem.slice(folder.length).replace(/-\d+$/, "").toLowerCase()));
    await page.keyboard.press("Escape");
    await reset(); await pick(opt.other!); await page.click("#use-base");
    const alternate = await plan("jpeg-tree");
    const jpeg = alternate.sources.flatMap((source: any) => source.files.map((file: any) => typeof file === "string" ? file : file[1])).find((file: string) => /\.jpe?g$/i.test(file));
    if (!jpeg) throw new Error("Alternate real skin must provide a JPEG-only image");
    const jpgStem = jpeg.replace(/\.jpe?g$/i, "");
    await editText(`[Mania]\nKeys: 4\nNoteImage0: ${jpgStem}\n`);
    await until(async () => (await page.locator("#diagnostics").textContent())!.includes("Missing image"), "JPEG-only path validation");
    check("JPEG-only files do not validate as PNG-backed mania fields", (await page.locator("#diagnostics").textContent())!.includes("Missing image"));
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("End"); await page.keyboard.press("Control+Space"); await page.waitForTimeout(250);
    check("JPEG-only fields do not receive a misleading file completion", !(await page.locator(".suggest-widget:visible").count()) || !(await page.locator(".suggest-widget:visible").textContent())!.includes(jpgStem));
    await page.keyboard.press("Escape");
  });

  await scenario("source-export-unsaved-text", async () => {
    await reset(); await pick("Audit Target");
    await editText("// UNSAVED_SOURCE_EDIT\n" + readFileSync(join(TARGET, "skin.ini"), "utf8"), true);
    check("Source export is explicitly labelled as edited", (await page.locator("#focus-osk").textContent())!.includes("edited"));
    const pending = page.waitForEvent("download", { timeout: 30000 }); await page.click("#focus-osk");
    const item = await pending, file = join(out, "edited-source.osk"); await item.saveAs(file);
    const archived = spawnSync("unzip", ["-p", file, "skin.ini"], { encoding: "utf8" });
    check("Source export includes unsaved selected-skin ini", archived.status === 0 && archived.stdout.includes("UNSAVED_SOURCE_EDIT"));
    check("Source export never saves its unsaved edits to disk", !readFileSync(join(TARGET, "skin.ini"), "utf8").includes("UNSAVED_SOURCE_EDIT"));
  });

  await scenario("uppercase-ini-full-path", async () => {
    await reset();
    const folder = join(LAB, "Case Folder");
    cpSync(EDITED, folder, { recursive: true }); spawnSync("chmod", ["-R", "u+w", folder]);
    renameSync(join(folder, "skin.ini"), join(folder, "SKIN.INI"));
    writeFileSync(join(folder, "SKIN.INI"), readFileSync(join(folder, "SKIN.INI"), "utf8").replace(/^Name:.*/m, "Name: Case Folder"));
    await page.click("#add-toggle"); await page.locator("#folder-path").fill(folder);
    await page.locator("#add-folder").evaluate((form: HTMLFormElement) => form.requestSubmit());
    const row = page.locator("#skins .skin", { hasText: "Case Folder" });
    await until(async () => await row.count() || (await page.locator("#folder-error").textContent())?.trim(), "case folder result", 10000);
    if (!(await row.count())) {
      check("Uppercase skin.ini is accepted as a skin folder", false, (await page.locator("#folder-error").textContent())!); return;
    }
    await row.click();
    await until(async () => (await page.locator("#focus-name").textContent()) === "Case Folder", "case folder selected");
    await until(async () => !(await page.locator("#focus-osk").isDisabled()), "case source loaded", 10000);
    await editText("// CASE_SAVE\n" + readFileSync(join(folder, "SKIN.INI"), "utf8"), true);
    await page.click("#save");
    await until(() => readFileSync(join(folder, "SKIN.INI"), "utf8").includes("CASE_SAVE"), "uppercase save", 10000);
    check("Uppercase skin.ini is discovered, read and saved in place", !existsSync(join(folder, "skin.ini")));
    await page.click("#use-base");
    await editText("// CASE_APPLY\n" + readFileSync(join(folder, "SKIN.INI"), "utf8"));
    await page.selectOption("#export-target", "apply");
    await until(async () => !(await page.locator("#export-run").isDisabled()), "uppercase apply");
    await page.click("#export-run"); await page.click("#apply-confirm");
    await until(() => readFileSync(join(folder, "SKIN.INI"), "utf8").includes("CASE_APPLY"), "uppercase apply complete");
    check("Apply preserves original ini case without a second file", !existsSync(join(folder, "skin.ini")));
  });

  await scenario("problems-drawer-and-screenshots", async () => {
    await reset(); await pick(opt.skin!); await page.click("#use-base");
    await page.click("#tab-ini");
    if (!(await page.locator("#ini-problems").count())) {
      check("Compact filterable Problems drawer exists", false);
      for (const theme of ["dark", "light"]) for (const [width, height] of [[1920, 1080], [1280, 720]]) {
        await page.setViewportSize({ width, height }); await page.evaluate((mode: string) => document.documentElement.dataset.theme = mode, theme);
        await page.waitForTimeout(250); await shot(`ini-before-${theme}-${width}x${height}`);
      }
      return;
    }
    // A persisted warning-only draft must start closed, even when its real
    // source ini contains an empty Mania header that is itself an error.
    await editText("[Mania]\nKeys: 4\nNoteImage0: definitely-missing\n");
    await page.goto("about:blank"); await page.goto(await launch("dark")); await page.waitForSelector("#skins .skin"); await page.click("#tab-ini");
    await page.waitForSelector("#editor .monaco-editor");
    check("Warning-only draft defaults to a compact Problems summary", await page.locator("#ini-problems").getAttribute("open") === null && (await page.locator("#issue-count").textContent())!.includes("warning"));
    check("Hand-edited-only drafts have a truthful compact label", (await page.locator("#mix-picks").textContent())!.trim() === "skin.ini edits");
    for (const theme of ["dark", "light"]) for (const [width, height] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width, height }); await page.evaluate((mode: string) => document.documentElement.dataset.theme = mode, theme);
      await page.waitForTimeout(250); await shot(`ini-collapsed-${theme}-${width}x${height}`);
    }
    await editText("[Mania]\nKeys: 4\nHitPosition: not-a-number\nNoteImage0: definitely-missing\n");
    check("Actionable errors automatically open Problems", await page.locator("#ini-problems").getAttribute("open") !== null);
    await page.selectOption("#problem-severity", "error");
    check("Severity filter hides warnings without removing editor diagnostics", await page.locator("#diagnostics .warning").count() === 0 && await page.locator("#diagnostics .error").count() > 0);
    await page.locator("#problem-filter").fill("not found");
    check("Problem text search reports no matches", (await page.locator("#diagnostics").textContent())!.includes("No matching"));
    await page.locator("#problem-filter").fill(""); await page.selectOption("#problem-severity", "all");
    await page.locator("#diagnostics .error button").first().click();
    check("Problems still navigate into the editor", await page.locator("#editor textarea").first().evaluate((input: HTMLElement) => document.activeElement === input));
    for (const theme of ["dark", "light"]) for (const [width, height] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((mode: string) => document.documentElement.dataset.theme = mode, theme);
      await page.waitForTimeout(250);
      const geometry = await page.locator("#editor").boundingBox();
      check(`Editor remains usable ${theme} ${width}x${height}`, !!geometry && geometry.width > width * .4 && geometry.height > height * .35);
      const filter = await page.locator("#problem-filter").boundingBox();
      check(`Problems filter remains usable ${theme} ${width}x${height}`, !!filter && filter.width >= 180);
      await shot(`ini-${theme}-${width}x${height}`);
    }
  });

  check("No uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  check("run", false, error instanceof Error ? error.stack : String(error));
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "daemon.log"), daemonLog.join(""));
  await browser?.close(); daemon.kill();
  spawnSync("chmod", ["-R", "u+w", LAB]); rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
