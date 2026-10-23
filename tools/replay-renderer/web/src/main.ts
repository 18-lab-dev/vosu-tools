import { vosu } from "/tools/_host/v1/bridge.js";
import { parseReplay } from "@vosu-tools/replay";
import { exportWebM } from "@vosu-tools/render-export";
import {
  Composition,
  DEFAULT_FADE_MS,
  DEFAULT_OUTRO_MS,
  ENTRY_FADE_MS,
  ENTRY_HOLD_MS,
  loadTrack,
  checked,
  ApiError,
  type Track,
  type Preset,
} from "./studio";
import "./style.css";
import settingSchema from "../../render-settings.json";
import { OverlayEditor, type InstalledOverlay, type Layer } from "./overlay-layout";
import { LayoutEditor } from "./editor";
import { SkinLibrary, type SkinContext } from "./skins";
import { ReplayLibrary, showMissingMap, type LinkState } from "./library";
import { SizePicker, parseSize, type SizeStore } from "./sizes";
import { LAYOUTS, type Layout } from "./layout";

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const tracks: Track[] = [];
let presets: Record<string, Preset> = {};
let composition: Composition | undefined,
  playing = false,
  time = 0,
  last = 0;
let defaultSettings: Record<string, number> = {},
  exporting = false;
let previewFrame: Promise<HTMLCanvasElement> | undefined;
const activeJobs = new Set<string>();
const fetcher = async (path: string, init?: RequestInit) =>
  checked(await vosu.fetch(path, init));

// Status messages: a toast; info fades, errors stay until the next message or a click.
const toast = el("toast");
let toastTimer: number | undefined;
function show(message: string, tone: "ok" | "error" | "") {
  toast.textContent = message;
  if (tone) toast.dataset.tone = tone;
  else delete toast.dataset.tone;
  toast.hidden = false;
  clearTimeout(toastTimer);
  if (tone !== "error") toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
}
toast.onclick = () => (toast.hidden = true);
function report(error: unknown) {
  show(error instanceof Error ? error.message : String(error), "error");
}
function inform(message: string) {
  show(message, "");
}

