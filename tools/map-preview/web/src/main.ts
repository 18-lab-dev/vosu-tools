import { vosu } from "/tools/_host/v1/bridge.js";
import {
  parseOsu,
  parseSkinIni,
  type Beatmap,
  type Mod,
} from "@vosu-tools/osu-parse";
import {
  builtinSkin,
  createRenderer,
  loadSkin,
  withFallback,
  type BuiltinSkinName,
  type RenderOptions,
  type Renderer,
  type Skin,
} from "@vosu-tools/render-core";
import {
  LiveClock,
  emptyState,
  followGame,
  hiddenForGameplay,
  type GameState,
  type LiveStatus,
} from "./live";
import { openOsk } from "./osk";
import {
  defaultSettings,
  readSettings,
  type PreviewSettings,
} from "./settings";
import { hostSkinFiles, readCurrentSkin } from "./skin-source";
import "./style.css";

// The tool owns its look; the dashboard's mode is only a hint.
const applyScheme = () => {
  document.documentElement.dataset.scheme =
    vosu.colorScheme ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
};
applyScheme();

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("playfield"),
  stage = $("stage"),
  status = $("status"),
  hiddenState = $("hidden-state"),
  followButton = $<HTMLButtonElement>("follow"),
  followStatus = $("follow-status"),
  timeOutput = $<HTMLOutputElement>("time"),
  progress = $("progress"),
  progressFill = $("progress-fill"),
  transport = $("transport"),
  play = $<HTMLButtonElement>("play"),
  seek = $<HTMLInputElement>("seek"),
  rate = $<HTMLInputElement>("rate"),
  drawer = $("controls"),
  controlsToggle = $<HTMLButtonElement>("controls-toggle"),
  skinPanel = $("skin-panel"),
  skinName = $("skin-name"),
  skinSource = $("skin-source"),
  skinMessage = $("skin-message"),
  builtinSelect = $<HTMLSelectElement>("builtin-skin"),
  scrollInput = $<HTMLInputElement>("scroll"),
  noteSpeedInput = $<HTMLInputElement>("note-speed"),
  modInputs = [...document.querySelectorAll<HTMLInputElement>("#mods input")],
  overrideInputs = ["seed", "ar", "cs"].map((id) => $<HTMLInputElement>(id)),
  audio = new Audio();

let renderer: Renderer | undefined,
  rendererReady: Promise<Renderer> | undefined,
  map: Beatmap | undefined,
  mapKey = "",
  sceneKey = "",
  loadSequence = 0,
  skinSequence = 0,
  selectedSkin: Skin | undefined,
  ownedBitmaps: ImageBitmap[] = [],
  skinChoice: "client" | "user" | BuiltinSkinName = "client",
  clientSkinKey = "",
  settings: PreviewSettings = { ...defaultSettings },
  following = true,
  objectUrl: string | undefined,
  manualTime = 0,
  game: GameState = emptyState(),
  liveStatus: LiveStatus = "connecting",
  hidden = false;
const clock = new LiveClock(),
  builtins = new Map<BuiltinSkinName, Skin>();

/* ------------------------------------------------------------ helpers */

