import { vosu } from "/tools/_host/v1/bridge.js";
import { parseOsu, type Beatmap, type Mod } from "@vosu-tools/osu-parse";
import {
  createRenderer,
  loadSkin,
  type Renderer,
  type Skin,
} from "@vosu-tools/render-core";
import { openOsk } from "./osk";
import { hostSkinFiles, readCurrentSkin } from "./skin-source";
import "./style.css";

// The tool owns its look; the dashboard's mode is only a hint.
const applyScheme = () => {
  document.documentElement.dataset.scheme =
    vosu.colorScheme ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
};
applyScheme();

const canvas = document.querySelector<HTMLCanvasElement>("#playfield")!,
  status = document.querySelector<HTMLElement>("#status")!,
  play = document.querySelector<HTMLButtonElement>("#play")!,
  seek = document.querySelector<HTMLInputElement>("#seek")!,
  rate = document.querySelector<HTMLInputElement>("#rate")!,
  skinPanel = document.getElementById("skin-panel")!,
  skinName = document.getElementById("skin-name")!,
  skinSource = document.getElementById("skin-source")!,
  skinMessage = document.getElementById("skin-message")!,
  audio = new Audio();
let renderer: Renderer | undefined,
  map: Beatmap | undefined,
  selectedSkin: Skin | undefined,
  objectUrl: string | undefined,
  loadSequence = 0,
  skinSequence = 0,
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
function skinNotice(
  message: string,
  tone: "info" | "notice" | "error" = "info",
): void {
  skinMessage.textContent = message;
  skinMessage.dataset.tone = tone;
}
/** Installs a skin (or the built-in defaults when `skin` is undefined). */
function installSkin(
  skin: Skin | undefined,
  label: string,
  source: string,
): void {
  renderer?.setSkin(skin);
  const previous = selectedSkin;
  selectedSkin = skin;
  if (previous) for (const bitmap of previous.assets.values()) bitmap.close();
  skinName.textContent = label;
  skinSource.textContent = source;
}
const useDefaults = () =>
  installSkin(undefined, "Default elements", "Built into Map preview");
/** Runs a skin load; a later choice always wins over one still loading. */
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
function currentSkin(): Promise<void> {
  return loadSkinFrom(
    "Asking vosu for the current skin…",
    async (isCurrent) => {
      const current = await readCurrentSkin();
      if (!isCurrent()) return;
      if (current.kind === "defaults") {
        useDefaults();
        skinNotice(current.message, "notice");
        return;
      }
      const client = current.info.client!;
      skinNotice(`Loading “${current.name}” from ${client}…`);
      const host = hostSkinFiles(),
        skin = await loadSkin(host.resolve, current.name);
      if (!isCurrent()) {
        for (const bitmap of skin.assets.values()) bitmap.close();
        return;
      }
      if (!host.served) {
        useDefaults();
        skinNotice(
          host.failures
            ? `vosu could not serve the files of “${current.name}”, so default elements are shown. Load an .osk file or a skin folder instead.`
            : `“${current.name}” has no skin.ini or gameplay elements that Map preview draws, so default elements are shown.`,
          "notice",
        );
        return;
      }
      installSkin(
        skin,
        current.name,
        `${client} · current skin · ${fileCount(host.served)}`,
      );
      skinNotice(
        `Loaded the current ${client} skin. Elements it lacks use defaults.`,
      );
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
  const skin = await loadSkin(async (path) => {
    const blob = await resolve(path);
    if (blob) used++;
    return blob;
  }, name);
  if (!isCurrent()) {
    for (const bitmap of skin.assets.values()) bitmap.close();
    return;
  }
  if (!used) {
    useDefaults();
    skinNotice(
      `“${name}” contains no skin.ini or gameplay elements that Map preview draws, so default elements are shown.`,
      "notice",
    );
    return;
  }
  installSkin(skin, name, `${source} · ${fileCount(used)} used`);
  skinNotice(`Loaded “${name}”. Elements it lacks use defaults.`);
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
  inputs.cs.max = map.mode === 3 ? "18" : "11";
  inputs.cs.step = map.mode === 3 ? "1" : "0.1";
  if (!map.objects.length)
    throw new Error("This beatmap contains no hit objects");
  if (!renderer) {
    // The current skin loads alongside the map; one installed while the
    // renderer was being created must still reach it.
    const skin = selectedSkin;
    renderer = await createRenderer({
      canvas,
      skin,
      presentation:
        new URLSearchParams(location.search).get("presentation") === "bitmap"
          ? "bitmap"
          : "direct",
    });
    if (selectedSkin !== skin) renderer.setSkin(selectedSkin);
  }
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
    `${map.metadata.Version ?? ""} · mapped by ${map.metadata.Creator ?? "unknown"} · ${map.objects.length.toLocaleString()} objects`;
  const mode = document.getElementById("mode")!;
  mode.textContent = ["OSU!", "TAIKO", "CATCH", "MANIA"][map.mode];
  mode.dataset.mode = String(map.mode);
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
document.querySelector<HTMLInputElement>("#skin-osk")!.onchange = (event) => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const name = file.name.replace(/\.(osk|zip)$/i, "");
  void loadSkinFrom(`Reading “${file.name}”…`, async (isCurrent) => {
    const archive = await openOsk(file);
    if (!isCurrent()) return;
    await userSkin(name, ".osk file", archive.resolve, isCurrent);
  });
};
document.querySelector<HTMLInputElement>("#skin-folder")!.onchange = (
  event,
) => {
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
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animation);
  audio.pause();
  renderer?.destroy();
  if (selectedSkin)
    for (const bitmap of selectedSkin.assets.values()) bitmap.close();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
try {
  await vosu.ready;
  applyScheme();
  document.getElementById("version")!.textContent =
    `Map preview ${vosu.tool.version}`.trim();
  void currentSkin();
  await currentMap();
} catch (error) {
  showError(error);
}
