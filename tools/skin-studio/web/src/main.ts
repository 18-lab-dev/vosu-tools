import { vosu } from "/tools/_host/v1/bridge.js";
import {
  addManiaBlock,
  maniaKeyCounts as blockKeyCounts,
  maniaValue,
  parse,
  resolve,
  setManiaValue,
  validate,
} from "@vosu-tools/skin-spec";
import "./style.css";
import type { IniEditor } from "./editor";
import { TextDoc, rgb } from "./text-doc";
import {
  type Category,
  type Group,
  audioExt,
  categories,
  frames,
  groups,
  stem,
} from "./groups";
import {
  type Pick,
  type Plan,
  type Recipe,
  type SkinData,
  compose,
  groupById,
  groupFiles,
  hasEdits,
  inPlaceRemovals,
  maniaGroup,
  maniaKeyCounts,
  recipeSkins,
} from "./plan";
import { getValue, maniaBlocks, parseIni } from "./ini";
import {
  type AssetRef,
  type Carry,
  type OverrideNote,
  assetId,
  fontOf,
  fontPrefixes,
  groupOf,
  parseAssetId,
  unitFiles,
} from "./assets";
import type { Preview, Resolver } from "./preview";
import { $, h } from "./dom";
import { Explorer } from "./explorer";
import { KeymodesView } from "./keymodes-view";
import {
  UPLOADS,
  formatBytes,
  removeQuestion,
  uploadUsage,
  type UploadFile,
} from "./uploads";
import { touchedKeys, type KeymodeDraft } from "./keymodes";
import {
  canWrite,
  dashboardTools,
  isSessionRefusal,
  onSessionChange,
  readOnlyReason,
  sessionLost,
} from "./session";
import type { Speed } from "./calibrate";
import {
  type ExportReport,
  type ExportTarget,
  TARGETS,
  convertRequest,
  isTarget,
  mixKeyCounts,
  reportLines,
  supports,
  targetNote,
} from "./export-targets";
import { maniaDemo, type DemoId } from "@vosu-tools/demo-maps";

interface Skin {
  key: string;
  name: string;
  origin: "stable" | "added" | "osk" | "lazer";
  current: boolean;
  available: boolean;
  writable: boolean;
  creator?: string;
  builtin?: string;
}
interface Library {
  client: "stable" | "lazer" | null;
  current: {
    name: string | null;
    files: boolean;
    builtin: string | null;
  } | null;
  stable_dir: string | null;
  lazer: { enabled: boolean; available: boolean; error: string | null };
  settings: { start_ruleset: string; credits: boolean };
  skins: Skin[];
}
interface Snapshot {
  text: string;
  revision: string;
  files: { name: string; size: number }[];
  writable: boolean;
}
interface Loaded {
  snapshot: Snapshot;
  data: SkinData;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const status = $("#status");
const player = $<HTMLAudioElement>("#player");
const save = $<HTMLButtonElement>("#save");
const reload = $<HTMLButtonElement>("#reload");

// ---- audio previews: muted by default, remembered per tool ------------------
const MUTE_KEY = "skin-studio:muted";
const mute = $<HTMLButtonElement>("#mute");
function setMuted(muted: boolean) {
  player.muted = muted;
  mute.setAttribute("aria-pressed", String(muted));
  mute.textContent = muted ? "Muted" : "Sound on";
  localStorage.setItem(MUTE_KEY, String(muted));
}
setMuted(localStorage.getItem(MUTE_KEY) !== "false");
mute.onclick = () => setMuted(!player.muted);

// ---- state ---------------------------------------------------------------
let library: Library | null = null;
let libraryError = "";
const loaded = new Map<string, Loaded>();
let focused: string | null = null;
let category: Category = "osu";
let categoryChosen = false;
let view: "elements" | "explorer" | "keymodes" | "ini" | "preview" =
  "elements";
/** The Explorer tab (created once the rest of the page is wired). */
let explorer: Explorer | undefined;
let iniMode: "focus" | "mix" = "focus";
let saving = false;
let conflict = false;
let diskRevision = "";
let savedText = "";
let composedIni = "";
let composeError = "";
let counts = new Map<string, number>();
let blanks = 0;
let notes = new Map<string, OverrideNote>();
/** Per picked group: base elements the client will draw from its own skin. */
let fallbacks = new Map<string, string[]>();
function fallbackLine(gid: string) {
  const lost = fallbacks.get(gid);
  if (!lost?.length) return null;
  return h(
    "span",
    { class: "pick-fallback", title: lost.join("\n") },
    lost.length === 1
      ? `${lost[0]} falls back to osu!'s built-in look`
      : `${lost.length} elements fall back to osu!'s built-in look`,
  );
}
/** The last composed plan (skin.ini replaced by the draft text when built). */
let lastPlan: Plan | null = null;
let mixVersion = 0;
let currentSkinName: string | null = null;

// Two drafts: "current" edits a skin in place (by default the one osu! uses;
// its `base` is that skin), "new" mixes a new skin. Each holds only skin
// names/paths the user picked and the edits; never sessions. Nothing is
// written to a skin until Apply changes (or an export).
type EditMode = "current" | "new";
const RECIPE_KEY = "skin-studio:recipe";
const EDIT_KEY = "skin-studio:edit";
const MODE_KEY = "skin-studio:mode";
const readRecipe = (key: string, fallback: Recipe): Recipe => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    if (stored && typeof stored.name === "string" && stored.picks)
      return stored as Recipe;
  } catch {
    /* fall through to a fresh recipe */
  }
  return fallback;
};
let editMode: EditMode =
  localStorage.getItem(MODE_KEY) === "new" ? "new" : "current";
const recipes: Record<EditMode, Recipe> = {
  new: readRecipe(RECIPE_KEY, { name: "My mix", base: null, picks: {} }),
  current: readRecipe(EDIT_KEY, { name: "", base: null, picks: {} }),
};
recipes.current.inPlace = true;
let recipe: Recipe = recipes[editMode];
const persist = () =>
  localStorage.setItem(
    editMode === "new" ? RECIPE_KEY : EDIT_KEY,
    JSON.stringify(recipe),
  );

const toolBase = `/tools/${encodeURIComponent(vosu.tool.id)}/api/`;
const assetUrl = (skin: string, name: string) =>
  `${toolBase}v1/asset?skin=${encodeURIComponent(skin)}&name=${encodeURIComponent(name)}`;
const animationUrl = (skin: string, element: string) =>
  `${toolBase}v1/animation?skin=${encodeURIComponent(skin)}&element=${encodeURIComponent(element)}`;

class HttpError extends Error {
  constructor(
    text: string,
    readonly status: number,
  ) {
    super(text);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await vosu.fetch(path, init);
  if (!response.ok) {
    const text = (await response.text()) || response.statusText;
    if (isSessionRefusal(response.status, text)) {
      sessionLost();
      throw new HttpError(
        "This tab can no longer write: vosu restarted and forgot its session. Open Skin studio from the dashboard again; the draft is kept.",
        response.status,
      );
    }
    throw new HttpError(text, response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const skinByKey = (key: string | null) =>
  key ? library?.skins.find((s) => s.key === key) : undefined;
const skinName = (key: string) =>
  key === UPLOADS ? "Dropped files" : (skinByKey(key)?.name ?? key);

async function load(key: string, fresh = false): Promise<Loaded> {
  const cached = loaded.get(key);
  if (cached && !fresh) return cached;
  const snapshot = await request<Snapshot>(
    `v1/skin?skin=${encodeURIComponent(key)}`,
  );
  const entry = {
    snapshot,
    data: {
      key,
      name: skinName(key),
      text: snapshot.text,
      files: snapshot.files.map((f) => f.name),
    },
  };
  loaded.set(key, entry);
  return entry;
}

// ---- editor --------------------------------------------------------------
// skin.ini text lives in TextDocs; Monaco (and its CSS, font and worker) is
// only fetched for the skin.ini tab, prefetched once the first view is idle.
const focusDoc = new TextDoc();
const mixDoc = new TextDoc();
let iniEditor: IniEditor | undefined;
let editorLoading: Promise<IniEditor> | undefined;
function ensureEditor(): Promise<IniEditor> {
  editorLoading ??= import("./editor")
    .then(({ createIniEditor }) =>
      createIniEditor($("#editor"), () => {
        if (!save.disabled) void storeIni();
      }),
    )
    .then((created) => {
      iniEditor = created;
      renderIni();
      return created;
    })
    .catch((error) => {
      editorLoading = undefined;
      status.textContent = `Editor unavailable: ${message(error)}`;
      throw error;
    });
  return editorLoading;
}
/** Warms the HTTP cache with the editor's files without running them. */
async function prefetchEditor() {
  try {
    const files: string[] = await (
      await fetch("./editor-prefetch.json")
    ).json();
    for (const file of files) {
      const link = document.createElement("link");
      link.rel = file.endsWith(".js") ? "modulepreload" : "prefetch";
      link.href = `./${file}`;
      document.head.append(link);
    }
  } catch {
    // Dev server or no manifest: the tab still loads it on first use.
  }
}
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!save.disabled) void storeIni();
  }
});
const focusDirty = () => focused !== null && focusDoc.getValue() !== savedText;
const mixEdited = () => mixDoc.getValue() !== composedIni;

