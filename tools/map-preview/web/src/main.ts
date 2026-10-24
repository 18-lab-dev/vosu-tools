import { vosu } from "/tools/_host/v1/bridge.js";
import {
  parseOsu,
  type Beatmap,
  type Mod,
  type Ruleset,
} from "@vosu-tools/osu-parse";
import { convertBeatmap, maniaKeys } from "@vosu-tools/ruleset-convert";
import {
  createPlayfield,
  maniaKeysFor,
  playfieldSize,
  type BuiltinSkinName,
  type Playfield,
  type RenderOptions,
} from "@vosu-tools/render-core";
import { ClientSkin } from "@vosu-tools/client-skin";
import {
  LiveClock,
  emptyState,
  followGame,
  hiddenForGameplay,
  type GameState,
  type LiveStatus,
} from "./live";
import { md5 } from "./md5";
import {
  defaultSettings,
  readSettings,
  type PreviewSettings,
} from "./settings";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("playfield"),
  stage = $("stage"),
  status = $("status"),
  hiddenState = $("hidden-state"),
  followButton = $<HTMLButtonElement>("follow"),
  followStatus = $("follow-status"),
  followDot = $("follow-dot"),
  timeOutput = $<HTMLOutputElement>("time"),
  progress = $("progress"),
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
  rulesetSelect = $<HTMLSelectElement>("ruleset"),
  keysSelect = $<HTMLSelectElement>("keys"),
  dualInput = $<HTMLInputElement>("dual"),
  audio = new Audio();

let renderer: Playfield | undefined,
  rendererReady: Promise<Playfield> | undefined,
  /** The beatmap as parsed. */
  source: Beatmap | undefined,
  /** What is shown: `source`, or its conversion to the played ruleset. */
  map: Beatmap | undefined,
  conversionKey = "",
  mapKey = "",
  sceneKey = "",
  loadSequence = 0,
  settings: PreviewSettings = { ...defaultSettings },
  following = true,
  objectUrl: string | undefined,
  manualTime = 0,
  game: GameState = emptyState(),
  liveStatus: LiveStatus = "connecting",
  hidden = false;
const clock = new LiveClock();
const formatTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  return `${Math.floor(t / 60000)}:${String(Math.floor(t / 1000) % 60).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
};
/** One short line in the status toast; empty hides it. */
function say(message: string, tone: "info" | "error" = "info"): void {
  status.textContent = message;
  if (tone === "error") status.dataset.tone = "error";
  else delete status.dataset.tone;
}
function showError(error: unknown): void {
  say(error instanceof Error ? error.message : String(error), "error");
}
const skins = new ClientSkin({
  // Mania images are decoded per scene (see refreshScene).
  maniaKeys: [],
  onChange(state) {
    renderer?.setSkin(state.skin);
    if (state.busy) skinPanel.setAttribute("aria-busy", "true");
    else skinPanel.removeAttribute("aria-busy");
    skinName.textContent = state.label;
    skinSource.textContent = state.source;
    skinMessage.textContent = state.message;
    skinMessage.dataset.tone = state.tone;
    if (state.skin !== shownSkin) sceneKey = "";
    shownSkin = state.skin;
  },
});
let shownSkin = skins.state.skin;
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

function ensureRenderer(): Promise<Playfield> {
  rendererReady ??= createPlayfield({
    canvas,
    skin: skins.state.skin,
  }).then(
    (created) => {
      renderer = created;
      // A skin installed while the renderer was being created must still reach it.
      created.setSkin(skins.state.skin);
      resize();
      return created;
    },
    (error: unknown) => {
      // A later attempt (next map) may succeed, e.g. after a GPU reset.
      rendererReady = undefined;
      throw new Error(
        `WebGPU could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  return rendererReady;
}
function resize(): void {
  // The shared playfield resolution (render-core playfieldSize).
  if (renderer) renderer.fit(stage.clientWidth, stage.clientHeight);
  else
    ({ width: canvas.width, height: canvas.height } = playfieldSize(
      stage.clientWidth,
      stage.clientHeight,
    ));
  sceneKey = "";
}
new ResizeObserver(resize).observe(stage);

const rulesetNames = ["osu!", "taiko", "catch", "mania"];
const conversionModPattern = /^(?:(?:10|[1-9])K|DS)$/i;