function timecode(ms: number) {
  const fps = Math.max(1, Number(el<HTMLInputElement>("fps").value) || 60);
  const total = Math.max(0, ms) / 1000;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(total / 3600)}:${pad((total / 60) % 60)}:${pad(total % 60)}:${pad((total % 1) * fps)}`;
}
const emptyPreview = el("preview").innerHTML;
function refreshComposition() {
  composition?.releaseTargets();
  el<HTMLButtonElement>("play").disabled = !tracks.length;
  el<HTMLInputElement>("seek").disabled = !tracks.length;
  if (!tracks.length) {
    composition = undefined;
    if (playing) setPlaying(false);
    time = 0;
    el<HTMLInputElement>("seek").value = "0";
    el("preview").innerHTML = emptyPreview;
    editor.render();
    el("duration").textContent = timecode(0);
    return;
  }
  const { width: outW, height: outH } = sizes.size;
  // Preview at most 1920 px on the long side; exports use the full size.
  const scale = Math.min(1, 1920 / Math.max(outW, outH));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const [width, height] = [even(outW), even(outH)];
  el("gate").style.setProperty("--ar", `${outW} / ${outH}`);
  const layout = el<HTMLSelectElement>("layout").value as Layout;
  composition = new Composition(tracks, width, height, layout);
  composition.timing = timing();
  composition.inspect = INSPECT;
  composition.validate();
  el("preview").replaceChildren(composition.canvas);
  refreshTimeline();
  editor.render();
}
/** Development aid: `?inspect` in the studio URL draws the composition
 *  inspector over the preview and asks MP4 exports for it too. Off by default. */
const INSPECT = new URLSearchParams(location.search).has("inspect");
/** Outro and fade for this composition, from the Output fields (defaults: tool settings). */
function timing() {
  const value = (id: string, fallback: number) => {
    const n = Number(el<HTMLInputElement>(id).value);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 60000) : fallback;
  };
  const outroMs = value("outro", DEFAULT_OUTRO_MS);
  return { outroMs, fadeMs: Math.min(outroMs, value("fade", DEFAULT_FADE_MS)) };
}
/** Seek range and duration follow the composition's lead-in and outro. */
function refreshTimeline() {
  if (!composition) return;
  const seek = el<HTMLInputElement>("seek");
  seek.min = String(composition.start);
  seek.max = String(composition.end);
  time = Math.min(composition.end, Math.max(composition.start, time));
  seek.value = String(time);
  el("duration").textContent = timecode(composition.duration / (tracks[0]?.replay.rate ?? 1));
}
for (const id of ["outro", "fade"])
  el(id).onchange = () => {
    if (!composition) return;
    composition.timing = timing();
    refreshTimeline();
  };
let swapping = 0;
/** Applies a track/composition change between preview frames, so an in-flight
 *  GPU readback never sees a destroyed buffer. */
async function betweenFrames(change: () => void) {
  swapping++;
  try {
    await previewFrame?.catch(() => undefined);
    change();
  } finally {
    swapping--;
  }
}

// Preview audio: the first track's song, muted by default; the choice persists.
const MUTE_KEY = "vosu-tools.replay-renderer.preview-muted";
let muted = localStorage.getItem(MUTE_KEY) !== "false";
const audio = new Audio();
audio.preload = "auto";
let audioTrack: Track | undefined,
  audioUrl = "";
function renderMute() {
  const button = el("mute");
  button.setAttribute("aria-pressed", String(muted));
  button.title = muted ? "Preview audio muted" : "Preview audio on";
  button.innerHTML = muted
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/><path d="m11 6 4 4m0-4-4 4" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
}
el("mute").onclick = () => {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, String(muted));
  renderMute();
  syncAudio(true);
};
renderMute();
/** Keeps the song on the preview clock; the picture is the master. */
function syncAudio(force = false) {
  audio.muted = muted;
  if (!audio.src || !playing || muted) {
    if (!audio.paused) audio.pause();
    return;
  }
  // Before the song starts (lead-in) there is nothing to play yet.
  if (time < 0) {
    if (!audio.paused) audio.pause();
    return;
  }
  audio.volume = 1 - (composition?.dimAt(time) ?? 0);
  const target = time / 1000;
  if (force || audio.paused || Math.abs(audio.currentTime - target) > 0.08)
    audio.currentTime = target;
  if (audio.paused) void audio.play().catch(() => undefined);
}
async function loadAudio() {
  const first = tracks[0];
  if (first === audioTrack) return;
  audioTrack = first;
  audio.pause();
  audio.removeAttribute("src");
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = "";
  if (!first) return;
  const blob = await (
    await fetcher(
      `v1/assets?${new URLSearchParams({ kind: "map-asset", hash: first.replay.beatmapHash, path: first.map.general.AudioFilename })}`,
    )
  ).blob();
  if (audioTrack !== first) return;
  audioUrl = URL.createObjectURL(blob);
  audio.src = audioUrl;
  audio.playbackRate = first.replay.rate;
  // Nightcore raises the pitch; DT and HT keep it.
  audio.preservesPitch = !(first.replay.mods & 512);
  syncAudio(true);
}

const skins = new SkinLibrary(
  {
    current: el("current-skin"),
    input: el("osk"),
    status: el("import-status"),
    list: el("imported"),
  },
  fetcher,
  () => renderTracks(),
  report,
);
async function add(bytes: Uint8Array<ArrayBuffer>) {
  const replay = await parseReplay(bytes);
  const saved = presets[replay.player];
  const preset = {
    skin: skins.available(saved?.skin) ? saved?.skin : null,
    settings: { ...defaultSettings, ...saved?.settings },
  };
  const imported = await (
    await fetcher("v1/replays", { method: "POST", body: bytes })
  ).json();
  const track = await loadTrack(
    imported.id,
    bytes,
    { ...preset, settings: { ...preset.settings } },
    fetcher,
    { currentBuiltin: skins.builtin },
  );
  await betweenFrames(() => {
    tracks.push(track);
    try {
      refreshComposition();
    } catch (error) {
      tracks.pop();
      track.dispose();
      refreshComposition();
      throw error;
    }
  });
  renderTracks();
  if (track.warning) report(track.warning);
  else inform(`Added ${replay.player}`);
}
function settingsEditor(track: Track) {
  const grid = document.createElement("div");
  grid.className = "settings-grid";
  const controls: Record<string, HTMLInputElement> = {};
  // Placement is edited in the preview's layout editor; layer switches live
  // in the track's Layers group.
  for (const rule of settingSchema.filter(
    (rule) =>
      rule.modes.includes(track.replay.mode) &&
      rule.control !== "layout" &&
      !LAYER_SWITCHES.has(rule.key),
  )) {
    const label = document.createElement("label"),
      caption = document.createElement("span"),
      input = document.createElement("input");
    caption.textContent = rule.label;
    input.dataset.setting = rule.key;
    input.type = rule.control === "toggle" ? "checkbox" : "number";
    input.min = String(rule.min);
    input.max = String(rule.max);
    input.step = String(rule.step);
    const value = track.settings[rule.key] ?? rule.default;
    input.value = String(value);
    input.checked = value !== 0;
    if (rule.control === "toggle") {
      label.className = "v-check";
      label.append(input, caption);
    } else {
      label.className = "v-field";
      input.className = "v-input";
      label.append(caption, input);
    }
    grid.append(label);
    controls[rule.key] = input;
  }
  const read = () => {
    const settings = { ...track.settings };
    for (const rule of settingSchema) {
      const input = controls[rule.key];
      if (!input) continue;
      const value =
        rule.control === "toggle" ? Number(input.checked) : Number(input.value);
      if (!Number.isFinite(value) || value < rule.min || value > rule.max)
        throw new Error(`${rule.label} must be ${rule.min}..${rule.max}`);
      settings[rule.key] = value;
    }
    return settings;
  };
  return { grid, read };
}
function button(label: string, className = "v-btn v-btn--sm") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  return node;
}
/** Built-in layers switched per track in the Layers group (HUD, hit lighting). */
const LAYER_SWITCHES = new Map<string, string>([
  ["hud.score", "Score"],
  ["hud.accuracy", "Accuracy"],
  ["hud.combo", "Combo"],
  ["hud.health", "Health bar"],
  ["hit_lighting", "Hit lighting"],
]);
/** Reloads a track with a new skin or settings and swaps it in between frames. */
async function reloadTrack(track: Track, preset: Preset) {
  const updated = await loadTrack(
    track.id,
    new Uint8Array(await (await fetcher(`v1/replays/${track.id}`)).arrayBuffer()),
    preset,
    fetcher,
    { currentBuiltin: skins.builtin },
  );
  await betweenFrames(() => {
    tracks[tracks.indexOf(track)] = updated;
    track.dispose();
    refreshComposition();
  });
  renderTracks();
  return updated;
}
/** Per-track switches for the built-in layers and every overlay. HUD layers and
 *  overlays switch live; hit lighting is part of the playfield, so it reloads. */
function layerSwitches(track: Track) {
  const group = document.createElement("fieldset"),
    legend = document.createElement("legend");
  group.className = "track-layers";
  legend.className = "v-label";
  legend.textContent = "Layers";
  group.append(legend);
  const check = (caption: string, checked: boolean, onchange: (on: boolean) => void) => {
    const label = document.createElement("label"),
      input = document.createElement("input"),
      text = document.createElement("span");
    label.className = "v-check";
    input.type = "checkbox";
    input.checked = checked;
    input.onchange = () => onchange(input.checked);
    text.textContent = caption;
    label.title = caption;
    label.append(input, text);
    group.append(label);
    return input;
  };
  for (const [key, caption] of LAYER_SWITCHES) {
    const rule = settingSchema.find((r) => r.key === key)!;
    if (!rule.modes.includes(track.replay.mode)) continue;
    const input = check(caption, (track.settings[key] ?? rule.default) !== 0, (on) => {
      if (key === "hit_lighting") {
        input.disabled = true;
        reloadTrack(track, { skin: track.skin, settings: { ...track.settings, [key]: Number(on) } }).catch(
          (error) => {
            input.disabled = false;
            input.checked = !on;
            report(error);
          },
        );
        return;
      }
      track.settings[key] = Number(on);
      editor.render();
    });
  }
  for (const layer of overlayEditor.layers)
    check(layer.name, !layer.hidden.has(track.id), (on) => {
      if (on) layer.hidden.delete(track.id);
      else layer.hidden.add(track.id);
      editor.render();
    });
  return group;
}
/** Track cards whose More disclosure is open, by track id. */
const moreOpen = new Set<string>();
function renderTracks() {
  const list = el("tracks");
  list.replaceChildren();
  el("track-count").textContent = String(tracks.length);
  if (!tracks.length) {
    const empty = document.createElement("li");
    empty.className = "v-empty";
    empty.textContent = "No tracks";
    list.append(empty);
  }
  tracks.forEach((track, index) => {
    const row = document.createElement("li");
    row.className = "track";
    const head = document.createElement("div");
    head.className = "track-head";
    const lane = document.createElement("span"),
      player = document.createElement("span"),
      rate = document.createElement("span");
    lane.className = "v-mono";
    lane.textContent = `V${index + 1}`;
    player.className = "track-player";
    player.textContent = track.replay.player;
    rate.className = "v-mono v-muted";
    rate.textContent = `${track.replay.rate}×`;
    head.append(lane, player, rate);
    const map = document.createElement("p");
    map.className = "track-map v-muted";
    map.textContent = `${track.map.metadata.Artist} – ${track.map.metadata.Title} [${track.map.metadata.Version}]`;
    const skinField = document.createElement("label"),
      skinCaption = document.createElement("span");
    skinField.className = "v-field";
    skinCaption.textContent = "Skin";
    const skin = skins.select(track.skin ?? "");
    skinField.append(skinCaption, skin);
    // A skin choice applies at once; render settings wait for Apply.
    skin.onchange = () => {
      skin.disabled = true;
      reloadTrack(track, { skin: skin.value || null, settings: track.settings })
        .then((updated) => inform(`Updated ${updated.replay.player}`))
        .catch((error) => {
          skin.disabled = false;
          report(error);
        });
    };
    const editor = settingsEditor(track);
    const apply = button("Apply");
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const updated = await reloadTrack(track, { skin: skin.value || null, settings: editor.read() });
        inform(`Updated ${updated.replay.player}`);
      } catch (error) {
        apply.disabled = false;
        report(error);
      }
    };
    const save = button("Save preset");
    save.disabled = !vosu.canWrite;
    save.title = `Use for ${track.replay.player}'s replays`;
    save.onclick = async () => {
      try {
        const preset = { skin: skin.value || null, settings: editor.read() };
        await fetcher(`v1/presets/${encodeURIComponent(track.replay.player)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(preset),
        });
        presets[track.replay.player] = preset;
        inform(`Preset saved for ${track.replay.player}`);
      } catch (error) {
        report(error);
      }
    };
    const remove = button("Remove", "v-btn v-btn--sm v-btn--ghost");
    remove.setAttribute("aria-label", `Remove V${index + 1} ${track.replay.player}`);
    remove.onclick = () =>
      betweenFrames(() => {
        tracks.splice(tracks.indexOf(track), 1);
        track.dispose();
        refreshComposition();
        renderTracks();
      }).catch(report);
    head.append(remove);
    // Everything beyond the skin lives under More (kept open across re-renders).
    const more = document.createElement("details"),
      summary = document.createElement("summary"),
      actions = document.createElement("div");
    more.className = "more";
    summary.textContent = "More";
    more.open = moreOpen.has(track.id);
    more.ontoggle = () => (more.open ? moreOpen.add(track.id) : moreOpen.delete(track.id));
    actions.className = "v-row";
    actions.append(apply, save);
    more.append(summary, layerSwitches(track), editor.grid, actions);
    row.append(head, map, skinField);
    for (const note of [skins.note(track.skin ?? ""), track.warning]) {
      if (!note) continue;
      const line = document.createElement("p");
      line.className = "track-note";
      line.textContent = note;
      row.append(line);
    }
    row.append(more);
    list.append(row);
  });
  el<HTMLInputElement>("out").placeholder = outName();
  void loadAudio().catch(report);
}
/** The Beatmap downloader UI answers same-origin when it is installed. */
const downloaderInstalled = fetch("/tools/downloader/", { method: "HEAD" })
  .then((response) => response.ok)
  .catch(() => false);
const library = new ReplayLibrary(
  {
    list: el("replays"),
    region: el("replay-region"),
    filter: el("filter"),
    mapTab: el("tab-map"),
    allTab: el("tab-all"),
    now: el("now"),
  },
  fetcher,
  (entry) =>
    addSafely(async () => {
      const query = new URLSearchParams({ source: entry.source, md5: entry.md5 });
      return new Uint8Array(
        await (
          await fetcher(`v1/replays/${encodeURIComponent(String(entry.id))}?${query}`)
        ).arrayBuffer(),
      );
    }),
  report,
);
const sizes = new SizePicker(
  el("size-picker"),
  "size-label",
  (size) => {
    betweenFrames(refreshComposition).catch(report);
    if (vosu.canWrite)
      fetcher("v1/sizes/last", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(size),
      }).catch(report);
  },
  {
    save: async (saved) =>
      (await fetcher("v1/sizes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(saved),
      }).then((r) => r.json())) as SizeStore,
    remove: async (name) =>
      (await fetcher(`v1/sizes/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }).then((r) => r.json())) as SizeStore,
  },
  report,
);
/** The typed output, else `<player> - <title> [<difficulty>] <time>.mp4`. */
function outName() {
  const typed = el<HTMLInputElement>("out").value.trim();
  if (typed) return /\.mp4$/i.test(typed) ? typed : `${typed}.mp4`;
  const first = tracks[0];
  const base = first
    ? `${first.replay.player} - ${first.map.metadata.Title} [${first.map.metadata.Version}]`
    : "replay";
  return `${base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.mp4`;
}
function setLink(state: LinkState) {
  el("link-dot").dataset.state = state === "open" ? "ok" : state === "connecting" ? "busy" : "warn";
  el("link").textContent = { connecting: "Connecting", open: "Live", closed: "Offline" }[state];
}
/** While lazer's library is still reading its database, asks again every three
 *  seconds (for up to two minutes) so its skins appear in the track menus. */