function renderIni() {
  const model = iniMode === "focus" ? focusDoc : mixDoc;
  iniEditor?.show(model);
  const loadedFocus = focused ? loaded.get(focused) : undefined;
  // The skin being edited in place changes only through the draft.
  const drafted = editMode === "current" && !!focused && focused === recipe.base;
  const writable =
    iniMode === "focus" &&
    !!loadedFocus?.snapshot.writable &&
    canWrite() &&
    !drafted;
  iniEditor?.setReadOnly(iniMode === "focus" && !writable);
  $("#ini-focus").setAttribute("aria-pressed", String(iniMode === "focus"));
  $("#ini-mix").setAttribute("aria-pressed", String(iniMode === "mix"));
  $("#ini-mix").textContent = editMode === "current" ? "Draft" : "Mix draft";
  save.hidden = reload.hidden = iniMode !== "focus";
  $("#ini-reset").hidden = iniMode !== "mix" || !mixEdited();
  save.disabled = !writable || saving || conflict || !focusDirty();
  reload.disabled = !focused || saving;
  const skin = skinByKey(focused);
  const note = $("#ini-note");
  note.textContent =
    iniMode === "mix"
      ? mixEdited()
        ? "Edited"
        : ""
      : drafted && iniMode === "focus"
        ? "Edit it in the draft"
        : focused && !writable
        ? skin?.origin === "lazer" || skin?.origin === "osk" || canWrite()
          ? "Read-only"
          : "Read-only tab"
        : "";
  note.hidden = !note.textContent;
  note.title =
    iniMode === "mix"
      ? "Used as-is when you build"
      : !loadedFocus?.snapshot.writable &&
          skin?.origin !== "lazer" &&
          skin?.origin !== "osk"
        ? "Not UTF-8"
        : "";
  // Diagnostics are only shown on the skin.ini tab; skip them elsewhere.
  if (view !== "ini") return;
  const issues = (model.issues = validate(model.getValue(), model.files));
  iniEditor?.mark(model);
  $("#issue-count").textContent = String(issues.length);
  $("#diagnostics").replaceChildren(
    ...(issues.length
      ? issues.map((d) =>
          h(
            "li",
            { class: d.severity },
            h(
              "button",
              {
                type: "button",
                onclick: () => iniEditor?.reveal(d.line, d.column),
              },
              h("span", { class: "line" }, `L${d.line}`),
              h("span", { class: "message" }, d.message),
            ),
          ),
        )
      : [h("li", { class: "clean" }, "No problems.")]),
  );
}
focusDoc.onDidChangeContent(() => {
  renderIni();
  if (iniMode === "focus") renderColours();
});
mixDoc.onDidChangeContent(() => renderIni());

async function storeIni() {
  if (!focused) return;
  saving = true;
  renderIni();
  const text = focusDoc.getValue();
  try {
    const data = await post<{ revision: string; backup: string | null }>(
      "v1/save",
      { skin: focused, text, revision: diskRevision },
    );
    savedText = text;
    diskRevision = data.revision;
    const entry = loaded.get(focused);
    if (entry) {
      entry.snapshot.text = text;
      entry.snapshot.revision = data.revision;
      entry.data.text = text;
    }
    status.textContent = data.backup
      ? `Saved · backup ${data.backup}`
      : "Saved";
    scheduleCompose();
  } catch (error) {
    status.textContent = message(error);
  } finally {
    saving = false;
    renderIni();
  }
}

// ---- library -------------------------------------------------------------
const filter = $<HTMLInputElement>("#filter");
function renderLibrary() {
  const list = $("#skins");
  if (!library) {
    list.replaceChildren(
      h("p", { class: "v-empty" }, libraryError || "Loading…"),
    );
    return;
  }
  const query = filter.value.trim().toLowerCase();
  const sections: [string, Skin["origin"]][] = [
    ["Stable", "stable"],
    ["Added", "added"],
    [".osk", "osk"],
    ["Lazer", "lazer"],
  ];
  const nodes: Node[] = [];
  for (const [title, origin] of sections) {
    const all = library.skins.filter((s) => s.origin === origin);
    const shown = all.filter(
      (s) => !query || s.name.toLowerCase().includes(query),
    );
    let note: string | null = null;
    if (origin === "stable" && !library.stable_dir) note = "No Skins folder";
    if (origin === "lazer")
      note = !library.lazer.enabled
        ? "Hidden in settings"
        : library.lazer.error;
    if (!all.length && !note && (origin === "added" || origin === "osk"))
      continue;
    nodes.push(
      h(
        "div",
        { class: "v-label" },
        title,
        all.length ? h("span", {}, String(all.length)) : null,
      ),
    );
    if (note) nodes.push(h("p", { class: "note" }, note));
    nodes.push(
      h(
        "ul",
        {},
        ...shown.map((skin) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "skin",
                disabled: !skin.available,
                title:
                  skin.origin === "lazer" ? (skin.creator ?? "") : skin.key,
                ariaCurrent: String(skin.key === focused),
                onclick: () => void focus(skin.key),
              },
              h("span", { class: "name" }, skin.name),
              skin.current &&
                h("span", { class: "v-badge v-badge--accent" }, "current"),
              skin.builtin && h("span", { class: "v-badge" }, "built-in"),
              !skin.available &&
                !skin.builtin &&
                h("span", { class: "v-badge v-badge--error" }, "gone"),
              recipe.base === skin.key &&
                h("span", { class: "v-badge v-badge--ok" }, "base"),
            ),
            skin.origin === "added" || skin.origin === "osk"
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "v-btn v-btn--sm v-btn--ghost forget",
                    title: "Remove from the library; files stay",
                    ariaLabel: `Forget ${skin.name}`,
                    disabled: !canWrite(),
                    onclick: () => void forget(skin),
                  },
                  "Forget",
                )
              : null,
          ),
        ),
      ),
    );
  }
  if (
    query &&
    !nodes.some((n) => n instanceof HTMLUListElement && n.childElementCount)
  )
    nodes.push(h("p", { class: "v-empty" }, "No match."));
  list.replaceChildren(...nodes);
}
filter.addEventListener("input", renderLibrary);

async function loadLibrary(): Promise<Library | null> {
  try {
    library = await request<Library>("v1/library");
    libraryError = "";
    currentSkinName = library.current?.name ?? null;
  } catch (error) {
    libraryError = message(error);
  }
  renderLibrary();
  followCurrent();
  renderMix();
  explorer?.refreshSkins();
  if (!focused) renderFocus();
  return library;
}

async function forget(skin: Skin) {
  try {
    library = await post<Library>("v1/folders/forget", { skin: skin.key });
    loaded.delete(skin.key);
    explorer?.refreshSkins();
    if (focused === skin.key) await focus(null);
    status.textContent = `Forgot ${skin.name}`;
    renderLibrary();
  } catch (error) {
    status.textContent = message(error);
  }
}

const folderError = $("#folder-error");
const addForm = $<HTMLFormElement>("#add-folder");
const addToggle = $<HTMLButtonElement>("#add-toggle");
addToggle.onclick = () => {
  addForm.hidden = !addForm.hidden;
  addToggle.setAttribute("aria-expanded", String(!addForm.hidden));
  if (!addForm.hidden) $<HTMLInputElement>("#folder-path").focus();
};
addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("#folder-path");
  const path = input.value.trim();
  if (!path) return input.focus();
  const before = new Set(library?.skins.map((s) => s.key));
  folderError.hidden = true;
  input.removeAttribute("aria-invalid");
  try {
    library = await post<Library>("v1/folders/add", { path });
    explorer?.refreshSkins();
    input.value = "";
    addForm.hidden = true;
    addToggle.setAttribute("aria-expanded", "false");
    renderLibrary();
    const added = library.skins.find((s) => !before.has(s.key));
    if (added) await focus(added.key);
  } catch (error) {
    folderError.textContent = message(error);
    folderError.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }
});

// ---- focused skin ----------------------------------------------------------
async function focus(key: string | null) {
  if (focusDirty() && !confirm("Discard unsaved skin.ini changes?")) return;
  focused = key;
  conflict = false;
  renderLibrary();
  void explorer?.open(key);
  if (!key) {
    focusDoc.setValue("");
    savedText = "";
    renderFocus();
    return;
  }
  status.textContent = `Reading ${skinName(key)}…`;
  try {
    const { snapshot } = await load(key, true);
    if (focused !== key) return;
    diskRevision = snapshot.revision;
    focusDoc.files =
      skinByKey(key)?.origin === "lazer"
        ? undefined
        : snapshot.files.map((f) => f.name);
    focusDoc.setValue(snapshot.text);
    // Text is normalised as the editor stores it; compare against that.
    savedText = focusDoc.getValue();
    status.textContent = "";
  } catch (error) {
    status.textContent = message(error);
  }
  renderFocus();
}

function renderColours() {
  const doc = parse(focusDoc.getValue());
  const colours = doc.lines.filter((l) => {
    const s =
      l.section === "Colours" && l.key ? resolve(l.section, l.key) : null;
    return s && ["rgb", "rgba"].includes(s.type) && rgb(l.value);
  });
  $("#colour-bar").replaceChildren(
    ...colours.map((l) => {
      const c = rgb(l.value)!;
      const chip = h("span", { class: "chip" });
      chip.style.backgroundColor = `rgb(${c[0]} ${c[1]} ${c[2]})`;
      return h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            title: `${l.key}: ${l.value}`,
            ariaLabel: `${l.key} ${l.value}`,
            onclick: async () => {
              iniMode = "focus";
              showView("ini");
              (await ensureEditor()).reveal(l.line, l.valueColumn ?? 1);
            },
          },
          chip,
        ),
      );
    }),
  );
}

