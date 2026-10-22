import { vosu } from "/tools/_host/v1/bridge.js";
import { parseOsu, type Beatmap, type Mod } from "@vosu-tools/osu-parse";
import {
  createRenderer,
  loadSkin,
  type Renderer,
} from "@vosu-tools/render-core";
import "./style.css";
const canvas = document.querySelector<HTMLCanvasElement>("#playfield")!,
  status = document.querySelector<HTMLElement>("#status")!,
  play = document.querySelector<HTMLButtonElement>("#play")!,
  seek = document.querySelector<HTMLInputElement>("#seek")!,
  rate = document.querySelector<HTMLInputElement>("#rate")!,
  audio = new Audio();
let renderer: Renderer | undefined,
  map: Beatmap | undefined,
  objectUrl: string | undefined,
  loadSequence = 0,
  animation = 0,
  manualTime = 0;
const inputs = Object.fromEntries(
  ["ar", "cs", "scroll", "note-speed", "seed"].map((id) => [
    id,
    document.getElementById(id) as HTMLInputElement,
  ]),
);
function showError(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function refreshScene(): void {
  if (!map || !renderer) return;
  const mods: Mod[] = [
    ...document.querySelectorAll<HTMLInputElement>("#mods input:checked"),
  ].map((i) => ({
    acronym: i.value,
    settings:
      i.value === "RD" ? { seed: Number(inputs.seed.value) } : undefined,
  }));
  renderer.setBeatmap(map, {
    mods,
    ar: inputs.ar.value === "" ? undefined : Number(inputs.ar.value),
    cs: inputs.cs.value === "" ? undefined : Number(inputs.cs.value),
    scrollSpeed: Number(inputs.scroll.value),
    noteSpeed: Number(inputs["note-speed"].value),
  });
  renderer.renderAt(audio.readyState ? audio.currentTime * 1000 : manualTime);
}
function tick(): void {
  if (renderer && map) {
    const now = audio.readyState ? audio.currentTime * 1000 : manualTime;
    renderer.renderAt(now);
    seek.value = String(now);
    const ms = Math.round(now),
      minutes = Math.floor(ms / 60000),
      seconds = Math.floor(ms / 1000) % 60;
    document.querySelector<HTMLOutputElement>("#time")!.value =
      `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  }
  animation = requestAnimationFrame(tick);
}
async function openMap(text: string, audioSource?: string): Promise<void> {
  audio.pause();
  manualTime = 0;
  play.textContent = "Play";
  map = parseOsu(text);
  if (!map.objects.length)
    throw new Error("This beatmap contains no hit objects");
  if (!renderer) renderer = await createRenderer({ canvas });
  refreshScene();
  if (audioSource) {
    audio.src = audioSource;
    audio.load();
  }
  seek.max = String(map.duration + 2000);
  play.disabled = !audio.src;
  document.getElementById("title")!.textContent =
    `${map.metadata.Artist ?? ""} — ${map.metadata.Title ?? "Untitled"}`;
  document.getElementById("detail")!.textContent =
    `${map.metadata.Version ?? ""} / ${map.metadata.Creator ?? ""} / ${map.objects.length.toLocaleString()} objects`;
  document.getElementById("mode")!.textContent = [
    "OSU!",
    "TAIKO",
    "CATCH",
    "MANIA",
  ][map.mode];
  status.textContent = audioSource
    ? ""
    : "Choose the map’s audio file to enable synchronized playback.";
  if (!animation) tick();
}
async function currentMap(): Promise<void> {
  const seq = ++loadSequence;
  status.textContent = "Loading selected beatmap…";
  try {
    const response = await fetch("/files/beatmap/file", { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        `No selected beatmap is available (${response.status}). Select a map in osu! or open an .osu file.`,
      );
    const text = await response.text();
    if (seq !== loadSequence) return;
    await openMap(text, `/files/beatmap/audio?v=${Date.now()}`);
  } catch (error) {
    showError(error);
  }
}
async function currentSkin(): Promise<void> {
  status.textContent = "Loading current skin…";
  try {
    const skin = await loadSkin(async (name) => {
      const response = await fetch(`/files/skin/${encodeURIComponent(name)}`);
      return response.ok ? response.blob() : null;
    });
    renderer?.setSkin(skin);
    document.getElementById("skin-name")!.textContent = "Client’s current skin";
    status.textContent = "";
  } catch (error) {
    showError(error);
  }
}
play.onclick = async () => {
  try {
    if (audio.paused) {
      await audio.play();
      play.textContent = "Pause";
      status.textContent = "";
    } else {
      audio.pause();
      play.textContent = "Play";
    }
  } catch (error) {
    showError(error);
  }
};
audio.onended = () => {
  play.textContent = "Play";
};
audio.onerror = () => {
  play.disabled = true;
  status.textContent =
    "Audio is unavailable. Choose the matching audio file to play; seeking still previews map time.";
};
seek.oninput = () => {
  manualTime = Number(seek.value);
  if (audio.readyState) audio.currentTime = manualTime / 1000;
  renderer?.renderAt(manualTime);
};
rate.onchange = () => {
  audio.playbackRate = Math.max(0.25, Math.min(3, Number(rate.value) || 1));
  rate.value = String(audio.playbackRate);
  audio.preservesPitch = false;
};
for (const input of Object.values(inputs))
  input.onchange = () => {
    try {
      refreshScene();
    } catch (error) {
      showError(error);
    }
  };
for (const input of document.querySelectorAll<HTMLInputElement>("#mods input"))
  input.onchange = () => {
    if (input.checked) {
      const other =
        input.value === "HR" ? "EZ" : input.value === "EZ" ? "HR" : null;
      if (other)
        document.querySelector<HTMLInputElement>(
          `#mods input[value=${other}]`,
        )!.checked = false;
    }
    refreshScene();
  };
document.getElementById("reload")!.onclick = () => void currentMap();
document.getElementById("current-skin")!.onclick = () => void currentSkin();
document.querySelector<HTMLInputElement>("#map-file")!.onchange = async (
  event,
) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    loadSequence++;
    audio.removeAttribute("src");
    await openMap(await file.text());
  } catch (error) {
    showError(error);
  }
};
document.querySelector<HTMLInputElement>("#audio-file")!.onchange = (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  play.disabled = !map;
  status.textContent = "";
};
document.querySelector<HTMLInputElement>("#skin-folder")!.onchange = async (
  event,
) => {
  const files = (event.target as HTMLInputElement).files;
  if (!files?.length) return;
  status.textContent = "Loading selected skin…";
  try {
    const lookup = new Map<string, File>();
    for (const file of files) lookup.set(file.name.toLowerCase(), file);
    const name = files[0].webkitRelativePath.split("/")[0],
      skin = await loadSkin(
        async (name) => lookup.get(name.toLowerCase()) ?? null,
        name,
      );
    renderer?.setSkin(skin);
    document.getElementById("skin-name")!.textContent = name;
    status.textContent = "";
  } catch (error) {
    showError(error);
  }
};
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animation);
  audio.pause();
  renderer?.destroy();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
try {
  await vosu.ready;
  await currentMap();
  if (renderer) await currentSkin();
} catch (error) {
  showError(error);
}