async function followLazerSkins(context: SkinContext & { lazer_library?: string }, attempts = 40) {
  if (context.lazer_library !== "loading" || attempts <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const next = await (await fetcher("v1/context")).json();
  skins.update(next);
  if ((next.lazer_skins?.length ?? 0) !== (context.lazer_skins?.length ?? 0)) renderTracks();
  return followLazerSkins(next, attempts - 1);
}
await vosu.ready;
/** Page sizes the overlay had when it was last committed, to remember changes. */
const remembered = new WeakMap<Layer, string>();
const overlayEditor: OverlayEditor = new OverlayEditor(el("overlay-layout"), {
  changed: () => {
    editor.render();
    // Every track card lists the overlays it can switch off.
    renderTracks();
  },
  spot: (width, height) => editor.spotFor(width, height),
  select: (layer) => {
    const track = tracks.find((t) => !layer.hidden.has(t.id));
    editor.select(track ? { kind: "overlay", layer, track } : null);
  },
  selected: () => (editor.selected?.kind === "overlay" ? editor.selected.layer : null),
});
const field = (id: string) => el<HTMLInputElement>(id);
const editor: LayoutEditor = new LayoutEditor(
  el("gate"),
  {
    // The selection's fields appear only while something is selected.
    root: el("layout-section"),
    title: el("inspector-title"),
    reset: el<HTMLButtonElement>("layout-reset"),
    fields: {
      x: field("lay-x"),
      y: field("lay-y"),
      w: field("lay-w"),
      h: field("lay-h"),
      scale: field("lay-scale"),
      opacity: field("lay-opacity"),
    },
  },
  {
    output: () => sizes.size,
    layout: () => el<HTMLSelectElement>("layout").value as Layout,
    tracks: () => tracks,
    layers: () => overlayEditor.layers,
    changed(item, commit) {
      if (!commit) return;
      if (item.kind === "playfield") {
        // Render targets follow the new scale; until then frames are resampled.
        betweenFrames(() => composition?.retarget()).catch(report);
        return;
      }
      // HUD layers are drawn on the frame canvas: the next preview frame shows them.
      if (item.kind === "hud") return;
      const { layer } = item,
        page = `${layer.width}x${layer.height}`;
      if (layer.id && vosu.canWrite && remembered.get(layer) !== page) {
        remembered.set(layer, page);
        fetcher("v1/sizes/overlay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: layer.id, width: layer.width, height: layer.height }),
        }).catch(report);
      }
    },
    selected(item) {
      el<HTMLButtonElement>("layout-reset").disabled = !item;
      overlayEditor.render();
    },
  },
);
el<HTMLButtonElement>("layout-reset").disabled = true;
sizes.canWrite = vosu.canWrite;
refreshComposition();
renderTracks();
if (!vosu.canWrite) {
  show("Read-only. Open the renderer from the vosu dashboard.", "error");
  for (const id of ["files", "refresh", "queue", "webm", "osk"])
    el<HTMLButtonElement>(id).disabled = true;
  skins.describeReadOnly();
  library.message("Read-only");
} else {
  try {
    const context = await (await fetcher("v1/context")).json();
    skins.update(context);
    void followLazerSkins(context).catch(report);
    defaultSettings = context.default_settings;
    const defaults = context.defaults as {
      fps: number;
      resolution: string;
      output_dir: string | null;
      outro_ms: number;
      fade_ms: number;
    };
    el<HTMLInputElement>("fps").value = String(defaults.fps);
    el<HTMLInputElement>("outro").value = String(defaults.outro_ms);
    el<HTMLInputElement>("fade").value = String(defaults.fade_ms);
    el("folder").textContent = defaults.output_dir ?? "No output folder: use an absolute path";
    const store = (await (await fetcher("v1/sizes")).json()) as SizeStore;
    if (LAYOUTS.includes(store.layout as Layout))
      el<HTMLSelectElement>("layout").value = store.layout as Layout;
    sizes.set(
      parseSize(store.last) ?? parseSize(defaults.resolution) ?? { width: 1920, height: 1080 },
      store,
    );
    presets = await (await fetcher("v1/presets")).json();
    library.follow(vosu.subscribe.bind(vosu), setLink);
    library.show("map");
    // Optional: without the listing, overlays are added as custom folders.
    fetcher("v1/overlays")
      .then((response) => response.json() as Promise<{ available: boolean; overlays: InstalledOverlay[] }>)
      .then(({ available, overlays }) => {
        overlayEditor.setInstalled(overlays, available);
        editor.render();
      })
      .catch(report);
  } catch (error) {
    report(error);
  }
}
/** Adds a replay, explaining a missing beatmap instead of a bare error. */
async function addSafely(load: () => Promise<Uint8Array<ArrayBuffer>>) {
  try {
    el("missing").hidden = true;
    await add(await load());
  } catch (error) {
    if (error instanceof ApiError && error.details?.code === "map_missing") {
      showMissingMap(
        el("missing"),
        error.details as { md5: string; searched: string[] },
        await downloaderInstalled,
      );
      report("Map not installed");
    } else report(error);
  }
}
async function addFiles(files: Iterable<File>) {
  for (const file of files)
    await addSafely(async () => new Uint8Array(await file.arrayBuffer()));
}
el<HTMLInputElement>("files").onchange = async (event) => {
  const input = event.target as HTMLInputElement;
  await addFiles(input.files ?? []);
  input.value = "";
};
const drop = el("drop");
drop.ondragover = (event) => {
  event.preventDefault();
  drop.classList.add("over");
};
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = async (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  if (!vosu.canWrite) return;
  await addFiles(event.dataTransfer?.files ?? []);
};
el("refresh").onclick = () => void library.refresh();
// Expanded timeline: the same live track list moves into a large dialog and back.
const timelineModal = el<HTMLDialogElement>("timeline-modal"),
  timelineHome = el("tracks").parentElement!;