function renderFocus() {
  const skin = skinByKey(focused);
  const entry = focused ? loaded.get(focused) : undefined;
  $("#focus-name").textContent = skin?.name ?? "";
  const author = entry
    ? getValue(parseIni(entry.data.text), "General", "Author")
    : undefined;
  $("#focus-meta").textContent = skin
    ? [
        author ?? skin.creator ?? "",
        skin.origin === "lazer" ? "lazer" : skin.key,
        entry ? `${entry.snapshot.files.length} files` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const useBase = $<HTMLButtonElement>("#use-base");
  useBase.disabled = !focused || (editMode === "current" && !editable(skin));
  useBase.setAttribute(
    "aria-pressed",
    String(!!focused && recipe.base === focused),
  );
  useBase.textContent =
    editMode === "current"
      ? recipe.base === focused && focused
        ? "Editing this skin"
        : "Edit this skin"
      : recipe.base === focused && focused
        ? "Mix base"
        : "Use as mix base";
  useBase.title =
    editMode === "current" && skin && !editable(skin)
      ? ".osk files and dropped files are read-only: switch to New skin to mix from them"
      : "";
  const focusOsk = $<HTMLButtonElement>("#focus-osk");
  focusOsk.disabled = !entry || !canWrite();
  focusOsk.title = canWrite() ? "" : "Read-only tab";
  renderColours();
  $("#guide").hidden = !!focused || view !== "elements";
  $("#elements-view").hidden = !focused || view !== "elements";
  $("#ini-view").hidden = view !== "ini";
  $("#preview-view").hidden = view !== "preview";
  $("#explorer-view").hidden = view !== "explorer";
  $("#keymodes-view").hidden = view !== "keymodes";
  renderCats();
  renderGroups();
  renderIni();
  updatePreview();
}

// ---- elements --------------------------------------------------------------
function renderCats() {
  $("#cats").replaceChildren(
    ...categories.map((c) =>
      h(
        "button",
        {
          type: "button",
          ariaPressed: String(c.id === category),
          onclick: () => {
            category = c.id;
            categoryChosen = true;
            renderCats();
            renderGroups();
          },
        },
        c.label,
      ),
    ),
  );
}

function fps(data: SkinData, count: number) {
  const rate = Number(
    getValue(parseIni(data.text), "General", "AnimationFramerate"),
  );
  return Number.isFinite(rate) && rate > 0 ? rate : count;
}

/**
 * Collapses a group's files into preview tiles, one per mix unit: frames and
 * @2x variants join their image; in Numbers & fonts a prefix's glyphs are one font.
 */
function tiles(data: SkinData, owned: string[], fonts: boolean): Node[] {
  const nodes: Node[] = [];
  const glyphs = new Map<string, string[]>();
  if (fonts)
    for (const file of owned) {
      const prefix = fontOf(file);
      if (prefix) glyphs.set(prefix, [...(glyphs.get(prefix) ?? []), file]);
    }
  for (const [prefix, files] of glyphs) {
    const sample =
      files.find((f) => /-0@2x\.[^.]+$/i.test(f)) ??
      files.find((f) => /-0\.[^.]+$/i.test(f)) ??
      files[0];
    const count = new Set(files.map(stem)).size;
    nodes.push(
      tile(prefix, assetUrl(data.key, sample), `${count} glyphs`, {
        ref: { kind: "font", name: prefix },
        skin: data.key,
      }),
    );
  }
  const byStem = new Map<string, string[]>();
  // Glyphs of the skin's fonts (`hitcircle-1` under `HitCirclePrefix: hitcircle`)
  // are not animation frames of the element with the prefix's name.
  const prefixes = fonts ? undefined : fontPrefixes(parseIni(data.text));
  for (const file of owned) {
    if (fonts ? fontOf(file) : prefixes!.has(fontOf(file) ?? "")) continue;
    const s = stem(file);
    byStem.set(s, [...(byStem.get(s) ?? []), file]);
  }
  const animated = new Map<string, string[]>();
  for (const s of byStem.keys()) {
    const base = /^(.*?)-?\d+$/.exec(s)?.[1];
    if (base && !animated.has(base)) {
      const seq = frames(data.files, base);
      if (seq.length) animated.set(base, seq);
    }
  }
  const covered = new Set<string>();
  for (const [base, seq] of animated) {
    for (const f of seq) covered.add(stem(f));
    // A static image of the same name is shown with the animation.
    covered.add(base);
    nodes.push(
      tile(
        base,
        animationUrl(data.key, base),
        `${seq.length} frames · ${fps(data, seq.length)} fps${seq[0].includes("@2x") ? " · @2x" : ""}`,
        { ref: { kind: "image", name: base }, skin: data.key },
      ),
    );
  }
  for (const [s, files] of byStem) {
    if (covered.has(s)) continue;
    const audio = files.find((f) => audioExt.test(f));
    if (audio) {
      nodes.push(audioTile(data, s, audio));
      continue;
    }
    const hd = files.find((f) => /@2x\.[^.]+$/i.test(f));
    const file = hd ?? files[0];
    nodes.push(
      tile(s, assetUrl(data.key, file), hd ? "@2x" : "SD", {
        ref: { kind: "image", name: s },
        skin: data.key,
      }),
    );
  }
  return nodes;
}

/** Takes one asset from a skin into the mix, or drops it when it already is. */
function useAsset(ref: AssetRef, skin: string) {
  const id = assetId(ref);
  recipe.overrides ??= {};
  if (recipe.overrides[id]?.skin === skin) delete recipe.overrides[id];
  else recipe.overrides[id] = { skin };
  persist();
  renderGroups();
  renderMix();
  scheduleCompose();
}

/** The "Use in mix" toggle of a tile. */
function useButton(unit: { ref: AssetRef; skin: string }, label: string) {
  const current = recipe.overrides?.[assetId(unit.ref)];
  const pressed = current?.skin === unit.skin;
  const button = h(
    "button",
    {
      type: "button",
      class: "v-btn v-btn--sm use",
      ariaPressed: String(pressed),
      ariaLabel: `Use ${label} from this skin in the mix`,
      title: current && !pressed ? `In mix from ${skinName(current.skin)}` : "",
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        useAsset(unit.ref, unit.skin);
      },
    },
    pressed ? "In mix" : "Use in mix",
  );
  return button;
}

/** Opens the asset's files in the Explorer. */
function filesButton(unit: { ref: AssetRef; skin: string }, label: string) {
  return h(
    "button",
    {
      type: "button",
      class: "v-btn v-btn--sm v-btn--ghost files",
      ariaLabel: `Show the files of ${label} in Explorer`,
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        void revealInExplorer(unit.ref, unit.skin);
      },
    },
    "Files",
  );
}