const builtin = (name: BuiltinSkinName) => {
  let skin = builtins.get(name);
  if (!skin) builtins.set(name, (skin = builtinSkin(name)));
  return skin;
};
const formatTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  return `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
};
function showError(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function skinNotice(
  message: string,
  tone: "info" | "notice" | "error" = "info",
) {
  skinMessage.textContent = message;
  skinMessage.dataset.tone = tone;
}
const stateNames: Record<number, string> = {
  0: "main menu",
  1: "editor",
  2: "gameplay",
  4: "editor song select",
  5: "song select",
  7: "results",
  11: "multiplayer lobby",
  12: "multiplayer room",
  13: "multiplayer song select",
  22: "tourney",
};

/* ------------------------------------------------------------ renderer */

function ensureRenderer(): Promise<Renderer> {
  rendererReady ??= createRenderer({
    canvas,
    skin: selectedSkin,
    presentation:
      new URLSearchParams(location.search).get("presentation") === "bitmap"
        ? "bitmap"
        : "direct",
  }).then(
    (created) => {
      renderer = created;
      // A skin installed while the renderer was being created must still reach it.
      created.setSkin(selectedSkin);
      resize();
      return created;
    },
    (error: unknown) => {
      // A later attempt (next map) may succeed, e.g. after a GPU reset.
      rendererReady = undefined;
      throw new Error(
        `Map preview needs WebGPU, which this browser could not start (${error instanceof Error ? error.message : String(error)}). Use a current Chrome, Edge or Firefox with hardware acceleration on.`,
      );
    },
  );
  return rendererReady;
}
function resize(): void {
  const scale = Math.min(window.devicePixelRatio || 1, 2),
    width = Math.max(1, Math.round(stage.clientWidth * scale)),
    height = Math.max(1, Math.round(stage.clientHeight * scale));
  if (renderer) renderer.resize(width, height);
  else {
    canvas.width = width;
    canvas.height = height;
  }
  sceneKey = "";
}
new ResizeObserver(resize).observe(stage);

/** Everything that changes the compiled scene. */
function renderOptions(): RenderOptions {
  const manualMods: Mod[] = modInputs
    .filter((input) => input.checked)
    .map((input) => ({
      acronym: input.value,
      settings:
        input.value === "RD"
          ? { seed: Number(overrideInputs[0].value) }
          : undefined,
    }));
  // Constant Speed (mania "CS") would remove scroll velocity changes, so the
  // preview never applies it. Random without a client-chosen seed cannot match
  // the client and is left out rather than shown with an invented seed.
  const liveMods: Mod[] = game.mods
    .filter(
      (mod) =>
        mod.acronym.toUpperCase() !== "CS" &&
        !(mod.acronym.toUpperCase() === "RD" && mod.settings?.seed == null),
    )
    .map((mod) => ({ acronym: mod.acronym, settings: mod.settings }));
  const scroll =
    Number(scrollInput.value) ||
    settings.maniaScrollSpeed ||
    game.mania.scrollSpeed ||
    20;
  const [, arInput, csInput] = overrideInputs;
  return {
    mods: following ? liveMods : manualMods,
    ar: !following && arInput.value !== "" ? Number(arInput.value) : undefined,
    cs: !following && csInput.value !== "" ? Number(csInput.value) : undefined,
    scrollSpeed: scroll,
    noteSpeed: Number(noteSpeedInput.value) || settings.noteSpeed,
    maniaScrollUp: game.mania.scrollUp,
    hitLighting: game.visual.hitLighting ?? undefined,
    beatmapColours: game.visual.beatmapColours ?? undefined,
    snakingIn: game.visual.snakingIn ?? undefined,
  };
}
function refreshScene(force = false): void {
  if (!renderer || !map) return;
  const options = renderOptions(),
    key = JSON.stringify(options);
  if (!force && key === sceneKey) return;
  sceneKey = key;
  try {
    renderer.setBeatmap(map, options);
  } catch (error) {
    showError(error);
  }
}

function currentTime(): number {
  if (following) return clock.read(performance.now()) ?? 0;
  return audio.readyState ? audio.currentTime * 1000 : manualTime;
}
function tick(): void {
  requestAnimationFrame(tick);
  if (hidden || !renderer || !map) return;
  refreshScene();
  const now = currentTime();
  try {
    renderer.renderAt(now);
  } catch (error) {
    showError(error);
    return;
  }
  timeOutput.value = formatTime(now);
  const duration = Math.max(1, map.duration);
  progressFill.style.transform = `scaleX(${Math.min(1, Math.max(0, now / duration))})`;
  if (!following && document.activeElement !== seek) seek.value = String(now);
}
requestAnimationFrame(tick);

/* ------------------------------------------------------------ beatmap */

async function openMap(text: string, label: string): Promise<void> {
  const parsed = parseOsu(text);
  if (!parsed.objects.length)
    throw new Error("This beatmap contains no hit objects.");
  await ensureRenderer();
  map = parsed;
  overrideInputs[2].max = map.mode === 3 ? "18" : "11";
  overrideInputs[2].step = map.mode === 3 ? "1" : "0.1";
  refreshScene(true);
  seek.max = String(map.duration + 2000);
  $("title").textContent =
    `${map.metadata.Artist ?? ""} — ${map.metadata.Title ?? "Untitled"}`;
  $("detail").textContent =
    `[${map.metadata.Version ?? ""}] ${map.metadata.Creator ?? ""} · ${map.objects.length.toLocaleString()} objects · ${label}`;
  const mode = $("mode");
  mode.textContent = ["osu!", "taiko", "catch", "mania"][map.mode];
  mode.dataset.mode = String(map.mode);
  updateFollowNotice();
}
/** Loads the game's selected map when it changes. */
async function followMap(force = false): Promise<void> {
  const key = game.checksum ?? "";
  if (!force && key === mapKey) return;
  mapKey = key;
  const seq = ++loadSequence;
  if (!key && !force) return;
  status.textContent = "Loading the selected beatmap…";
  try {
    const response = await fetch("/files/beatmap/file", { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        `vosu has no selected beatmap file (${response.status}). Pick a map in osu!, or open an .osu file.`,
      );
    const text = await response.text();
    if (seq !== loadSequence || !following) return;
    status.textContent = "";
    await openMap(text, "from the game");
  } catch (error) {
    if (seq === loadSequence) showError(error);
  }
}
let followNotice = "";
/** Explains where following the game cannot match the client exactly. */
function updateFollowNotice(): void {
  if (!map) return;
  const notes: string[] = [];
  const selected = game.selectedMode;
  if (following && map.mode === 0 && selected !== null && selected !== 0)
    notes.push(
      `The client converts this map to ${["osu!", "taiko", "catch", "mania"][selected]}; the preview shows the original osu! map.`,
    );
  if (
    following &&
    game.mods.some(
      (mod) => mod.acronym.toUpperCase() === "RD" && mod.settings?.seed == null,
    )
  )
    notes.push(
      "Random is selected but the client has not chosen its seed yet, so notes are shown unshuffled.",
    );
  const next = notes.join(" ");
  if (next) status.textContent = next;
  else if (followNotice && status.textContent === followNotice)
    status.textContent = "";
  followNotice = next;
}

/* ------------------------------------------------------------ follow / manual */

function setFollowing(next: boolean): void {
  following = next;
  followButton.setAttribute("aria-pressed", String(next));
  transport.hidden = next;
  progress.hidden = !next || !settings.showProgress;
  for (const input of [...modInputs, ...overrideInputs]) input.disabled = next;
  $("mods-note").textContent = next
    ? "Following the game: the client's selected mods apply."
    : "Manual preview: choose mods here.";
  if (next) {
    audio.pause();
    status.textContent = "";
    void followMap(true);
  }
  sceneKey = "";
  updateStatusChip();
}
function updateStatusChip(): void {
  let text: string,
    state: string = liveStatus;
  if (!following) {
    text = "Manual preview";
    state = "manual";
  } else if (liveStatus === "connecting") text = "Connecting to vosu…";
  else if (liveStatus === "lost") text = "vosu disconnected · retrying";
  else if (liveStatus === "waiting" || !game.client)
    text = "vosu connected · no game";
  else {
    const where =
      game.state === 2 && game.source && game.source !== "player"
        ? game.source === "autoplay"
          ? "autoplay"
          : "watching a replay"
        : (stateNames[game.state ?? -1] ?? "in game");
    text = `${game.client} · ${where}`;
  }
  followStatus.textContent = text;
  followStatus.dataset.state = state;
}
function updateHidden(): void {
  const next = hiddenForGameplay(game);
  if (next === hidden) return;
  hidden = next;
  hiddenState.hidden = !hidden;
  // Map time and progress hide too: nothing here tracks the play.
  for (const element of [canvas, progress, timeOutput])
    element.style.visibility = hidden ? "hidden" : "";
  if (hidden) {
    audio.pause();
    play.textContent = "Play";
  }
}

function onGame(state: GameState): void {
  const previousClient = game.client,
    previousSkin = game.skinFolder;
  game = { ...state, mania: { ...state.mania }, visual: { ...state.visual } };
  clock.update(state.time, state.rate, state.running, performance.now());
  updateHidden();
  updateStatusChip();
  if (following) {
    void followMap();
    updateFollowNotice();
    // The disabled chips mirror the client's selection while following.
    for (const input of modInputs)
      input.checked = game.mods.some(
        (mod) => mod.acronym.toUpperCase() === input.value,
      );
  }
  if (
    skinChoice === "client" &&
    (previousClient !== game.client || previousSkin !== game.skinFolder)
  )
    void useClientSkin(false);
}

/* ------------------------------------------------------------ skins */

/** Installs a skin; bitmaps in `owned` are released when it is replaced. */
function installSkin(
  skin: Skin,
  label: string,
  source: string,
  owned: ImageBitmap[] = [],
) {
  renderer?.setSkin(skin);
  selectedSkin = skin;
  for (const bitmap of ownedBitmaps) bitmap.close();
  ownedBitmaps = owned;
  skinName.textContent = label;
  skinSource.textContent = source;
  sceneKey = "";
}
async function loadSkinFrom(
  pending: string,
  load: (isCurrent: () => boolean) => Promise<void>,
): Promise<void> {
  const seq = ++skinSequence;
  skinPanel.setAttribute("aria-busy", "true");
  skinNotice(pending);
  try {
    await load(() => seq === skinSequence);
  } catch (error) {
    if (seq === skinSequence)
      skinNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
  } finally {
    if (seq === skinSequence) skinPanel.removeAttribute("aria-busy");
  }
}
const fileCount = (count: number) =>
  `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;