el("timeline-expand").onclick = () => {
  el("timeline-modal-body").append(el("tracks"));
  timelineModal.showModal();
};
el("timeline-close").onclick = () => timelineModal.close();
// A click on the dialog itself (not its contents) is a click on the dimmed backdrop.
timelineModal.onclick = (event) => {
  if (event.target === timelineModal) timelineModal.close();
};
timelineModal.onclose = () => {
  timelineHome.append(el("tracks"));
  el("timeline-expand").focus();
};
el("layout").onchange = () => {
  betweenFrames(refreshComposition).catch(report);
  if (vosu.canWrite)
    fetcher("v1/sizes/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: el<HTMLSelectElement>("layout").value }),
    }).catch(report);
};
function setPlaying(next: boolean) {
  playing = next;
  el("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  el("play-icon").setAttribute("d", playing ? "M4 2.5h3v11H4zm5 0h3v11H9z" : "M4 2.5v11l9-5.5z");
  syncAudio(true);
}
el("play").onclick = () => {
  last = performance.now();
  setPlaying(!playing);
};
el<HTMLInputElement>("seek").oninput = () => {
  time = Number(el<HTMLInputElement>("seek").value);
  syncAudio(true);
};
async function animate(now: number) {
  if (playing && composition) {
    time += (now - last) * (tracks[0]?.replay.rate ?? 1);
    if (time > composition.end) {
      time = composition.start;
      setPlaying(false);
    }
    el<HTMLInputElement>("seek").value = String(time);
    syncAudio();
  }
  if (composition && !exporting && !swapping) {
    try {
      if (INSPECT) composition.overlayBoxes = editor.overlayBoxes();
      previewFrame = composition.renderOffline(time);
      await previewFrame;
    } catch (error) {
      report(error);
    } finally {
      previewFrame = undefined;
    }
  }
  last = now;
  el("time").textContent = timecode(
    composition ? (time - composition.start) / (tracks[0]?.replay.rate ?? 1) : 0,
  );
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
function setTally() {
  const busy = exporting || activeJobs.size > 0;
  el("tally").hidden = !busy;
  el("rendering").hidden = !busy;
}
el("queue").onclick = async () => {
  try {
    if (!composition) throw new Error("Add a replay first");
    composition.validate();
    const request = {
      replays: tracks.map((t) => ({
        id: t.id,
        skin: t.skin ?? "",
        settings: t.settings,
      })),
      fps: Number(el<HTMLInputElement>("fps").value),
      resolution: `${sizes.size.width}x${sizes.size.height}`,
      layout: el<HTMLSelectElement>("layout").value,
      overlays: overlayEditor.read(tracks.map((t) => t.id)),
      out: outName(),
      inspect: INSPECT,
      outro_ms: composition.timing.outroMs,
      fade_ms: composition.timing.fadeMs,
    };
    const { job } = await (
      await fetcher("v1/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
    ).json();
    const row = document.createElement("li");
    row.className = "job";
    const dot = document.createElement("span"),
      message = document.createElement("span"),
      meter = document.createElement("div"),
      cancel = button("Cancel", "v-btn v-btn--sm v-btn--ghost");
    dot.className = "v-dot";
    dot.dataset.state = "busy";
    message.className = "job-message";
    message.textContent = request.out;
    meter.className = "v-meter";
    meter.style.setProperty("--v-value", "0");
    cancel.onclick = () => {
      void fetcher(`v1/jobs/${job}`, { method: "DELETE" }).catch(report);
    };
    row.append(dot, message, cancel, meter);
    el("jobs").prepend(row);
    activeJobs.add(job);
    setTally();
    const update = async () => {
      try {
        const current = await (await fetcher(`v1/jobs/${job}`)).json();
        meter.style.setProperty("--v-value", String(current.progress));
        message.textContent = current.message;
        if (["done", "failed", "cancelled"].includes(current.state)) {
          dot.dataset.state =
            current.state === "done" ? "ok" : current.state === "failed" ? "error" : "warn";
          cancel.remove();
          activeJobs.delete(job);
          setTally();
          if (current.result)
            message.textContent = `${current.result.out} · ${current.result.render_fps.toFixed(1)} fps`;
        } else
          setTimeout(() => {
            void update();
          }, 500);
      } catch (error) {
        activeJobs.delete(job);
        setTally();
        report(error);
      }
    };
    void update();
  } catch (error) {
    report(error);
  }
};
el("webm").onclick = async () => {
  const controls = [
    ...document.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >("button,input,select"),
  ].map((control) => [control, control.disabled] as const);
  try {
    if (!composition) throw new Error("Add a replay first");
    if (overlayEditor.configured)
      throw new Error("Overlays need Render MP4");
    setPlaying(false);
    composition.validate();
    exporting = true;
    setTally();
    for (const [control] of controls) control.disabled = true;
    await previewFrame;
    const first = tracks[0];
    const song = await (
      await fetcher(
        `v1/assets?${new URLSearchParams({ kind: "map-asset", hash: first.replay.beatmapHash, path: first.map.general.AudioFilename })}`,
      )
    ).arrayBuffer();
    // Export at the full output size; the preview runs at a capped size.
    composition.releaseTargets();
    const { width, height } = sizes.size;
    const full = new Composition(tracks, width, height, composition.layout);
    full.timing = composition.timing;
    try {
      const blob = await exportWebM({
        fps: Number(el<HTMLInputElement>("fps").value),
        width,
        height,
        startMs: full.start,
        durationMs: full.duration,
        rate: first.replay.rate,
        audio: song,
        fade: { inDelayMs: ENTRY_HOLD_MS, inMs: ENTRY_FADE_MS, outMs: full.timing.fadeMs },
        render: (t) => full.renderOffline(t),
        progress: (p) => {
          inform(`Encoding WebM ${(p * 100).toFixed(0)}%`);
        },
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = outName().replace(/\.mp4$/i, ".webm").split(/[\\/]/).pop()!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      show("WebM exported", "ok");
    } finally {
      full.releaseTargets();
      refreshComposition();
    }
  } catch (error) {
    report(error);
  } finally {
    exporting = false;
    setTally();
    for (const [control, disabled] of controls) control.disabled = disabled;
  }
};