/** The ruleset the map is played in: the client's while following, else the drawer's choice. */
function playedRuleset(): Ruleset {
  if (!source || source.mode !== 0) return source?.mode ?? 0;
  if (following) return (game.selectedMode ?? 0) as Ruleset;
  return rulesetSelect.value === ""
    ? 0
    : (Number(rulesetSelect.value) as Ruleset);
}
/** Key-count mods and Dual Stages: they decide how a mania convert is generated. */
function conversionMods(): Mod[] {
  if (following)
    return game.mods
      .filter((mod) => conversionModPattern.test(mod.acronym))
      .map((mod) => ({ acronym: mod.acronym.toUpperCase() }));
  const mods: Mod[] = [];
  if (keysSelect.value) mods.push({ acronym: `${keysSelect.value}K` });
  if (dualInput.checked) mods.push({ acronym: "DS" });
  return mods;
}
const maniaConvert = () => source?.mode === 0 && playedRuleset() === 3;

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
    // A mania convert's key count comes from the conversion, never from CS.
    cs:
      !following && csInput.value !== "" && !maniaConvert()
        ? Number(csInput.value)
        : undefined,
    scrollSpeed: scroll,
    noteSpeed: Number(noteSpeedInput.value) || settings.noteSpeed,
    maniaScrollUp: game.mania.scrollUp,
    hitLighting: game.visual.hitLighting ?? undefined,
    beatmapColours: game.visual.beatmapColours ?? undefined,
    snakingIn: game.visual.snakingIn ?? undefined,
    // lazer normalises combo colours (the shared default, 0.2); stable does not.
    comboColourNormalisation:
      game.visual.comboColourNormalisation ??
      (game.client === "stable" ? 0 : undefined),
  };
}
/** Re-converts when the played ruleset or key mods change. */
function updateConversion(): void {
  if (!source) return;
  const ruleset = playedRuleset(),
    mods = ruleset === 3 ? conversionMods() : [],
    key = JSON.stringify([ruleset, mods]);
  if (key === conversionKey) return;
  conversionKey = key;
  sceneKey = "";
  try {
    map = convertBeatmap(source, ruleset, mods);
  } catch (error) {
    map = undefined;
    throw error;
  } finally {
    describeMap();
  }
}
function refreshScene(force = false): void {
  if (!renderer || !source) return;
  try {
    updateConversion();
  } catch (error) {
    // e.g. lazer's "not enough columns" for impossible key layouts.
    showError(error);
    return;
  }
  const options = renderOptions(),
    key = JSON.stringify(options);
  if (!map || (!force && key === sceneKey)) return;
  // The skin decodes mania images for the stage on screen only; the previous
  // scene stays drawn until they are ready (onChange then refreshes).
  const keys = maniaKeysFor(map, options);
  if (!skins.hasManiaKeys(keys)) {
    void skins.useManiaKeys(keys);
    return;
  }
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
  if (hidden || !renderer || !source) return;
  refreshScene();
  if (!map) return;
  const now = currentTime();
  try {
    renderer.renderAt(now);
  } catch (error) {
    showError(error);
    return;
  }
  timeOutput.value = formatTime(now);
  const duration = Math.max(1, map.duration);
  progress.style.setProperty(
    "--v-value",
    String(Math.min(1, Math.max(0, now / duration))),
  );
  if (!following && document.activeElement !== seek) seek.value = String(now);
}
requestAnimationFrame(tick);

/* ------------------------------------------------------------ beatmap */

let mapLabel = "",
  /** lazer's own mania key count for the open osu! map (0 for other rulesets). */
  automaticKeys = 0;
async function openMap(text: string, label: string): Promise<void> {
  const parsed = parseOsu(text);
  if (!parsed.objects.length)
    throw new Error("This beatmap contains no hit objects.");
  await ensureRenderer();
  source = parsed;
  map = undefined;
  mapLabel = label;
  automaticKeys = parsed.mode === 0 ? maniaKeys(parsed).columns : 0;
  conversionKey = "";
  $("title").textContent =
    `${source.metadata.Artist ?? ""} — ${source.metadata.Title ?? "Untitled"}`;
  refreshScene(true);
  updateFollowNotice();
}
/** Title line, ruleset badge and the drawer's ruleset controls for what is shown. */
function describeMap(): void {
  if (!source) return;
  const shown = map ?? source,
    convert = shown.mode !== source.mode,
    keys = shown.mode === 3 ? ` · ${Math.round(shown.difficulty.cs)}K` : "";
  overrideInputs[2].max = shown.mode === 3 ? "18" : "11";
  overrideInputs[2].step = shown.mode === 3 ? "1" : "0.1";
  seek.max = String(shown.duration + 2000);
  $("detail").textContent =
    `[${source.metadata.Version ?? ""}] ${source.metadata.Creator ?? ""} · ${shown.objects.length.toLocaleString()} objects${keys}${convert ? " · converted from osu!" : ""} · ${mapLabel}`;
  const mode = $("mode");
  mode.textContent = rulesetNames[shown.mode];
  mode.dataset.mode = String(shown.mode);
  if (convert) mode.dataset.convert = "";
  else delete mode.dataset.convert;
  mode.title = convert
    ? `Converted from osu! to ${rulesetNames[shown.mode]}`
    : "";
  updateRulesetControls();
}
/** The drawer's ruleset section: editable in manual mode, a mirror of the client while following. */
function updateRulesetControls(): void {
  const osuMap = source?.mode === 0,
    ruleset = playedRuleset(),
    mods = conversionMods();
  if (following || !osuMap) {
    rulesetSelect.value = osuMap ? String(ruleset) : "";
    const keyMod = mods.find((mod) => mod.acronym.endsWith("K"));
    keysSelect.value = keyMod ? keyMod.acronym.slice(0, -1) : "";
    dualInput.checked = mods.some((mod) => mod.acronym === "DS");
  }
  rulesetSelect.disabled = following || !osuMap;
  keysSelect.disabled = dualInput.disabled =
    following || !osuMap || ruleset !== 3;
  overrideInputs[2].disabled = following || (osuMap && ruleset === 3);
  keysSelect.options[0].textContent = automaticKeys
    ? `Automatic (${automaticKeys}K)`
    : "Automatic";
  const osuOnly = source && !osuMap;
  rulesetSelect.title = osuOnly ? "Only osu! maps convert." : "";
}
/**
 * Loads the game's selected map when it changes. vosu can briefly serve the
 * previous difficulty's file after a selection change, so the file's MD5 must
 * match the selected checksum; otherwise it is fetched again with a backoff
 * (100 ms doubling, at most 3 s apart) while the selection stays the same.
 * The previous map stays drawn meanwhile.
 */