function tile(
  label: string,
  src: string,
  meta: string,
  unit: { ref: AssetRef; skin: string },
) {
  const figure = h(
    "figure",
    { class: "tile", tabIndex: 0, title: `${label} · ${meta}` },
    h(
      "div",
      { class: "frame" },
      h("img", { src, alt: label, loading: "lazy", decoding: "async" }),
    ),
    h(
      "figcaption",
      {},
      h("span", { class: "tile-name" }, label),
      h("span", { class: "tile-meta" }, meta),
    ),
    h(
      "div",
      { class: "tile-actions" },
      useButton(unit, label),
      filesButton(unit, label),
    ),
  );
  figure.dataset.asset = assetId(unit.ref);
  const toggle = () => figure.classList.toggle("zoomed");
  figure.onclick = toggle;
  figure.onkeydown = (e) => {
    if (e.target !== figure) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  return figure;
}

function audioTile(data: SkinData, label: string, file: string) {
  const size =
    loaded.get(data.key)?.snapshot.files.find((f) => f.name === file)?.size ??
    0;
  const url = assetUrl(data.key, file);
  const button = h(
    "button",
    {
      type: "button",
      class: "v-btn v-btn--sm v-btn--icon play",
      ariaLabel: `Play ${file}`,
      onclick: () => play(url, file),
    },
    "▶",
  );
  button.dataset.src = url;
  const ref: AssetRef = { kind: "sound", name: label };
  const figure = h(
    "figure",
    { class: "tile audio" },
    button,
    h(
      "figcaption",
      {},
      h("span", { class: "tile-name" }, label),
      h(
        "span",
        { class: "tile-meta" },
        `${file.split(".").pop()} · ${size ? `${Math.max(1, Math.round(size / 1024))} KB` : "empty"}`,
      ),
    ),
    useButton({ ref, skin: data.key }, label),
    filesButton({ ref, skin: data.key }, label),
  );
  figure.dataset.asset = assetId(ref);
  return figure;
}
const syncPlayer = () =>
  document.querySelectorAll<HTMLButtonElement>("button.play").forEach((b) => {
    const playing = b.dataset.src === player.dataset.src && !player.paused;
    b.textContent = playing ? "❚❚" : "▶";
    b.classList.toggle("playing", playing);
  });
player.addEventListener("play", syncPlayer);
player.addEventListener("pause", syncPlayer);
player.addEventListener("ended", syncPlayer);

function pickLabel(pick: Pick | undefined) {
  if (!pick) return recipe.base ? `base · ${skinName(recipe.base)}` : "default";
  if (pick.kind === "skin") return skinName(pick.key);
  return pick.kind === "default" ? "default" : "blank";
}

function setPick(id: string, pick: Pick | null) {
  if (pick) recipe.picks[id] = pick;
  else delete recipe.picks[id];
  persist();
  renderGroups();
  renderMix();
  scheduleCompose();
}

function groupSection(group: Group, data: SkinData) {
  const owned = groupFiles(group, data);
  const ini = parseIni(data.text);
  const iniLines = (group.ini ?? []).flatMap((k) =>
    ini
      .filter((s) => s.name === k.section)
      .flatMap((s) => s.lines)
      .filter((line) => {
        const key = line.split(":")[0]?.trim();
        return (
          line.includes(":") &&
          !line.trim().startsWith("//") &&
          (k.pattern ? new RegExp(k.key).test(key) : key === k.key)
        );
      }),
  );
  const present = new Set(owned.map(stem));
  const missing = group.elements
    .filter((e) => !e.name.endsWith("*"))
    .filter(
      (e) =>
        !present.has(e.name.toLowerCase()) &&
        !(e.anim && frames(data.files, e.name).length),
    )
    .map((e) => e.name);
  const pick = recipe.picks[group.id];
  const isThis = pick?.kind === "skin" && pick.key === data.key;
  const canBlank = group.elements.some((e) => !e.name.endsWith("*"));
  const choice = (label: string, pressed: boolean, next: Pick, title = "") =>
    h(
      "button",
      {
        type: "button",
        class: "v-btn v-btn--sm",
        ariaPressed: String(pressed),
        title,
        onclick: () => setPick(group.id, pressed ? null : next),
      },
      label,
    );
  const controls = h(
    "div",
    { class: "v-row" },
    h("span", { class: "pick-now" }, "Mix ", h("b", {}, pickLabel(pick))),
    choice("Use this skin", isThis, { kind: "skin", key: data.key }),
    choice(
      "Default",
      pick?.kind === "default",
      { kind: "default" },
      "osu!'s default elements",
    ),
    canBlank &&
      choice(
        "Blank",
        pick?.kind === "blank",
        { kind: "blank" },
        "Invisible images, silent sounds",
      ),
  );
  const body = tiles(data, owned, group.id === "numbers");
  return h(
    "section",
    { class: "group" },
    h(
      "header",
      {},
      h(
        "h3",
        {},
        group.label,
        owned.length
          ? h("span", { class: "v-muted" }, `${owned.length} files`)
          : null,
        pick ? h("span", { class: "v-badge v-badge--accent" }, "in mix") : null,
      ),
      controls,
    ),
    iniLines.length
      ? h(
          "dl",
          { class: "v-facts" },
          ...iniLines.flatMap((line) => {
            const [key, ...rest] = line.split(":");
            const value = rest.join(":").trim();
            const c = rgb(value);
            const swatch = c && h("span", { class: "swatch" });
            if (swatch && c)
              swatch.style.backgroundColor = `rgb(${c[0]} ${c[1]} ${c[2]})`;
            return [
              h("dt", {}, key.trim()),
              h("dd", { class: "v-mono" }, swatch, value),
            ];
          }),
        )
      : null,
    body.length
      ? h("div", { class: "tiles" }, ...body)
      : !iniLines.length
        ? h("p", { class: "missing" }, "None in this skin.")
        : null,
    missing.length && body.length
      ? h(
          "details",
          { class: "missing" },
          h("summary", {}, `${missing.length} missing`),
          missing.join(", "),
        )
      : null,
  );
}

function renderGroups() {
  const container = $("#groups");
  const entry = focused ? loaded.get(focused) : undefined;
  if (!entry) {
    container.replaceChildren(
      h("p", { class: "v-empty" }, focused ? "Reading…" : ""),
    );
    return;
  }
  const list: Group[] = groups.filter((g) => g.category === category);
  if (category === "mania") {
    const counts = new Set(maniaKeyCounts(entry.data));
    for (const id of Object.keys(recipe.picks)) {
      const g = groupById(id);
      if (g?.maniaKeys) counts.add(g.maniaKeys);
    }
    for (const k of [...counts].sort((a, b) => a - b)) list.push(maniaGroup(k));
  }
  container.replaceChildren(...list.map((g) => groupSection(g, entry.data)));
  syncPlayer();
}

$("#use-base").onclick = () => {
  if (!focused) return;
  if (editMode === "current") {
    if (recipe.base !== focused) setTarget(focused, true);
    return;
  }
  recipe.base = recipe.base === focused ? null : focused;
  persist();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
};

// ---- views -----------------------------------------------------------------
function showView(next: typeof view) {
  view = next;
  for (const name of [
    "elements",
    "explorer",
    "keymodes",
    "ini",
    "preview",
  ] as const)
    $(`#tab-${name}`).setAttribute("aria-selected", String(view === name));
  // The Keymodes screen has its own image picker: it takes the library's room.
  $(".studio").dataset.view = view;
  $("#elements-view").hidden = view !== "elements" || !focused;
  $("#explorer-view").hidden = view !== "explorer";
  $("#keymodes-view").hidden = view !== "keymodes";
  $("#ini-view").hidden = view !== "ini";
  $("#preview-view").hidden = view !== "preview";
  $("#guide").hidden = !!focused || view !== "elements";
  $(".focus-head").hidden = view === "keymodes";
  if (view === "ini") {
    // The skin edited in place opens on its draft.
    if (!focused || (editMode === "current" && focused === recipe.base)) iniMode = "mix";
    renderIni();
    if (iniEditor) iniEditor.layout();
    else void ensureEditor();
  }
  void showPreview(view === "preview");
  void keymodes.show(view === "keymodes");
  if (view === "explorer") explorer?.refreshMix();
}
$("#tab-elements").onclick = () => showView("elements");
$("#tab-explorer").onclick = () => showView("explorer");
$("#tab-keymodes").onclick = () => showView("keymodes");
$("#tab-ini").onclick = () => showView("ini");
// Pointing at (or tabbing to) the tab starts the editor while the click lands.
for (const type of ["pointerenter", "focus"])
  $("#tab-ini").addEventListener(type, () => void ensureEditor(), {
    once: true,
  });
$("#tab-preview").onclick = () => showView("preview");
$("#ini-focus").onclick = () => {
  iniMode = "focus";
  renderIni();
};
$("#ini-mix").onclick = () => {
  iniMode = "mix";
  renderIni();
};
$("#ini-reset").onclick = () => {
  mixDoc.setValue(composedIni);
};
reload.onclick = () => {
  if (
    focused &&
    (!focusDirty() || confirm("Discard unsaved skin.ini changes?"))
  ) {
    savedText = focusDoc.getValue();
    void focus(focused);
  }
};
save.onclick = () => void storeIni();

// ---- mix ---------------------------------------------------------------------
const mixName = $<HTMLInputElement>("#mix-name");
mixName.value = recipe.name;
mixName.addEventListener("input", () => {
  recipe.name = mixName.value;
  persist();
  scheduleCompose();
});

let composeTimer = 0;
function scheduleCompose() {
  clearTimeout(composeTimer);
  composeTimer = window.setTimeout(() => void recompose(), 150);
}
async function composeNow(fresh = false) {
  const keys = recipeSkins(recipe);
  const map = new Map<string, SkinData>();
  for (const key of keys) {
    if (!skinByKey(key)?.available)
      throw new Error(`${skinName(key)} is unavailable`);
    map.set(key, (await load(key, fresh)).data);
  }
  return compose(recipe, map);
}
/** The plan to build: the composed files with the draft skin.ini if edited. */
async function planNow(fresh = false): Promise<Plan> {
  const { plan } = await composeNow(fresh);
  if (mixEdited() && mixDoc.getValue()) plan.ini = mixDoc.getValue();
  return plan;
}

// ---- edit in place: the draft, its review, Apply / Discard / Restore -------
interface Change {
  path: string;
  action: "add" | "replace" | "remove";
  bytes: number;
}
type Target =
  | { kind: "folder"; path: string }
  | { kind: "mounted"; path: string }
  | { kind: "import"; name: string; lazer: string | null };
interface Review {
  target: Target;
  changes: Change[];
  revision: string;
}
interface Applied {
  target: Target;
  changes: Change[];
  backup: string | null;
  file: string | null;
  opened: boolean;
}
let review: Review | null = null;
/** Choose "Apply to current skin" once it can be offered (unless the user picked another). */
let applyDefault =
  editMode === "current" && localStorage.getItem("skin-studio:export-target") !== "stable";
/** Why exporting is unavailable now (renderMix's reason, for renderApply). */
let exportReason = "";
let reviewError = "";
let reviewTimer = 0;
let reviewTicket = 0;
let applying = false;
/** The first apply in a tab shows exactly what goes where. */
let applyConfirmed = false;
let lastApply: { id: string; created: number; changes: number } | null = null;

/** Skins an apply can write: folders and lazer skins (not .osk or drops). */
const editable = (skin: Skin | undefined) =>
  !!skin &&
  skin.available &&
  !skin.builtin &&
  (skin.origin === "stable" || skin.origin === "added" || skin.origin === "lazer");
const currentKey = () =>
  library?.skins.find((s) => s.current && editable(s))?.key ?? null;

/** The apply request for the draft as it is now. */
async function applyRequest(fresh: boolean) {
  const target = recipe.base;
  if (!target) throw new Error("No skin to apply to");
  const plan = await planNow(fresh);
  plan.name = skinName(target);
  const base = (await load(target, fresh)).data;
  return { skin: target, plan, remove: inPlaceRemovals(plan, base) };
}

function scheduleReview() {
  clearTimeout(reviewTimer);
  const ticket = ++reviewTicket;
  if (editMode !== "current" || !recipe.base || !canWrite() || composeError) {
    review = null;
    reviewError = "";
    renderApply();
    return;
  }
  reviewTimer = window.setTimeout(async () => {
    try {
      const next = await post<Review>("v1/review", await applyRequest(false));
      if (ticket !== reviewTicket) return;
      review = next;
      reviewError = "";
    } catch (error) {
      if (ticket !== reviewTicket) return;
      review = null;
      reviewError = message(error);
    }
    renderApply();
  }, 400);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const describeTarget = (target: Target) =>
  target.kind === "folder"
    ? `Writes into the skin's folder, ${target.path}`
    : target.kind === "mounted"
      ? `Writes into osu!lazer's "Edit externally" folder (${target.path}); press "Finish editing" in lazer afterwards to replace the skin`
      : `osu!lazer cannot have its skins replaced from outside: applying imports this as a new skin, "${target.name}". To edit in place, open lazer's skin editor and choose "Edit externally" first.`;

function renderApply() {
  const current = editMode === "current";
  $("#edit-head").hidden = !current;
  $("#mix-head").hidden = current;
  // "Apply to current skin" exists while a skin is edited in place (and is
  // the default choice then); its state line sits under the button.
  const exportTarget = $<HTMLSelectElement>("#export-target");
  const option = exportTarget.querySelector<HTMLOptionElement>('option[value="apply"]')!;
  option.hidden = option.disabled = !current || !recipe.base;
  if (option.hidden && exportTarget.value === "apply") exportTarget.value = "stable";
  if (!option.hidden && applyDefault) {
    exportTarget.value = "apply";
    applyDefault = false;
  }
  $("#apply-area").hidden = option.hidden || exportTarget.value !== "apply";
  $("#mode-current").setAttribute("aria-pressed", String(current));
  $("#mode-new").setAttribute("aria-pressed", String(!current));
  $("#mix-reset").textContent = current ? "Discard" : "Clear";
  $("#mix-reset").hidden = current;
  if (!current) return;
  const target = recipe.base;
  const skin = skinByKey(target);
  $("#edit-target").textContent = target
    ? `${skinName(target)}${target === currentKey() ? " (current skin)" : ""}`
    : "No skin";
  $("#edit-where").textContent = !target
    ? "vosu reports no current skin (osu! not running?). Choose one in the library, then Edit this skin."
    : review
      ? describeTarget(review.target)
      : skin?.origin === "lazer"
        ? "osu!lazer skin"
        : "Skin folder";
  // osu! switched skins while this draft has edits for another one.
  const now = currentKey();
  const note = $("#edit-note");
  note.hidden = !(target && now && now !== target && hasEdits(recipe) && !recipe.pinned);
  if (!note.hidden && now)
    note.replaceChildren(
      `osu! now uses ${skinName(now)}; this draft still edits ${skinName(target ?? "")}. `,
      h(
        "button",
        {
          type: "button",
          class: "v-btn v-btn--sm v-btn--ghost",
          onclick: () => setTarget(now, false),
        },
        `Edit ${skinName(now)}`,
      ),
    );
  const edits = hasEdits(recipe);
  renderExport(exportReason);
  const count = $("#apply-count");
  count.classList.toggle("error", !!reviewError);
  count.textContent = !target
    ? ""
    : !canWrite()
      ? edits
        ? "Unapplied draft. Applying needs a session from the dashboard."
        : "No changes"
      : reviewError
        ? reviewError
        : review
          ? review.changes.length
            ? `${plural(review.changes.length, "unapplied change")}`
            : "No unapplied changes"
          : edits
            ? "Checking changes…"
            : "No changes";
  $<HTMLButtonElement>("#discard").disabled = applying || !edits;
  const restore = $<HTMLButtonElement>("#restore");
  restore.hidden = !lastApply;
  restore.disabled = applying || !canWrite();
  if (lastApply)
    restore.title = `Puts back the ${plural(lastApply.changes, "file")} the apply of ${new Date(lastApply.created * 1000).toLocaleString()} changed`;
}

/** Edits nothing until the user picks a skin; `pinned` stops following osu!. */
function setTarget(key: string, pinned: boolean) {
  if (
    hasEdits(recipe) &&
    !confirm(`Discard the unapplied changes to ${skinName(recipe.base ?? "")} and edit ${skinName(key)}?`)
  )
    return;
  clearDraft();
  recipe.base = key;
  recipe.pinned = pinned || undefined;
  persist();
  void refreshLastApply();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
}

/** Follows osu!'s current skin while the draft has nothing unapplied. */
function followCurrent() {
  if (editMode !== "current") return;
  const now = currentKey();
  if (!now || now === recipe.base) return;
  if (recipe.base && (hasEdits(recipe) || recipe.pinned)) return renderApply();
  recipe.base = now;
  persist();
  void refreshLastApply();
  renderFocus();
  renderMix();
  scheduleCompose();
}

function clearDraft() {
  recipe.picks = {};
  recipe.overrides = {};
  recipe.keymodes = {};
  delete recipe.ini;
  persist();
  keymodes.resetHistory();
  composedIni = "";
  mixDoc.setValue("");
  review = null;
}
function discardDraft() {
  if (!hasEdits(recipe)) return;
  if (!confirm(`Discard ${review?.changes.length ? plural(review.changes.length, "unapplied change") : "the draft"}?`))
    return;
  clearDraft();
  renderFocus();
  renderMix();
  scheduleCompose();
}

async function refreshLastApply() {
  lastApply = null;
  const target = recipe.base;
  if (editMode === "current" && target && skinByKey(target)?.origin !== "lazer")
    try {
      lastApply = await request(`v1/applied?skin=${encodeURIComponent(target)}`);
    } catch {
      /* no backups to offer */
    }
  renderApply();
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** Shows what an apply writes where; resolves to the user's answer. */
function confirmApply(next: Review): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("#apply-dialog");
  $("#apply-where").textContent = describeTarget(next.target);
  const verb = { add: "Add", replace: "Replace", remove: "Remove" };
  $("#apply-list").replaceChildren(
    ...next.changes.map((c) =>
      h(
        "li",
        {},
        h("span", { class: `v-badge apply-${c.action}` }, verb[c.action]),
        h("span", { class: "v-mono" }, c.path),
        h("span", { class: "v-muted v-num" }, formatSize(c.bytes)),
      ),
    ),
  );
  $("#apply-safety").textContent =
    next.target.kind === "import"
      ? "Your lazer skin is not changed. The .osk is written to Skin studio's data folder and handed to the running osu!lazer."
      : "Every file replaced or removed is copied into Skin studio's data folder first; Restore last apply puts them back. Other files are not touched.";
  $("#apply-confirm").textContent =
    next.target.kind === "import" ? `Import into osu!lazer` : `Apply ${plural(next.changes.length, "change")}`;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "apply"), { once: true }),
  );
}