const builtinLabels: Record<BuiltinSkinName, string> = {
  argon: "Argon",
  "argon-pro": "Argon Pro",
  triangles: "Triangles",
  legacy: "Classic",
};
function useBuiltin(name: BuiltinSkinName, source: string, message = "") {
  skinChoice = name;
  installSkin(builtin(name), builtinLabels[name], source);
  skinNotice(message);
}
/** Shows the client's current skin, falling back to the classic look with a reason. */
function useClientSkin(announce = true): Promise<void> {
  skinChoice = "client";
  return loadSkinFrom(
    "Asking vosu for the current skin…",
    async (isCurrent) => {
      const current = await readCurrentSkin();
      if (!isCurrent()) return;
      const key = JSON.stringify(current);
      if (!announce && key === clientSkinKey) {
        skinNotice("");
        return;
      }
      clientSkinKey = key;
      const client = current.info?.client ?? "client";
      if (current.kind === "unavailable") {
        installSkin(builtin("legacy"), "Classic", "fallback look");
        skinNotice(current.message, "notice");
        return;
      }
      if (current.kind === "builtin") {
        let skin = builtin(current.look);
        if (current.coloursFromFiles) {
          const ini = await hostSkinFiles().resolve("skin.ini");
          const colours = ini
            ? parseSkinIni(await ini.text()).get("Colours")
            : undefined;
          if (!isCurrent()) return;
          if (colours?.length)
            skin = {
              ...skin,
              sections: new Map(skin.sections).set("Colours", colours),
            };
        }
        installSkin(
          skin,
          current.name,
          `${client} · ${current.info.builtin ? "built-in skin" : `${builtinLabels[current.look]}-based skin`}`,
        );
        skinNotice(current.message ?? "", current.message ? "notice" : "info");
        return;
      }
      skinNotice(`Loading “${current.name}” from ${client}…`);
      const host = hostSkinFiles(),
        loaded = await loadSkin(host.resolve, current.name);
      if (!isCurrent()) {
        for (const bitmap of loaded.assets.values()) bitmap.close();
        return;
      }
      if (!host.served) {
        installSkin(builtin("legacy"), "Classic", "fallback look");
        skinNotice(
          host.failures
            ? `vosu could not serve the files of “${current.name}”; showing the classic look.`
            : `“${current.name}” has no skin.ini or gameplay elements the preview draws; showing the classic look.`,
          "notice",
        );
        return;
      }
      installSkin(
        withFallback(loaded, builtin(current.fallback)),
        current.name,
        `${client} · current skin · ${fileCount(host.served)}`,
        [...loaded.assets.values()],
      );
      skinNotice("");
    },
  );
}
async function userSkin(
  name: string,
  source: string,
  resolve: (path: string) => Promise<Blob | null>,
  isCurrent: () => boolean,
): Promise<void> {
  let used = 0;
  const loaded = await loadSkin(async (path) => {
    const blob = await resolve(path);
    if (blob) used++;
    return blob;
  }, name);
  if (!isCurrent()) {
    for (const bitmap of loaded.assets.values()) bitmap.close();
    return;
  }
  if (!used) {
    skinNotice(
      `“${name}” contains no skin.ini or gameplay elements the preview draws; the current skin stays.`,
      "notice",
    );
    return;
  }
  skinChoice = "user";
  installSkin(
    withFallback(loaded, builtin("legacy")),
    name,
    `${source} · ${fileCount(used)} used`,
    [...loaded.assets.values()],
  );
  skinNotice(`Loaded “${name}”. Missing elements use the classic look.`);
}
function applySkinSetting(): void {
  if (settings.skin === "client") void useClientSkin();
  else useBuiltin(settings.skin, "set in Map preview settings");
}