async function followMap(force = false): Promise<void> {
  const key = game.checksum ?? "";
  if (!force && key === mapKey) return;
  mapKey = key;
  const seq = ++loadSequence;
  if (!key && !force) return;
  say("Loading the selected beatmap…");
  // The previous map stays drawn; the bar says what is happening.
  $("detail").textContent = "Loading…";
  const settle = () => {
    if (source) describeMap();
    else $("detail").textContent = "";
  };
  for (let delay = 100, attempt = 0; ; delay = Math.min(3000, delay * 2)) {
    try {
      const response = await fetch("/files/beatmap/file", {
        cache: "no-store",
      });
      if (seq !== loadSequence || !following) return;
      if (!response.ok) {
        // Without a client there is simply nothing selected yet.
        if (game.client)
          say(
            `vosu could not serve the selected beatmap (${response.status}).`,
            "error",
          );
        else say("No beatmap selected.");
        settle();
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (seq !== loadSequence || !following) return;
      if (!key || md5(bytes) === key.toLowerCase()) {
        say("");
        await openMap(new TextDecoder().decode(bytes), "from the game");
        return;
      }
      if (++attempt === 6)
        say("Waiting for vosu to serve the selected beatmap…");
    } catch (error) {
      if (seq === loadSequence) {
        showError(error);
        settle();
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (seq !== loadSequence || !following) return;
  }
}
let followNotice = "";
/** Explains where following the game cannot match the client exactly. */
function updateFollowNotice(): void {
  if (!source) return;
  const notes: string[] = [];
  if (
    following &&
    game.client === "stable" &&
    source.mode === 0 &&
    playedRuleset() !== 0
  )
    notes.push("Converted as osu!lazer does; stable may differ.");
  if (
    following &&
    game.mods.some(
      (mod) => mod.acronym.toUpperCase() === "RD" && mod.settings?.seed == null,
    )
  )
    notes.push("Random has no seed yet; notes are unshuffled.");
  const next = notes.join(" ");
  if (next) say(next);
  else if (followNotice && status.textContent === followNotice) say("");
  followNotice = next;
}

/* ------------------------------------------------------------ follow / manual */

function setFollowing(next: boolean): void {
  following = next;
  followButton.setAttribute("aria-pressed", String(next));
  transport.hidden = next;
  progress.hidden = !next || !settings.showProgress;
  for (const input of [...modInputs, ...overrideInputs]) input.disabled = next;
  updateRulesetControls();
  if (next) {
    audio.pause();
    say("");
    void followMap(true);
  }
  sceneKey = "";
  updateStatusChip();
}
function updateStatusChip(): void {
  let text: string,
    dot: "ok" | "busy" | "warn" | "" = "";
  if (!following) text = "Manual preview";
  else if (liveStatus === "connecting") {
    text = "Connecting to vosu…";
    dot = "busy";
  } else if (liveStatus === "lost") {
    text = "vosu disconnected · retrying";
    dot = "warn";
  } else if (liveStatus === "waiting" || !game.client)
    text = "vosu connected · no game";
  else {
    const where =
      game.state === 2 && game.source && game.source !== "player"
        ? game.source === "autoplay"
          ? "autoplay"
          : "watching a replay"
        : (stateNames[game.state ?? -1] ?? "in game");
    text = `${game.client} · ${where}`;
    dot = "ok";
  }
  followStatus.textContent = text;
  if (dot) followDot.dataset.state = dot;
  else delete followDot.dataset.state;
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
  game = { ...state, mania: { ...state.mania }, visual: { ...state.visual } };
  clock.update(state.time, state.rate, state.running, performance.now());
  updateHidden();
  updateStatusChip();
  if (following) {
    void followMap();
    updateFollowNotice();
    updateRulesetControls();
    // The disabled chips mirror the client's selection while following.
    for (const input of modInputs)
      input.checked = game.mods.some(
        (mod) => mod.acronym.toUpperCase() === input.value,
      );
  }
  void skins.gameChanged(game.client, game.skinFolder);
}

/* ------------------------------------------------------------ skins */

function applySkinSetting(): void {
  if (settings.skin === "client") void skins.useClient();
  else skins.useBuiltin(settings.skin, "set in Map preview settings");
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
    // The user's last choice in this tool wins over the dashboard default.
    const stored = localStorage.getItem(CONTROLS_KEY);
    setDrawer(stored === null ? settings.controlsOpen : stored === "1", false);
    if (source === "defaults")
      skins.say("Defaults apply: this vosu has no tool settings.");
  }
  if (initial || previous.skin !== settings.skin) applySkinSetting();
  sceneKey = "";
}
// Per tool on the shared overlay origin, like the mute toggle.
const CONTROLS_KEY = "vosu-tools:map-preview:controls-open";
/** Shows or hides the docked controls panel; the playfield resizes beside it. */
function setDrawer(open: boolean, remember = true): void {
  if (!open && drawer.contains(document.activeElement)) controlsToggle.focus();
  drawer.hidden = !open;
  controlsToggle.setAttribute("aria-expanded", String(open));
  if (remember) localStorage.setItem(CONTROLS_KEY, open ? "1" : "0");
}

/* ------------------------------------------------------------ events */

followButton.onclick = () => setFollowing(!following);
controlsToggle.onclick = () => setDrawer(drawer.hidden);
$<HTMLButtonElement>("controls-close").onclick = () => setDrawer(false);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && !drawer.hidden)
    setDrawer(false);
});
$<HTMLButtonElement>("current-skin").onclick = () => void skins.useClient();
builtinSelect.onchange = () => {
  const value = builtinSelect.value as BuiltinSkinName | "";
  builtinSelect.value = "";
  if (value) skins.useBuiltin(value);
};
// Ruleset, key count and Dual Stages re-convert on the next frame.
for (const control of [rulesetSelect, keysSelect, dualInput])
  control.addEventListener("change", updateRulesetControls);
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
// Muted unless the user unmuted this tool before; tools share the overlay
// origin's storage, hence the tool id in the key.
const MUTE_KEY = "vosu-tools:map-preview:muted",
  muteButton = $<HTMLButtonElement>("mute");
