#!/usr/bin/env bun
// Deterministic Keymodes number-input redraw regression on a real copied skin.
// Runs headless in private network/PID/IPC namespaces with isolated HOME/XDG
// directories, no GPU nodes, and the live osu!/runtime paths masked.
//
// bun tools/skin-studio/web/e2e/width-input.e2e.ts --vosu <vosu binary> \
//   --playwright <playwright/index.mjs> --skins <skins folder> \
//   --skin "Arturia (sxlvia mania+taiko)" --out <evidence dir>
//
// Build first: `cargo build -p vosu-skin-studio` and `bun run build` in
// tools/skin-studio/web. The skins are copied; the originals are only read.
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
    skin: { type: "string" },
    out: { type: "string" },
  },
});
for (const name of ["vosu", "playwright", "skins", "skin", "out"] as const)
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
const cache = join(homedir(), ".cache/vosu-agents/WidthWhitespace");
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
cpSync(join(opt.skins!, opt.skin!), join(SKINS, opt.skin!), { recursive: true });
spawnSync("chmod", ["-R", "a-w", SKINS]);
const SERVER = 26950, DASHBOARD = 26951;
mkdirSync(join(env.XDG_CONFIG_HOME, "vosu"), { recursive: true });
writeFileSync(join(env.XDG_CONFIG_HOME, "vosu/vosu.toml"), [
  "ENABLE_AUTOUPDATE = false", "OPEN_DASHBOARD_ON_STARTUP = false", "START_AT_LOGIN = false",
  'SERVER_IP = "127.0.0.1"', `SERVER_PORT = ${SERVER}`, 'DASHBOARD_IP = "127.0.0.1"', `DASHBOARD_PORT = ${DASHBOARD}`,
  `STATIC_FOLDER_PATH = "${join(LAB, "static")}"`, "",
].join("\n"));
mkdirSync(join(LAB, "static"));
const daemonLog: string[] = [];
const daemon = spawn(resolve(opt.vosu!), ["--update=false", "--tool", join(ROOT,"tools/skin-studio")], { cwd: LAB, env, stdio: ["ignore", "pipe", "pipe"] });
daemon.stdout.on("data", (c) => daemonLog.push(String(c)));
daemon.stderr.on("data", (c) => daemonLog.push(String(c)));