/* ------------------------------------------------------------ settings */

async function loadSettings(initial: boolean): Promise<void> {
  const previous = settings;
  const { settings: next, source } = await readSettings(vosu);
  settings = next;
  $("bar").hidden = !settings.showBar;
  progress.hidden = !following || !settings.showProgress;
  scrollInput.placeholder = settings.maniaScrollSpeed
    ? String(settings.maniaScrollSpeed)
    : "Client";
  if (initial) {
    noteSpeedInput.value = String(settings.noteSpeed);
    setDrawer(settings.controlsOpen);
    if (source === "defaults")
      skinNotice("This vosu has no settings route for tools; defaults apply.");
  }
  if (initial || previous.skin !== settings.skin) applySkinSetting();
  sceneKey = "";
}
function setDrawer(open: boolean): void {
  drawer.hidden = !open;
  controlsToggle.setAttribute("aria-expanded", String(open));
}

/* ------------------------------------------------------------ events */

followButton.onclick = () => setFollowing(!following);
controlsToggle.onclick = () => setDrawer(drawer.hidden);
$<HTMLButtonElement>("current-skin").onclick = () => void useClientSkin();
builtinSelect.onchange = () => {
  const value = builtinSelect.value as BuiltinSkinName | "";
  builtinSelect.value = "";
  if (value) useBuiltin(value, "chosen in this tab");
};
for (const input of [
  scrollInput,
  noteSpeedInput,
  ...overrideInputs,
  ...modInputs,
])
  input.addEventListener("change", () => {
    if (input.checked && (input.value === "HR" || input.value === "EZ"))
      for (const other of modInputs)
        if (other.value === (input.value === "HR" ? "EZ" : "HR"))
          other.checked = false;
    sceneKey = "";
  });