function setMuted(muted: boolean): void {
  audio.muted = muted;
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButton.textContent = muted ? "Muted" : "Sound on";
}
setMuted(localStorage.getItem(MUTE_KEY) !== "0");
muteButton.onclick = () => {
  setMuted(!audio.muted);
  localStorage.setItem(MUTE_KEY, audio.muted ? "1" : "0");
};
audio.onerror = () => {
  play.disabled = true;
  say("This audio could not be played.", "error");
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
    say("");
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
  say("");
};
$<HTMLInputElement>("skin-osk").onchange = (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (file) void skins.loadOsk(file);
};
$<HTMLInputElement>("skin-folder").onchange = (event) => {
  const input = event.target as HTMLInputElement,
    chosen = [...(input.files ?? [])];
  input.value = "";
  void skins.loadFolder(chosen);
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadSettings(false);
});
window.addEventListener("pagehide", () => {
  audio.pause();
  renderer?.destroy();
  skins.destroy();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

/* ------------------------------------------------------------ start */

let hadConnection = false;
try {
  await vosu.ready;
  $("version").textContent = vosu.tool.version;
  await loadSettings(true);
  setFollowing(true);
  followGame(
    (fields, onFrame, onStatus) => vosu.subscribe(fields, onFrame, onStatus),
    onGame,
    (next) => {
      // After a reconnect (vosu restarted, or the socket dropped), the
      // selection may have changed unseen: load it again.
      const reconnected =
        (liveStatus === "lost" || liveStatus === "connecting") &&
        (next === "waiting" || next === "live") &&
        hadConnection;
      if (next === "waiting" || next === "live") hadConnection = true;
      liveStatus = next;
      updateStatusChip();
      if (reconnected) {
        if (following) void followMap(true);
        if (skins.state.choice === "client")
          void skins.useClient({ force: false });
      }
    },
  );
  await ensureRenderer();
} catch (error) {
  showError(error);
}