async function applyNow() {
  const result = $("#mix-result");
  applying = true;
  renderApply();
  try {
    // Re-read the skin so the review matches the files on disk now.
    const body = await applyRequest(true);
    const next = await post<Review>("v1/review", body);
    if (!next.changes.length) {
      result.replaceChildren(h("p", { class: "v-muted" }, "Nothing to apply"));
      return;
    }
    if (!applyConfirmed) {
      if (!(await confirmApply(next))) return;
      applyConfirmed = true;
    }
    const applied = await post<Applied>("v1/apply", { ...body, revision: next.revision });
    const n = plural(applied.changes.length, "change");
    result.replaceChildren(
      ...(applied.target.kind === "folder"
        ? [
            h("p", { class: "ok" }, `Applied ${n}`),
            h("p", { class: "v-mono v-muted" }, applied.target.path),
            h("p", { class: "v-muted" }, "Re-select the skin in osu! to see it."),
          ]
        : applied.target.kind === "mounted"
          ? [
              h("p", { class: "ok" }, `Applied ${n} to lazer's edit folder`),
              h("p", { class: "v-muted" }, 'Press "Finish editing" in osu!lazer to replace the skin.'),
            ]
          : applied.opened
            ? [
                h("p", { class: "ok" }, `Sent to osu!lazer as "${applied.target.name}"`),
                h("p", { class: "v-muted" }, 'lazer adds it as a new skin: click its "Imported … Click to view" notification to switch to it.'),
              ]
            : [
                h("p", { class: "ok" }, `Saved "${applied.target.name}.osk"`),
                h("p", { class: "v-muted" }, "osu!lazer is not running: drag this file into it."),
                h("p", { class: "v-mono v-muted" }, applied.file ?? ""),
              ]),
    );
    clearDraft();
    loaded.delete(recipe.base ?? "");
    await loadLibrary();
    await refreshLastApply();
    if (focused === recipe.base) await focus(focused);
    scheduleCompose();
  } catch (error) {
    result.replaceChildren(h("p", { class: "error" }, message(error)));
  } finally {
    applying = false;
    renderApply();
  }
}

$("#discard").onclick = () => discardDraft();
$("#restore").onclick = async () => {
  const target = recipe.base;
  if (!target || !lastApply) return;
  if (!confirm(`Put back the ${plural(lastApply.changes, "file")} the last apply changed in ${skinName(target)}? Files changed since then are left alone.`))
    return;
  const result = $("#mix-result");
  try {
    const restored = await post<{ restored: number; skipped: string[] }>("v1/restore", { skin: target });
    result.replaceChildren(
      h("p", { class: "ok" }, `Restored ${plural(restored.restored, "file")}`),
      ...(restored.skipped.length
        ? [h("p", { class: "v-muted" }, `Left as they are (changed since): ${restored.skipped.join(", ")}`)]
        : []),
    );
    loaded.delete(target);
    if (focused === target) await focus(target);
    await refreshLastApply();
    scheduleCompose();
  } catch (error) {
    result.replaceChildren(h("p", { class: "error" }, message(error)));
  }
};

function setMode(next: EditMode) {
  if (next === editMode) return;
  persist();
  editMode = next;
  localStorage.setItem(MODE_KEY, next);
  recipe = recipes[next];
  keymodes.resetHistory();
  composedIni = "";
  mixDoc.setValue("");
  review = null;
  mixName.value = recipe.name;
  if (next === "current") followCurrent();
  void refreshLastApply();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
}
$("#mode-current").onclick = () => setMode("current");
$("#mode-new").onclick = () => setMode("new");
/**
 * Composes the recipe into the mix draft. A draft skin.ini edited by hand
 * is kept; the `[Mania]` keys a Keymodes change `touched` are written into
 * it too, with the values the composed skin.ini has for them.
 */
async function recompose(touched?: { keys: number; names: string[] }) {
  try {
    const composed = await composeNow();
    const wasEdited = mixEdited();
    composedIni = composed.plan.ini;
    counts = composed.counts;
    blanks = composed.plan.blanks.length;
    notes = composed.notes;
    fallbacks = composed.fallbacks;
    lastPlan = composed.plan;
    composeError = "";
    if (!wasEdited || !mixDoc.getValue())
      mixDoc.setValue(
        editMode === "current" && recipe.ini !== undefined ? recipe.ini : composedIni,
      );
    else if (touched) {
      const { keys, names } = touched;
      let text = mixDoc.getValue();
      // A key count added on the Keymodes screen has a block even without keys.
      if (blockKeyCounts(parse(composedIni)).includes(keys))
        text = addManiaBlock(text, keys);
      for (const name of names)
        text = setManiaValue(text, keys, name, maniaValue(composedIni, keys, name));
      mixDoc.setValue(text);
    }
  } catch (error) {
    composeError = message(error);
  }
  mixVersion++;
  renderMix();
  renderIni();
  updatePreview();
  keymodes.refresh();
  scheduleReview();
}

const groupLabel = (id: string) =>
  id === "other" ? "Other" : (groupById(id)?.label ?? id);

/** Skins already read in this session that hold the unit, for "replace". */
const holders = (ref: AssetRef) =>
  [...loaded.values()]
    .filter(
      (l) =>
        unitFiles(ref, l.data.files, fontPrefixes(parseIni(l.data.text)))
          .length,
    )
    .map((l) => l.data.key);

function setCarry(id: string, carry: Carry, on: boolean) {
  const override = recipe.overrides?.[id];
  if (!override) return;
  const set = new Set(override.carry ?? []);
  if (on) set.add(carry);
  else set.delete(carry);
  override.carry = [...set];
  persist();
  scheduleCompose();
}

function overrideRow(id: string) {
  const override = recipe.overrides![id];
  const ref = parseAssetId(id)!;
  const note = notes.get(id);
  const others = holders(ref);
  if (!others.includes(override.skin)) others.unshift(override.skin);
  const source = h(
    "select",
    {
      class: "v-select",
      ariaLabel: `${ref.name} from`,
      onchange: (event: Event) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLSelectElement)) return;
        recipe.overrides![id] = { skin: target.value };
        persist();
        renderGroups();
        scheduleCompose();
      },
    },
    ...others.map((key) =>
      h(
        "option",
        { value: key, selected: key === override.skin },
        skinName(key),
      ),
    ),
  );
  source.disabled = others.length < 2;
  const badges: Node[] = [];
  if (note?.carried.length)
    badges.push(
      h(
        "span",
        { class: "v-badge", title: note.carried.join("\n") },
        `+${note.carried.length} skin.ini`,
      ),
    );
  if (note?.unreferenced)
    badges.push(
      h(
        "span",
        {
          class: "v-badge v-badge--warn",
          title: "No skin.ini key names this file",
        },
        "unused",
      ),
    );
  for (const offer of note?.offers ?? [])
    badges.push(
      h(
        "button",
        {
          type: "button",
          class: "v-btn v-btn--sm offer",
          ariaPressed: String(offer.applied),
          title: offer.changes.join("\n"),
          onclick: () => setCarry(id, offer.id, !offer.applied),
        },
        offer.applied ? offer.label : `Carry ${offer.label.toLowerCase()}`,
      ),
    );
  return h(
    "li",
    { class: "override" },
    h(
      "div",
      {},
      h(
        "span",
        { class: "v-mono override-name", title: id },
        ref.kind === "font" ? `${ref.name}-*` : ref.name,
      ),
      h(
        "div",
        { class: "override-tools" },
        source,
        ...badges,
        filesButton({ ref, skin: override.skin }, ref.name),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "v-btn v-btn--sm v-btn--ghost v-btn--icon",
        ariaLabel: `Remove ${ref.name} from the mix`,
        onclick: () => useAsset(ref, override.skin),
      },
      "×",
    ),
  );
}