play.onclick = async () => {
  try {
    if (audio.paused) {
      await audio.play();
      play.textContent = "Pause";
    } else {
      audio.pause();
      play.textContent = "Play";
    }
  } catch (error) {
    showError(error);
  }
};
audio.onended = () => (play.textContent = "Play");
audio.onerror = () => {
  play.disabled = true;
  status.textContent =
    "This audio could not be played. Choose the map's audio file; seeking still previews map time.";
};
seek.oninput = () => {
  manualTime = Number(seek.value);
  if (audio.readyState) audio.currentTime = manualTime / 1000;
};
rate.onchange = () => {
  audio.playbackRate = Math.max(0.25, Math.min(3, Number(rate.value) || 1));
  rate.value = String(audio.playbackRate);
  audio.preservesPitch = false;
};
$<HTMLInputElement>("map-file").onchange = async (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  loadSequence++;
  setFollowing(false);
  audio.removeAttribute("src");
  play.disabled = true;
  manualTime = 0;
  try {
    await openMap(await file.text(), file.name);
    status.textContent = "Choose the map's audio file to play it back.";
  } catch (error) {
    showError(error);
  }
};
$<HTMLInputElement>("audio-file").onchange = (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  play.disabled = !map;
  status.textContent = "";
};
$<HTMLInputElement>("skin-osk").onchange = (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const name = file.name.replace(/\.(osk|zip)$/i, "");
  void loadSkinFrom(`Reading “${file.name}”…`, async (isCurrent) => {
    const archive = await openOsk(file);
    if (isCurrent())
      await userSkin(name, ".osk file", archive.resolve, isCurrent);
  });
};
$<HTMLInputElement>("skin-folder").onchange = (event) => {
  const input = event.target as HTMLInputElement,
    chosen = [...(input.files ?? [])];
  input.value = "";
  if (!chosen.length) return;
  const lookup = new Map<string, File>();
  for (const file of chosen)
    lookup.set(
      file.webkitRelativePath.split("/").slice(1).join("/").toLowerCase(),
      file,
    );
  const name = chosen[0].webkitRelativePath.split("/")[0];
  void loadSkinFrom(`Reading folder “${name}”…`, (isCurrent) =>
    userSkin(
      name,
      "skin folder",
      async (path) =>
        lookup.get(path.replace(/\\/g, "/").toLowerCase()) ?? null,
      isCurrent,
    ),
  );
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadSettings(false);
});
window.addEventListener("pagehide", () => {
  audio.pause();
  renderer?.destroy();
  for (const bitmap of ownedBitmaps) bitmap.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

/* ------------------------------------------------------------ start */

try {
  await vosu.ready;
  applyScheme();
  $("version").textContent = `Map preview ${vosu.tool.version}`.trim();
  await loadSettings(true);
  setFollowing(true);
  followGame(
    (fields, onFrame, onStatus) => vosu.subscribe(fields, onFrame, onStatus),
    onGame,
    (next) => {
      liveStatus = next;
      updateStatusChip();
    },
  );
  await ensureRenderer();
} catch (error) {
  showError(error);
}