const sleep = (ms: number) => Bun.sleep(ms);
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
let closeBrowser: (() => Promise<void>) | undefined;
let captureFailure: (() => Promise<unknown>) | undefined;
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

  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  closeBrowser = () => browser.close();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  captureFailure = () => page.screenshot({ path: join(out, "failure.png") });
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("dialog", (dialog: { accept(): Promise<void> }) => dialog.accept());
  await page.goto(await launch("dark"));
  await page.waitForSelector("#skins .skin");
  const shot = (name: string, opts: object = {}) => page.screenshot({ path: join(out, `${name}.png`), ...opts });

  await page.locator("#skins .skin", { hasText: opt.skin! }).click();
  await page.click("#use-base");
  await page.click("#tab-keymodes");
  await page.waitForSelector("#km-counts .km-count");
  const pick = async (keys: number) => {
    await page.locator("#km-counts .km-count", { hasText: new RegExp(`^.*${keys}K`) }).first().click();
    await page.waitForSelector(`#km-grid .km-colhead`);
    await page.waitForTimeout(1500);
  };

  // Trigger the real synchronous refresh without a pointer click stealing focus.
  // The first case interrupts fill's focus/select/insert sequence; the second
  // refreshes after selecting unfinished text, before typing its replacement.
  const original=await page.evaluate(()=>JSON.parse(localStorage.getItem('skin-studio:recipe')??'{}'));
  original.keymodes={'7':{images:{},values:{ColumnWidth:Array(7).fill(60).join(',')},keepProportions:false}};
  for(const partial of [false,true]) {
    await page.evaluate(r=>localStorage.setItem('skin-studio:recipe',JSON.stringify(r)),original);
    const fresh=new URL(await launch('dark'));fresh.searchParams.set('redraw',String(partial));await page.goto(fresh.href);await page.click('#tab-keymodes');await pick(7);
    const field=page.locator('#km-grid input[aria-label="Column 3 width"]');
    if(partial) {
      await field.fill('7');await field.evaluate((input: HTMLInputElement)=>input.select());
      await page.evaluate(()=>{
        const input=document.activeElement;
        document.querySelector<HTMLButtonElement>('#tab-keymodes')!.click();
        Reflect.set(window,'widthInputRedraw',{redraws:1,connected:input?.isConnected,sameInput:document.activeElement===input});
      });
      await page.keyboard.insertText('75');
    } else {
      await page.evaluate(()=>{
        const state={redraws:0,connected:false,sameInput:false};
        Reflect.set(window,'widthInputRedraw',state);
        const redraw=(event:FocusEvent)=>{
          const input=event.target;
          if(!(input instanceof HTMLInputElement)||input.getAttribute('aria-label')!=='Column 3 width')return;
          document.removeEventListener('focusin',redraw);
          state.redraws++;
          document.querySelector<HTMLButtonElement>('#tab-keymodes')!.click();
          state.connected=input.isConnected;state.sameInput=document.activeElement===input;
        };
        document.addEventListener('focusin',redraw);
      });
    }
    if(!partial)await field.fill('75');await field.press('Tab');
    await until(async()=>!(await field.isDisabled()),'width editable');await page.waitForTimeout(800);
    const after=await page.evaluate(()=>JSON.parse(localStorage.getItem('skin-studio:recipe')??'{}'));
    const observed=await page.evaluate(()=>Reflect.get(window,'widthInputRedraw'));
    const value=after.keymodes?.['7']?.values?.ColumnWidth?.split(',')[2];
    check((partial?'Partial text':'Unchanged selected value')+': redraw ran during fill',observed.redraws===1,JSON.stringify(observed));
    check((partial?'Partial text':'Unchanged selected value')+': the actual focused number input survives redraw',observed.connected&&observed.sameInput,JSON.stringify(observed));
    check((partial?'Partial text':'Unchanged selected value')+': fill then Tab replaces with 75, never concatenates',value==='75'&&await field.inputValue()==='75',JSON.stringify({stored:value,shown:await field.inputValue()}));
    writeFileSync(join(out,(partial?'partial':'selected')+'.json'),JSON.stringify({observed,after},null,2));await shot(partial?'partial':'selected');
    await page.click('#km-undo');await page.waitForTimeout(800);
    const undone=await page.evaluate(()=>JSON.parse(localStorage.getItem('skin-studio:recipe')??'{}').keymodes?.['7']?.values?.ColumnWidth);
    check((partial?'Partial text':'Unchanged selected value')+': one Undo restores 60',undone?.split(',')[2]==='60',undone);
  }
  await page.evaluate(() => {
    const grid = document.querySelector("#km-grid")!;
    const state = { count: 0 };
    Reflect.set(window, "publicationRedraws", state);
    new MutationObserver((records) => { state.count += records.filter((record) => record.type === "childList").length; }).observe(grid, { childList: true });
  });
  const publishedWidth = page.locator('#km-grid input[aria-label="Column 1 width"]');
  await publishedWidth.fill("61");
  await publishedWidth.press("Tab");
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem("skin-studio:recipe") ?? "{}").keymodes?.["7"]?.values?.ColumnWidth?.split(",")[0] === "61"), "programmatic width published");
  const synchronous = await page.evaluate(() => Reflect.get(window, "publicationRedraws").count);
  await page.waitForTimeout(650);
  const settled = await page.evaluate(() => Reflect.get(window, "publicationRedraws").count);
  check("Programmatic composition publishes once without a delayed hand-edit redraw", synchronous > 0 && settled === synchronous, JSON.stringify({ synchronous, settled }));
  check('No page errors',!pageErrors.length,pageErrors.join(' | '));
} catch(error) {
  check('run',false,error instanceof Error?error.stack:String(error));
  await captureFailure?.().catch(()=>{});
} finally {
  writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));
  writeFileSync(join(out,'daemon.log'),daemonLog.join(''));
  await closeBrowser?.();
  daemon.kill();
  spawnSync("chmod", ["-R", "u+w", LAB]);
  rmSync(LAB, { recursive: true, force: true });
}
process.exit(results.every(r=>r.ok)?0:1);