function renderMix() {
  const base = recipe.base;
  $("#mix-base").textContent = base ? skinName(base) : "None";
  $("#mix-base-clear").hidden = !base;
  // Groups with a pick or with single-asset overrides, overrides listed under them.
  const byGroup = new Map<string, string[]>();
  for (const id of Object.keys(recipe.picks))
    if (groupById(id)) byGroup.set(id, []);
  for (const id of Object.keys(recipe.overrides ?? {})) {
    const group = notes.get(id)?.group ?? "other";
    byGroup.set(group, [...(byGroup.get(group) ?? []), id]);
  }
  const rows: Node[] = [];
  for (const [gid, ids] of byGroup) {
    const group = groupById(gid);
    const pick = recipe.picks[gid];
    rows.push(
      h(
        "li",
        { class: pick ? "" : "group-only" },
        h(
          "div",
          {},
          h(
            "span",
            {},
            groupLabel(gid),
            " ",
            h(
              "span",
              { class: "v-muted" },
              group
                ? (categories.find((c) => c.id === group.category)?.label ?? "")
                : "",
            ),
          ),
          h(
            "span",
            { class: "pick-source" },
            pick ? pickLabel(pick) : pickLabel(undefined),
          ),
          fallbackLine(gid),
        ),
        pick
          ? h(
              "button",
              {
                type: "button",
                class: "v-btn v-btn--sm v-btn--ghost v-btn--icon",
                ariaLabel: `Remove ${groupLabel(gid)} from the mix`,
                onclick: () => setPick(gid, null),
              },
              "×",
            )
          : null,
      ),
      ...ids.map(overrideRow),
    );
  }
  // Key counts edited on the Keymodes screen.
  for (const [count, draft] of Object.entries(recipe.keymodes ?? {})) {
    const slots = Object.keys(draft.images).length,
      values = Object.keys(draft.values).length;
    rows.push(
      h(
        "li",
        {},
        h(
          "div",
          {},
          h("span", {}, `${count}K columns `, h("span", { class: "v-muted" }, "Keymodes")),
          h(
            "span",
            { class: "pick-source" },
            [slots ? `${slots} images` : "", values ? `${values} values` : ""]
              .filter(Boolean)
              .join(" · ") || "block added",
          ),
        ),
        h(
          "button",
          {
            type: "button",
            class: "v-btn v-btn--sm v-btn--ghost",
            ariaLabel: `Edit ${count}K columns`,
            onclick: () => showView("keymodes"),
          },
          "Edit",
        ),
      ),
    );
  }
  $("#mix-picks").replaceChildren(
    ...(rows.length
      ? rows
      : [h("li", { class: "empty" }, "No groups picked.")]),
  );
  const overrides = Object.keys(recipe.overrides ?? {}).length;
  const total = [...counts.values()].reduce((a, b) => a + b, 0) + blanks;
  $("#mix-summary").replaceChildren(
    ...(composeError
      ? [h("span", { class: "error" }, composeError)]
      : total || byGroup.size || base
        ? [
            `${total} files`,
            ...[...counts].map(([key, n]) => ` · ${n} ${skinName(key)}`),
            blanks ? ` · ${blanks} blank` : "",
          ]
        : []),
  );
  const empty =
    !base &&
    !Object.keys(recipe.picks).length &&
    !overrides &&
    !Object.keys(recipe.keymodes ?? {}).length;
  const reason = !canWrite()
    ? `Read-only tab: ${readOnlyReason()}`
    : empty
      ? "Pick a base, a group or an asset"
      : composeError;
  exportReason = reason;
  renderExport(reason);
  explorer?.refreshMix();
  renderUploads();
  renderApply();
}

// ---- export: one target choice and its button ------------------------------
const EXPORT_KEY = "skin-studio:export-target";
const exportTarget = $<HTMLSelectElement>("#export-target");
{
  const saved = localStorage.getItem(EXPORT_KEY) ?? "";
  if (isTarget(saved)) exportTarget.value = saved;
}
/** The chosen target, its button and its note (what it skips or approximates). */
function renderExport(reason = "") {
  const target = isTarget(exportTarget.value) ? exportTarget.value : "stable";
  const run = $<HTMLButtonElement>("#export-run");
  if (target === "apply") {
    run.textContent = applying
      ? "Applying…"
      : review?.target.kind === "import"
        ? "Import into osu!lazer"
        : review?.target.kind === "mounted"
          ? "Apply to lazer's edit folder"
          : "Apply changes";
    run.disabled = applying || !canWrite() || !review?.changes.length;
    run.title = !canWrite() ? `Read-only tab: ${readOnlyReason()}` : "";
    $("#export-note").textContent = review
      ? describeTarget(review.target)
      : targetNote("apply", []);
    return;
  }
  const keys = mixKeyCounts(mixDoc.getValue() || lastPlan?.ini || "");
  const playable =
    target === "stable" ||
    target === "osk" ||
    keys.some((k) => supports(target, k));
  run.textContent = TARGETS.find((t) => t.id === target)!.button;
  run.disabled =
    !!reason ||
    building ||
    !playable ||
    (target === "stable" && !library?.stable_dir);
  const name = recipe.name.trim();
  run.title =
    reason ||
    (target === "stable"
      ? library?.stable_dir
        ? `${library.stable_dir}/${name}`
        : "No Skins folder"
      : target === "osk"
        ? `${name}.osk`
        : target === "quaver"
          ? `${name}.qs`
          : `${name} (Etterna).zip`);
  $("#export-note").textContent = targetNote(target, keys);
}
exportTarget.onchange = () => {
  localStorage.setItem(EXPORT_KEY, exportTarget.value);
  applyDefault = false;
  renderMix();
};

