import { vosu } from "/tools/_host/v1/bridge.js";
import { parseReplay } from "@vosu-tools/replay";
import { exportWebM, type Layout } from "@vosu-tools/render-export";
import {
  Composition,
  loadTrack,
  checked,
  type Track,
  type Preset,
} from "./studio";
import "./style.css";
import settingSchema from "../../render-settings.json";
import { OverlayEditor } from "./overlay-layout";
import { SkinLibrary } from "./skins";

// The studio owns its look; vosu only hints the dashboard's mode.
const root = document.documentElement;
const lightQuery = matchMedia("(prefers-color-scheme: light)");
function applyScheme() {
  // Bridges that predate `colorScheme` mark the mode with data-theme instead.
  const legacy = root.dataset.theme;
  root.dataset.scheme =
    vosu.colorScheme ??
    (legacy === "light" || legacy === "dark"
      ? legacy
      : lightQuery.matches
        ? "light"
        : "dark");
}
applyScheme();
lightQuery.addEventListener("change", applyScheme);

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const notice = el("notice");
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
function report(error: unknown) {
  notice.textContent = error instanceof Error ? error.message : String(error);
  notice.classList.add("error");
}
function inform(message: string) {
  notice.textContent = message;
  notice.classList.remove("error");
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
  if (!tracks.length) {
    composition = undefined;
    el("preview").innerHTML = emptyPreview;
    el("duration").textContent = timecode(0);
    return;
  }
  const [width, height] = el<HTMLSelectElement>("resolution")
    .value.split("x")
    .map(Number);
  const layout = el<HTMLSelectElement>("layout").value as Layout;
  composition = new Composition(tracks, width, height, layout);
  composition.validate();
  el("preview").replaceChildren(composition.canvas);
  el<HTMLInputElement>("seek").max = String(composition.duration);
  el("duration").textContent = timecode(composition.duration);
}
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
  else
    inform(
      `Added ${replay.player} · ${replay.frames.length.toLocaleString()} replay frames`,
    );
}
function settingsEditor(track: Track) {
  const details = document.createElement("details"),
    summary = document.createElement("summary"),
    grid = document.createElement("div");
  summary.textContent = "Render settings";
  grid.className = "settings-grid";
  details.append(summary, grid);
  const controls: Record<string, HTMLInputElement> = {};
  for (const rule of settingSchema.filter((rule) =>
    rule.modes.includes(track.replay.mode),
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
      label.className = "toggle";
      label.append(input, caption);
    } else {
      label.className = "field";
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
  return { details, read };
}
function renderTracks() {
  const list = el("tracks");
  list.replaceChildren();
  tracks.forEach((track, index) => {
    const row = document.createElement("li");
    row.className = "track";
    row.style.setProperty("--lane", `var(--lane-${(index % 6) + 1})`);
    const head = document.createElement("div");
    head.className = "track-head";
    const lane = document.createElement("span"),
      player = document.createElement("strong"),
      rate = document.createElement("span");
    lane.className = "lane-id";
    lane.textContent = `V${index + 1}`;
    player.className = "track-player";
    player.textContent = track.replay.player;
    rate.className = "track-rate";
    rate.textContent = `${track.replay.rate}×`;
    head.append(lane, player, rate);
    const map = document.createElement("p");
    map.className = "track-map";
    map.textContent = `${track.map.metadata.Artist} – ${track.map.metadata.Title} [${track.map.metadata.Version}]`;
    const skinField = document.createElement("label"),
      skinCaption = document.createElement("span");
    skinField.className = "field";
    skinCaption.textContent = "Skin";
    const skin = skins.select(track.skin ?? "");
    skinField.append(skinCaption, skin);
    const editor = settingsEditor(track);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "grow";
    apply.textContent = "Apply";
    apply.onclick = async () => {
      apply.disabled = true;
      try {
        const updated = await loadTrack(
          track.id,
          new Uint8Array(
            await (await fetcher(`v1/replays/${track.id}`)).arrayBuffer(),
          ),
          { skin: skin.value || null, settings: editor.read() },
          fetcher,
        );
        await betweenFrames(() => {
          tracks[tracks.indexOf(track)] = updated;
          track.dispose();
          refreshComposition();
        });
        renderTracks();
        inform(`Updated ${updated.replay.player}`);
      } catch (error) {
        apply.disabled = false;
        report(error);
      }
    };
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save as preset";
    save.disabled = !vosu.canWrite;
    save.title = `Apply this skin and these settings whenever ${track.replay.player} is added`;
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.onclick = () =>
      betweenFrames(() => {
        tracks.splice(tracks.indexOf(track), 1);
        track.dispose();
        refreshComposition();
        renderTracks();
      }).catch(report);
    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(apply, save, remove);
    row.append(head, map, skinField);
    const skinNote = skins.note(track.skin ?? "");
    if (skinNote) {
      const note = document.createElement("p");
      note.className = "track-warning";
      note.textContent = skinNote;
      row.append(note);
    }
    if (track.warning) {
      const warning = document.createElement("p");
      warning.className = "track-warning";
      warning.textContent = track.warning;
      row.append(warning);
    }
    row.append(editor.details, actions);
    list.append(row);
  });
}
async function refreshInstalled() {
  const names = (await (await fetcher("v1/replays")).json()) as string[];
  const select = el<HTMLSelectElement>("installed");
  select.replaceChildren(
    new Option(names.length ? "Choose a replay" : "No replays found", ""),
  );
  for (const name of names) select.add(new Option(name, name));
}
el("dashboard").setAttribute("href", vosu.dashboardUrl);
el("dashboard").setAttribute("target", "_blank");
await vosu.ready;
applyScheme();
const overlayEditor = new OverlayEditor(el("overlay-layout"));
if (!vosu.canWrite) {
  report(
    "Read-only session. Open this studio from the vosu dashboard to load replays, import skins and save presets.",
  );
  for (const id of ["files", "refresh", "add-installed", "queue", "webm", "osk"])
    el<HTMLButtonElement>(id).disabled = true;
  skins.describeReadOnly();
} else {
  try {
    const context = await (await fetcher("v1/context")).json();
    skins.update(context);
    defaultSettings = context.default_settings;
    presets = await (await fetcher("v1/presets")).json();
    inform("Ready. Add replays to start a timeline.");
    await refreshInstalled();
  } catch (error) {
    report(error);
  }
}
async function addFiles(files: Iterable<File>) {
  for (const file of files) {
    try {
      await add(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      report(error);
    }
  }
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
el("refresh").onclick = () =>
  refreshInstalled()
    .then(() => inform("Rescanned osu! Replays"))
    .catch(report);
el("add-installed").onclick = async () => {
  try {
    const name = el<HTMLSelectElement>("installed").value;
    if (!name) throw new Error("Choose a replay first");
    await add(
      new Uint8Array(
        await (
          await fetcher(`v1/replays/${encodeURIComponent(name)}?installed=1`)
        ).arrayBuffer(),
      ),
    );
  } catch (error) {
    report(error);
  }
};
for (const id of ["layout", "resolution"])
  el(id).onchange = () => betweenFrames(refreshComposition).catch(report);
el("play").onclick = () => {
  playing = !playing;
  el("play").classList.toggle("playing", playing);
  el("play").setAttribute("aria-label", playing ? "Pause" : "Play");
  last = performance.now();
};
el<HTMLInputElement>("seek").oninput = () => {
  time = Number(el<HTMLInputElement>("seek").value);
};
async function animate(now: number) {
  if (playing && composition) {
    time += (now - last) * (tracks[0]?.replay.rate ?? 1);
    if (time > composition.duration) {
      time = 0;
      playing = false;
      el("play").classList.remove("playing");
      el("play").setAttribute("aria-label", "Play");
    }
    el<HTMLInputElement>("seek").value = String(time);
  }
  if (composition && !exporting && !swapping) {
    try {
      previewFrame = composition.renderOffline(time);
      await previewFrame;
    } catch (error) {
      report(error);
    } finally {
      previewFrame = undefined;
    }
  }
  last = now;
  el("time").textContent = timecode(time);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
function setTally() {
  el("tally").classList.toggle("live", exporting || activeJobs.size > 0);
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
      resolution: el<HTMLSelectElement>("resolution").value,
      layout: el<HTMLSelectElement>("layout").value,
      overlays: overlayEditor.read(),
      out: el<HTMLInputElement>("out").value,
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
    row.dataset.state = "queued";
    const state = document.createElement("span"),
      message = document.createElement("p"),
      progress = document.createElement("progress"),
      cancel = document.createElement("button");
    state.className = "job-state";
    state.textContent = "queued";
    message.className = "job-message";
    message.textContent = request.out;
    progress.max = 1;
    cancel.type = "button";
    cancel.className = "quiet";
    cancel.textContent = "Cancel";
    cancel.onclick = () => {
      void fetcher(`v1/jobs/${job}`, { method: "DELETE" }).catch(report);
    };
    row.append(state, message, cancel, progress);
    el("jobs").prepend(row);
    activeJobs.add(job);
    setTally();
    const update = async () => {
      try {
        const current = await (await fetcher(`v1/jobs/${job}`)).json();
        progress.value = current.progress;
        message.textContent = current.message;
        row.dataset.state = current.state;
        state.textContent = current.state;
        if (["done", "failed", "cancelled"].includes(current.state)) {
          cancel.remove();
          activeJobs.delete(job);
          setTally();
          if (current.result)
            message.textContent = `${current.result.out} · ${current.result.render_fps.toFixed(1)} render fps`;
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
      throw new Error(
        "Overlay layers need the MP4 queue; a WebM export in this tab cannot capture independent pages.",
      );
    playing = false;
    el("play").classList.remove("playing");
    composition.validate();
    exporting = true;
    setTally();
    for (const [control] of controls) control.disabled = true;
    await previewFrame;
    const first = tracks[0];
    const audio = await (
      await fetcher(
        `v1/assets?${new URLSearchParams({ kind: "map-asset", hash: first.replay.beatmapHash, path: first.map.general.AudioFilename })}`,
      )
    ).arrayBuffer();
    const blob = await exportWebM({
      fps: Number(el<HTMLInputElement>("fps").value),
      width: composition.width,
      height: composition.height,
      durationMs: composition.duration,
      rate: first.replay.rate,
      audio,
      render: (t) => composition!.renderOffline(t),
      progress: (p) => {
        inform(`Encoding WebM · ${(p * 100).toFixed(1)}%`);
      },
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "replay.webm";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    inform("WebM export complete");
  } catch (error) {
    report(error);
  } finally {
    exporting = false;
    setTally();
    for (const [control, disabled] of controls) control.disabled = disabled;
  }
};
