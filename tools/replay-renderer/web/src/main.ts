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
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const notice = el("notice");
const tracks: Track[] = [];
let presets: Record<string, Preset> = {},
  skins: string[] = [];
let composition: Composition | undefined,
  playing = false,
  time = 0,
  last = 0;
let defaultSettings: Record<string, number> = {},
  exporting = false;
let previewFrame: Promise<HTMLCanvasElement> | undefined;
const fetcher = async (path: string, init?: RequestInit) =>
  checked(await vosu.fetch(path, init));
function report(error: unknown) {
  notice.textContent = String(error);
}
function refreshComposition() {
  composition?.releaseTargets();
  if (!tracks.length) {
    composition = undefined;
    el("preview").textContent = "Add a replay to begin.";
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
}
async function add(bytes: Uint8Array<ArrayBuffer>) {
  const replay = await parseReplay(bytes);
  const saved = presets[replay.player];
  const preset = {
    skin: saved?.skin,
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
  tracks.push(track);
  try {
    refreshComposition();
  } catch (error) {
    tracks.pop();
    track.renderer.destroy();
    refreshComposition();
    throw error;
  }
  renderTracks();
  notice.textContent =
    track.warning ||
    `Loaded ${replay.player} · ${replay.frames.length.toLocaleString()} replay frames`;
}
function renderTracks() {
  el("tracks").replaceChildren();
  for (const track of tracks) {
    const row = document.createElement("article");
    row.className = "track";
    const name = document.createElement("strong");
    name.textContent = track.replay.player;
    const detail = document.createElement("small");
    detail.textContent = `${track.map.metadata.Title} [${track.map.metadata.Version}] · ${track.replay.rate}×`;
    const skinLabel = document.createElement("label");
    skinLabel.textContent = "Skin";
    const skin = document.createElement("select");
    for (const name of ["", ...skins]) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name || "Current skin";
      skin.append(option);
    }
    skin.value = track.skin ?? "";
    skinLabel.append(skin);
    const speedLabel = document.createElement("label");
    speedLabel.textContent = "Mania scroll speed";
    const speed = document.createElement("input");
    speed.type = "number";
    speed.min = "1";
    speed.max = "100";
    speed.value = String(track.settings["mania.scroll_speed"] ?? 20);
    speedLabel.append(speed);
    speed.disabled = track.replay.mode !== 3;
    const apply = document.createElement("button");
    apply.textContent = "Apply";
    apply.onclick = async () => {
      try {
        const value = Number(speed.value);
        if (!Number.isFinite(value) || value < 1 || value > 100)
          throw new Error("Scroll speed must be 1..100");
        const updated = await loadTrack(
          track.id,
          new Uint8Array(
            await (await fetcher(`v1/replays/${track.id}`)).arrayBuffer(),
          ),
          {
            skin: skin.value || null,
            settings: { "mania.scroll_speed": value },
          },
          fetcher,
        );
        const index = tracks.indexOf(track);
        track.renderer.destroy();
        tracks[index] = updated;
        refreshComposition();
        renderTracks();
      } catch (error) {
        report(error);
      }
    };
    const save = document.createElement("button");
    save.textContent = "Save player preset";
    save.disabled = !vosu.canWrite;
    save.onclick = async () => {
      try {
        const preset = {
          skin: skin.value || null,
          settings: { "mania.scroll_speed": Number(speed.value) },
        };
        await fetcher(`v1/presets/${encodeURIComponent(track.replay.player)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(preset),
        });
        presets[track.replay.player] = preset;
        report(`Preset saved for ${track.replay.player}`);
      } catch (error) {
        report(error);
      }
    };
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.onclick = () => {
      tracks.splice(tracks.indexOf(track), 1);
      track.renderer.destroy();
      refreshComposition();
      renderTracks();
    };
    const controls = document.createElement("div");
    controls.className = "row";
    controls.append(apply, remove);
    row.append(name, detail, skinLabel, speedLabel, controls, save);
    if (track.warning) {
      const warning = document.createElement("small");
      warning.textContent = track.warning;
      row.append(warning);
    }
    el("tracks").append(row);
  }
}
async function refreshInstalled() {
  const names = (await (await fetcher("v1/replays")).json()) as string[];
  const select = el<HTMLSelectElement>("installed");
  select.replaceChildren(new Option("Choose from osu! Replays", ""));
  for (const name of names) select.add(new Option(name, name));
}
await vosu.ready;
if (!vosu.canWrite) {
  report(
    "Read-only session. Open this studio from the vosu dashboard to load local assets and save presets.",
  );
  for (const id of ["files", "refresh", "add-installed", "queue", "webm"])
    el<HTMLButtonElement>(id).disabled = true;
} else {
  try {
    const context = await (await fetcher("v1/context")).json();
    skins = context.skins;
    defaultSettings = context.default_settings;
    presets = await (await fetcher("v1/presets")).json();
    await refreshInstalled();
    notice.textContent = "Ready · Add .osr files or pick an installed replay.";
  } catch (error) {
    report(error);
  }
}
el<HTMLInputElement>("files").onchange = async (event) => {
  for (const file of (event.target as HTMLInputElement).files ?? []) {
    try {
      await add(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      report(error);
    }
  }
  (event.target as HTMLInputElement).value = "";
};
el("drop").ondragover = (event) => {
  event.preventDefault();
};
el("drop").ondrop = async (event) => {
  event.preventDefault();
  if (!vosu.canWrite) return;
  for (const file of event.dataTransfer?.files ?? []) {
    try {
      await add(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      report(error);
    }
  }
};
el("refresh").onclick = () => refreshInstalled().catch(report);
el("add-installed").onclick = async () => {
  try {
    const name = el<HTMLSelectElement>("installed").value;
    if (name)
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
  el(id).onchange = () => {
    try {
      refreshComposition();
    } catch (error) {
      report(error);
    }
  };
el("play").onclick = () => {
  playing = !playing;
  el("play").textContent = playing ? "Pause" : "Play";
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
    }
    el<HTMLInputElement>("seek").value = String(time);
  }
  if (composition && !exporting) {
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
  el("time").textContent =
    `${Math.floor(time / 60000)}:${String(Math.floor(time / 1000) % 60).padStart(2, "0")}`;
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
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
      out: el<HTMLInputElement>("out").value,
    };
    const { job } = await (
      await fetcher("v1/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
    ).json();
    const row = document.createElement("div");
    row.className = "job";
    const message = document.createElement("p"),
      progress = document.createElement("progress"),
      cancel = document.createElement("button");
    progress.max = 1;
    cancel.textContent = "Cancel";
    cancel.onclick = () => {
      void fetcher(`v1/jobs/${job}`, { method: "DELETE" }).catch(report);
    };
    row.append(message, progress, cancel);
    el("jobs").prepend(row);
    const update = async () => {
      try {
        const state = await (await fetcher(`v1/jobs/${job}`)).json();
        progress.value = state.progress;
        message.textContent = state.message;
        if (["done", "failed", "cancelled"].includes(state.state)) {
          cancel.remove();
          if (state.result)
            message.textContent += ` · ${state.result.render_fps.toFixed(1)} render fps · ${state.result.out}`;
        } else
          setTimeout(() => {
            void update();
          }, 500);
      } catch (error) {
        report(error);
      }
    };
    void update();
  } catch (error) {
    report(error);
  }
};
el("webm").onclick = async () => {
  const button = el<HTMLButtonElement>("webm");
  const controls = [
    ...document.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >("button,input,select"),
  ].map((control) => [control, control.disabled] as const);
  try {
    if (!composition) throw new Error("Add a replay first");
    playing = false;
    composition.validate();
    button.disabled = true;
    exporting = true;
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
        notice.textContent = `Browser export ${(p * 100).toFixed(1)}%`;
      },
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "replay.webm";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notice.textContent = "WebM export complete";
  } catch (error) {
    report(error);
  } finally {
    exporting = false;
    for (const [control, disabled] of controls) control.disabled = disabled;
  }
};