// ---- dropped files: listed with their use; removed only by the user --------
let uploadFiles: UploadFile[] = [];
async function refreshUploads() {
  try {
    uploadFiles = (await load(UPLOADS, true)).snapshot.files;
  } catch (error) {
    $("#mix-uploads-note").textContent = message(error);
  }
  renderUploads();
}
function renderUploads() {
  const { used, unused } = uploadUsage(uploadFiles, recipe.keymodes ?? {});
  const all = [...used, ...unused];
  $("#mix-uploads").hidden = !all.length;
  $("#mix-uploads-summary").textContent = `Dropped files: ${all.length} (${formatBytes(all.reduce((s, f) => s + f.size, 0))})`;
  $("#mix-uploads-list").replaceChildren(
    ...all.map((f) =>
      h(
        "li",
        { title: f.name },
        h("span", { class: "v-mono" }, f.name.split("/").pop() ?? f.name),
        h("span", { class: "v-muted" }, formatBytes(f.size)),
        used.includes(f)
          ? h("span", { class: "v-badge v-badge--ok" }, "used by this draft")
          : h("span", { class: "v-badge" }, "unused"),
      ),
    ),
  );
  const remove = $<HTMLButtonElement>("#mix-uploads-remove");
  remove.disabled = !unused.length || !canWrite();
  remove.title = !canWrite()
    ? "Read-only tab"
    : unused.length
      ? "Files this draft uses are kept"
      : "This draft uses every dropped file";
}
$("#mix-uploads-remove").onclick = async () => {
  // Recompute at click time: the draft may have changed since the list.
  const { unused } = uploadUsage(uploadFiles, recipe.keymodes ?? {});
  const note = $("#mix-uploads-note");
  if (!unused.length || !confirm(removeQuestion(unused))) return;
  try {
    const removed = await post<{ files: number; bytes: number }>(
      "v1/uploads/remove",
      { names: unused.map((f) => f.name) },
    );
    note.textContent = `Removed ${removed.files} ${removed.files === 1 ? "file" : "files"} (${formatBytes(removed.bytes)})`;
  } catch (error) {
    note.textContent = message(error);
  }
  await refreshUploads();
};
$("#mix-base-clear").onclick = () => {
  recipe.base = null;
  persist();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
};
$("#mix-reset").onclick = () => {
  if (editMode === "current") return discardDraft();
  if (!confirm("Clear the mix?")) return;
  recipe = recipes.new = { name: recipe.name, base: null, picks: {}, overrides: {} };
  persist();
  mixDoc.setValue("");
  composedIni = "";
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
};
$("#mix-ini").onclick = () => {
  iniMode = "mix";
  showView("ini");
};
$("#mix-plan").onclick = async () => {
  try {
    const plan = await planNow();
    const link = h("a", {
      href: URL.createObjectURL(
        new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" }),
      ),
      download: `${plan.name || "mix"}.skin-plan.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
    status.textContent = `Saved ${link.download}`;
  } catch (error) {
    status.textContent = message(error);
  }
};

/**
 * Hands an export to the browser: the service accepts it (an `.osk` plan,
 * or a plan with stages it converts for Quaver or Etterna before
 * answering), then sends the file once from a one-time URL the page opens
 * as a download.
 */
async function download(body: object) {
  const exported = await post<{
    url: string;
    filename: string;
    report?: ExportReport;
  }>("v1/exports", body);
  const link = h("a", {
    href: toolBase + exported.url,
    download: exported.filename,
  });
  document.body.append(link);
  link.click();
  link.remove();
  return exported;
}

/** A skin's display name as a valid skin/archive name. */
const fileSafe = (name: string) =>
  name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120) || "Skin";

$("#focus-osk").onclick = async () => {
  if (!focused) return;
  const entry = loaded.get(focused);
  if (!entry) return;
  try {
    const name = fileSafe(skinName(focused));
    const { filename } = await download({
      name,
      overwrite: false,
      ini: entry.snapshot.text,
      sources: [
        {
          skin: focused,
          files: entry.data.files.filter(
            (f) =>
              !/^skin\.ini$/i.test(f) &&
              !/\.bak$/i.test(f) &&
              !/^skin-studio-credits\.txt$/i.test(f),
          ),
        },
      ],
      blanks: [],
    });
    status.textContent = `Downloading ${filename}`;
  } catch (error) {
    status.textContent = message(error);
  }
};

let building = false;
async function buildMix(target: Exclude<ExportTarget, "apply">) {
  building = true;
  renderMix();
  const result = $("#mix-result");
  result.replaceChildren(
    h(
      "p",
      { class: "v-muted" },
      target === "stable"
        ? "Creating…"
        : target === "osk"
          ? "Packing…"
          : "Converting…",
    ),
  );
  try {
    // Re-read every source so the plan matches the files on disk now.
    const plan = await planNow(true);
    if (target !== "stable") {
      const { filename, report } = await download(
        target === "osk" ? plan : convertRequest(plan, target),
      );
      result.replaceChildren(
        h("p", { class: "ok" }, `Downloading ${filename}`),
        ...(report ? reportLines(report) : []).map((line) =>
          h("p", { class: "v-muted" }, line),
        ),
      );
      return;
    }
    let built: { path: string; replaced: boolean; files: number };
    try {
      built = await post("v1/build", plan);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      if (!confirm(`${message(error)}\n\nReplace it?`)) {
        result.replaceChildren();
        return;
      }
      built = await post("v1/build", { ...plan, overwrite: true });
    }
    result.replaceChildren(
      h(
        "p",
        { class: "ok" },
        `${built.replaced ? "Replaced" : "Created"} · ${built.files} files`,
      ),
      h("p", { class: "v-mono v-muted" }, built.path),
    );
    status.textContent = "";
    await loadLibrary();
  } catch (error) {
    result.replaceChildren(h("p", { class: "error" }, message(error)));
  } finally {
    building = false;
    renderMix();
  }
}
$("#export-run").onclick = () => {
  const target = exportTarget.value;
  if (!isTarget(target)) return;
  if (target === "apply") void applyNow();
  else void buildMix(target);
};

// ---- preview ----------------------------------------------------------------
const PREVIEW_KEY = "skin-studio:preview";
const previewPrefs: {
  source: "focus" | "mix";
  ruleset: string;
  keys: number;
  playing: boolean;
} = (() => {
  const fallback = {
    source: "focus" as const,
    ruleset: "",
    keys: 4,
    playing: true,
  };
  try {
    return {
      ...fallback,
      ...JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? "{}"),
    };
  } catch {
    return fallback;
  }
})();
const savePreview = () =>
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(previewPrefs));
const pvState = $("#pv-state");
// The renderer (WebGPU, demo maps) loads with the Preview tab.
let preview: Preview | undefined;
let previewLoading: Promise<Preview> | undefined;
const ensurePreview = () =>
  (previewLoading ??= import("./preview").then(
    ({ Preview }) =>
      (preview = new Preview(
        $<HTMLCanvasElement>("#pv-canvas"),
        $("#pv-stage"),
        (text) => (pvState.textContent = text),
      )),
    (error) => {
      previewLoading = undefined;
      pvState.textContent = message(error);
      throw error;
    },
  ));

/** Fetched skin files, shared by every preview load (cleared when large). */
const blobs = new Map<string, Promise<Blob | null>>();
function fetchBlob(skin: string, file: string): Promise<Blob | null> {
  const key = `${skin}\n${file}`;
  let pending = blobs.get(key);
  if (!pending) {
    if (blobs.size > 4000) blobs.clear();
    pending = fetch(assetUrl(skin, file), { credentials: "omit" }).then(
      (r) => (r.ok ? r.blob() : null),
      () => null,
    );
    blobs.set(key, pending);
  }
  return pending;
}
let blankPng: Promise<Blob> | undefined;
const blank = (kind: "png" | "wav") =>
  kind === "wav"
    ? Promise.resolve(new Blob([]))
    : (blankPng ??= new OffscreenCanvas(1, 1).convertToBlob({
        type: "image/png",
      }));
const iniBlob = (text: string) =>
  Promise.resolve(new Blob([text], { type: "text/plain" }));

function focusResolver(key: string): Resolver | null {
  const entry = loaded.get(key);
  if (!entry) return null;
  const names = new Map(entry.data.files.map((f) => [f.toLowerCase(), f]));
  const text = focusDoc.getValue();
  return (file) => {
    const lower = file.toLowerCase();
    if (lower === "skin.ini")
      return iniBlob(focused === key ? text : entry.snapshot.text);
    const name = names.get(lower);
    return name ? fetchBlob(key, name) : Promise.resolve(null);
  };
}
function mixResolver(plan: Plan): Resolver {
  const files = new Map<string, () => Promise<Blob | null>>();
  for (const source of plan.sources)
    for (const file of source.files) {
      const [from, to] = typeof file === "string" ? [file, file] : file;
      files.set(to.toLowerCase(), () => fetchBlob(source.skin, from));
    }
  for (const item of plan.blanks)
    files.set(item.to.toLowerCase(), () => blank(item.kind));
  const ini = mixDoc.getValue() || plan.ini;
  return (file) => {
    const lower = file.toLowerCase();
    if (lower === "skin.ini") return iniBlob(ini);
    return files.get(lower)?.() ?? Promise.resolve(null);
  };
}

function renderPreviewControls() {
  $("#pv-focus").setAttribute(
    "aria-pressed",
    String(previewPrefs.source === "focus"),
  );
  $("#pv-mix").setAttribute(
    "aria-pressed",
    String(previewPrefs.source === "mix"),
  );
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    "#pv-rulesets button",
  ))
    b.setAttribute(
      "aria-pressed",
      String(b.dataset.demo === previewPrefs.ruleset),
    );
  $("#pv-keys").hidden = previewPrefs.ruleset !== "mania";
  renderKeys();
  const play = $("#pv-play");
  play.setAttribute("aria-pressed", String(previewPrefs.playing));
  play.textContent = previewPrefs.playing ? "Pause" : "Play";
}

/** skin.ini of what the preview shows: the selected skin's or the mix draft. */
function previewIni(): string {
  if (previewPrefs.source === "mix")
    return mixDoc.getValue() || lastPlan?.ini || "";
  return focused && loaded.has(focused) ? focusDoc.getValue() : "";
}
/**
 * Key counts the preview offers: every `[Mania]` block with `Keys: N` in the
 * previewed skin.ini, in order; lazer's default 4K and 7K when it defines no
 * count a demo exists for.
 */
function keyModes(): number[] {
  const defined = [...maniaBlocks(parseIni(previewIni())).keys()]
    .filter((k) => k > 0)
    .sort((a, b) => a - b);
  return defined.some((k) => maniaDemo(k))
    ? defined
    : [...new Set([...defined, 4, 7])].sort((a, b) => a - b);
}
/** The key count drawn: the one last chosen if offered, else the first. */
function activeKeys(modes = keyModes()): number {
  const playable = modes.filter((k) => maniaDemo(k));
  return playable.includes(previewPrefs.keys) ? previewPrefs.keys : playable[0];
}
function renderKeys() {
  const modes = keyModes(),
    active = activeKeys(modes);
  const unsupported = modes.filter((k) => !maniaDemo(k));
  const group = $("#pv-keys");
  const hadFocus = group.contains(document.activeElement);
  group.replaceChildren(
    ...modes.map((k) =>
      h(
        "button",
        {
          type: "button",
          ariaPressed: String(k === active),
          disabled: !maniaDemo(k),
          onclick: () => {
            previewPrefs.keys = k;
            savePreview();
            renderKeys();
            preview?.setDemo(demoId());
          },
        },
        `${k}K`,
      ),
    ),
  );
  if (hadFocus)
    group.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  const help = $("#pv-keys-help");
  help.hidden = previewPrefs.ruleset !== "mania" || !unsupported.length;
  const tip = `${unsupported.map((k) => `${k}K`).join(", ")}: dual-stage layouts are not previewed yet.`;
  help.dataset.tip = tip;
  help.setAttribute("aria-label", tip);
}
const demoId = (): DemoId =>
  previewPrefs.ruleset === "mania"
    ? maniaDemo(activeKeys())!
    : (previewPrefs.ruleset as DemoId);

// skin.ini edits (draft or the selected skin's) reach the preview after a pause.
let focusVersion = 0;
const afterEdit = (bump: () => void) => {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      bump();
      updatePreview();
    }, 400);
  };
};
// Hand edits of the mix draft's [Mania] blocks show on the Keymodes screen.
mixDoc.onDidChangeContent(
  afterEdit(() => {
    mixVersion++;
    keymodes.refresh();
    scheduleReview();
  }),
);
// The in-place draft keeps a hand-edited skin.ini until applied or discarded.
mixDoc.onDidChangeContent(() => {
  if (editMode !== "current" || !mixDoc.getValue()) return;
  const text = mixEdited() ? mixDoc.getValue() : undefined;
  if (text === recipe.ini) return;
  if (text === undefined) delete recipe.ini;
  else recipe.ini = text;
  persist();
  renderApply();
});
focusDoc.onDidChangeContent(afterEdit(() => focusVersion++));

/** Hands the preview the skin it should draw now (cheap when unchanged). */
function updatePreview() {
  if (view !== "preview") return;
  // The key counts follow the previewed skin.ini (edits included).
  renderKeys();
  preview?.setDemo(demoId());
  if (previewPrefs.source === "mix") {
    void preview?.setSource({
      key: "mix",
      version: mixVersion,
      name: recipe.name,
      resolve: lastPlan ? mixResolver(lastPlan) : null,
    });
  } else {
    const entry = focused ? loaded.get(focused) : undefined;
    void preview?.setSource({
      key: `skin:${focused ?? ""}`,
      version: entry ? focusVersion + 1 : 0,
      name: focused ? skinName(focused) : "",
      resolve: focused ? focusResolver(focused) : null,
    });
  }
}

async function showPreview(visible: boolean) {
  if (!visible) {
    await preview?.show(false);
    return;
  }
  if (!previewPrefs.ruleset)
    previewPrefs.ruleset = ["osu", "taiko", "fruits", "mania"].includes(
      category,
    )
      ? category
      : "osu";
  renderPreviewControls();
  const shown = await ensurePreview();
  if (view !== "preview") return;
  shown.setDemo(demoId());
  shown.setPlaying(previewPrefs.playing);
  updatePreview();
  await shown.show(true);
}
$("#pv-focus").onclick = () => {
  previewPrefs.source = "focus";
  savePreview();
  renderPreviewControls();
  updatePreview();
};
$("#pv-mix").onclick = () => {
  previewPrefs.source = "mix";
  savePreview();
  renderPreviewControls();
  updatePreview();
};
for (const b of document.querySelectorAll<HTMLButtonElement>(
  "#pv-rulesets button",
))
  b.onclick = () => {
    previewPrefs.ruleset = b.dataset.demo!;
    savePreview();
    renderPreviewControls();
    preview?.setDemo(demoId());
  };

$("#pv-play").onclick = () => {
  previewPrefs.playing = !previewPrefs.playing;
  savePreview();
  preview?.setPlaying(previewPrefs.playing);
  renderPreviewControls();
};

// ---- explorer ----------------------------------------------------------------
/** Plays (or pauses) a preview sound; only called from an explicit click or key. */
function play(url: string, label: string) {
  if (player.dataset.src === url && !player.paused) {
    player.pause();
    return;
  }
  player.src = url;
  player.dataset.src = url;
  void player.play().catch((error) => {
    status.textContent = `Cannot play ${label}: ${message(error)}`;
  });
}

/** Takes (`on`) or drops several assets from one skin in the mix. */
function useUnits(refs: AssetRef[], skin: string, on: boolean) {
  recipe.overrides ??= {};
  for (const ref of refs) {
    const id = assetId(ref);
    if (on) recipe.overrides[id] = { skin };
    else if (recipe.overrides[id]?.skin === skin) delete recipe.overrides[id];
  }
  persist();
  renderGroups();
  renderMix();
  scheduleCompose();
}

async function revealInExplorer(ref: AssetRef, skin: string) {
  showView("explorer");
  await explorer?.reveal(skin, ref);
}

/** Opens the asset's element group in Elements and highlights its tile. */
async function showInElements(ref: AssetRef, skin: string) {
  if (focused !== skin) await focus(skin);
  const entry = focused === skin ? loaded.get(skin) : undefined;
  if (!entry) return;
  const group = groupById(groupOf(ref, parseIni(entry.data.text)));
  if (!group) {
    status.textContent = `${ref.name} is not in an element group`;
    return;
  }
  category = group.category;
  categoryChosen = true;
  renderCats();
  renderGroups();
  showView("elements");
  const target = $("#groups").querySelector<HTMLElement>(
    `[data-asset="${CSS.escape(assetId(ref))}"]`,
  );
  if (!target) {
    status.textContent = `${ref.name} is not shown in ${group.label}`;
    return;
  }
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
  target.classList.add("found");
  setTimeout(() => target.classList.remove("found"), 1600);
}

/** Stores one key count's Keymodes draft and recomposes the mix at once. */
function applyKeymode(keys: number, draft: KeymodeDraft | undefined) {
  recipe.keymodes ??= {};
  const before = recipe.keymodes[String(keys)];
  if (draft) recipe.keymodes[String(keys)] = draft;
  else delete recipe.keymodes[String(keys)];
  persist();
  renderMix();
  clearTimeout(composeTimer);
  void recompose({ keys, names: touchedKeys(before, draft) });
}

const keymodes = new KeymodesView({
  drafts: () => (recipe.keymodes ??= {}),
  apply: applyKeymode,
  mixText: () => mixDoc.getValue() || lastPlan?.ini || "",
  mixFiles: () => {
    const files = new Map<string, { skin: string; from: string; to: string }>();
    for (const source of lastPlan?.sources ?? [])
      for (const file of source.files) {
        const [from, to] = typeof file === "string" ? [file, file] : file;
        files.set(to.toLowerCase(), { skin: source.skin, from, to });
      }
    return files;
  },
  sources: () =>
    (library?.skins ?? [])
      .filter((s) => s.available && !s.builtin)
      .map((s) => ({
        key: s.key,
        name: s.name,
        group: { stable: "Stable", added: "Added", osk: ".osk", lazer: "Lazer" }[
          s.origin
        ],
      })),
  load: async (key) => {
    // Dropped files grow with every drop: always re-read them.
    const { data } = await load(key, key === UPLOADS);
    return { text: data.text, files: data.files };
  },
  assetUrl,
  skinName,
  upload: async (group, name, file) => {
    const stored = await request<{ name: string }>(
      `v1/uploads?group=${encodeURIComponent(group)}&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    void refreshUploads();
    return stored.name;
  },
  canWrite: () => canWrite(),
  preview: (canvas, stage, onState) =>
    import("./preview").then(
      ({ Preview }) => new Preview(canvas, stage, onState, { rulesets: [3] }),
    ),
  derive: (skin, files) => post("v1/derive", { skin, files }),
  rows: (skin, name) =>
    request(`v1/rows?skin=${encodeURIComponent(skin)}&name=${encodeURIComponent(name)}`),
  lastPlay: () => request("v1/plays/last"),
  speed: () => maniaLive,
  previewSource: () => ({
    key: "mix",
    version: mixVersion,
    name: recipe.name,
    resolve: lastPlan ? mixResolver(lastPlan) : null,
  }),
});

explorer = new Explorer({
  skins: () => library?.skins ?? [],
  load: async (key) => {
    const { snapshot } = await load(key);
    return { text: snapshot.text, files: snapshot.files };
  },
  assetUrl,
  animationUrl,
  play,
  inMix: (ref) => recipe.overrides?.[assetId(ref)]?.skin,
  use: useUnits,
  group: (ref, ini) => groupById(groupOf(ref, parseIni(ini)))?.label,
  showInElements: (ref, skin) => void showInElements(ref, skin),
  status: (text) => (status.textContent = text),
  keymodes: {
    target: () => keymodes.target(),
    // The assignment shows where it went: the Keymodes tab.
    assign: (skin, name) =>
      void keymodes.assign(skin, name).then(() => showView("keymodes")),
    drag: (data, skin, name) => keymodes.drag(data, skin, name),
  },
});
// A drag held over the Keymodes tab opens it, so Explorer images drop on slots.
{
  const tab = $("#tab-keymodes");
  let timer = 0;
  tab.addEventListener("dragenter", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => showView("keymodes"), 450);
  });
  tab.addEventListener("dragover", (event) => event.preventDefault());
  tab.addEventListener("dragleave", () => clearTimeout(timer));
}

// ---- live game state -------------------------------------------------------
/** The attached client's osu!mania scroll speed and direction, from vosu. */
let maniaLive: (Speed & { upscroll: boolean }) | null = null;
/**
 * vosu's `/settings/mania` as the clients use it: lazer's `scrollSpeedValue`;
 * stable's per-beatmap speed when "per beatmap" is on, else its global
 * `scrollSpeed`, and its "scale scroll speed with BPM" (`speedBPMScale`).
 * Direction 0 is up (lazer's ManiaScrollingDirection, vosu's numbering).
 */
function maniaSettings(client: unknown, raw: unknown): (Speed & { upscroll: boolean }) | null {
  if ((client !== "stable" && client !== "lazer") || !raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  const speed =
    client === "lazer"
      ? num(m.scrollSpeedValue)
      : m.usePerBeatmapSpeedScale === true
        ? (num(m.perBeatmapScrollSpeed) ?? num(m.scrollSpeed))
        : num(m.scrollSpeed);
  if (!speed) return null;
  const direction = (m.scrollDirection as { number?: unknown } | undefined)?.number;
  return {
    client,
    speed,
    bpmScale: client === "stable" ? m.speedBPMScale !== false : undefined,
    upscroll: direction === 0,
  };
}
const rulesets: Record<string, Category> = {
  osu: "osu",
  taiko: "taiko",
  fruits: "fruits",
  mania: "mania",
};
function follow(mode: string) {
  const next = rulesets[mode];
  if (!next || library?.settings.start_ruleset !== "follow") return;
  if (next !== category) {
    category = next;
    renderCats();
    renderGroups();
  }
}
function subscribe() {
  const values: unknown[] = [];
  const live = $("#live");
  const dot = $("#live-dot");
  const onFrame = (raw: unknown) => {
    if (!Array.isArray(raw)) return;
    const [type, , changes, removed] = raw;
    if ((type !== 0 && type !== 1) || !Array.isArray(changes)) return;
    if (type === 0) values.length = 0;
    for (const change of changes)
      if (Array.isArray(change) && typeof change[0] === "number")
        values[change[0]] = change[1];
    if (Array.isArray(removed))
      for (const i of removed) if (typeof i === "number") delete values[i];
    const skin = typeof values[0] === "string" ? values[0] : null;
    if (skin && skin !== currentSkinName) {
      const previous = currentSkinName;
      currentSkinName = skin;
      void loadLibrary().then(() => {
        // Follow the game's skin unless the user is looking at another one.
        const current = library?.skins.find((s) => s.current && s.available);
        const prev = library?.skins.find((s) => s.name === previous);
        if (current && (!focused || focused === prev?.key) && !focusDirty())
          void focus(current.key);
      });
    }
    if (typeof values[1] === "string" && !categoryChosen) follow(values[1]);
    maniaLive = maniaSettings(values[2], values[3]);
  };
  vosu.subscribe(["/folders/skin", "/beatmap/mode/name", "/client", "/settings/mania"], onFrame, (state) => {
    // Older bridges never report a state; the indicator stays hidden for them.
    live.hidden = dot.hidden = false;
    dot.dataset.state =
      state === "open" ? "ok" : state === "connecting" ? "busy" : "warn";
    live.textContent =
      state === "open"
        ? "Live"
        : state === "connecting"
          ? "Connecting"
          : "Offline";
  });
}

// ---- start -------------------------------------------------------------------
try {
  await vosu.ready;
} catch (error) {
  status.textContent = message(error);
}
// The bridge applies data-theme; Monaco follows the tokens of that mode.
new MutationObserver(() => iniEditor?.applyTheme()).observe(
  document.documentElement,
  {
    attributes: true,
    attributeFilter: ["data-theme"],
  },
);
const modeBadge = $<HTMLAnchorElement>("#mode");
function renderSession() {
  modeBadge.hidden = canWrite();
  modeBadge.textContent = "Read-only · Open from the dashboard";
  modeBadge.href = dashboardTools();
  modeBadge.title = `Read-only: ${readOnlyReason()}. Edits stay in this browser's draft; applying, exporting and adding files need a tab opened from the dashboard (Tools → Skin studio → Open).`;
}
renderSession();
onSessionChange(() => {
  renderSession();
  renderMix();
  renderIni();
  renderFocus();
  keymodes.refresh();
});
for (const control of document.querySelectorAll<
  HTMLInputElement | HTMLButtonElement
>("#add-folder input, #add-folder button, #add-toggle"))
  control.disabled = !canWrite();
const initial = await loadLibrary();
if (initial) {
  const library = initial;
  const start = library.settings.start_ruleset;
  if (start !== "follow" && rulesets[start]) category = rulesets[start];
  for (const key of recipeSkins(recipe))
    if (!library.skins.some((s) => s.key === key)) {
      status.textContent = "A mix source is missing";
    }
  const current = library.skins.find((s) => s.current && s.available);
  if (current) await focus(current.key);
  else renderFocus();
} else renderFocus();
renderMix();
void refreshUploads();
void refreshLastApply();
scheduleCompose();
subscribe();
// The first view is up: fetch the skin.ini editor while the page is idle.
requestIdleCallback(() => void prefetchEditor(), { timeout: 5000 });

setInterval(async () => {
  if (document.hidden) return;
  // Lazer skins appear once lazer-library has read lazer's database.
  if (library?.lazer.enabled && library.lazer.error) await loadLibrary();
  if (saving || !focused) return;
  const skin = skinByKey(focused);
  if (!skin || skin.origin === "lazer" || skin.origin === "osk") return;
  try {
    const snapshot = await request<Snapshot>(
      `v1/skin?skin=${encodeURIComponent(focused)}`,
    );
    if (snapshot.revision !== diskRevision && !conflict) {
      conflict = true;
      status.textContent = "skin.ini changed on disk · reload before saving";
      renderIni();
    }
  } catch {
    await loadLibrary();
  }
}, 4000);
