import { vosu } from "/tools/_host/v1/bridge.js";
import { parse, resolve, revision } from "@vosu-tools/skin-spec";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import {
  check,
  createEditor,
  monaco,
  rgb,
  setFiles,
  setScheme,
} from "./editor";
import type { Scheme } from "./themes";
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
  maniaGroup,
  maniaKeyCounts,
  recipeSkins,
} from "./plan";
import { getValue, parseIni } from "./ini";

interface Skin {
  key: string;
  name: string;
  origin: "stable" | "added" | "lazer";
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
  export_dir: string;
  lazer: { enabled: boolean; available: boolean; error: string | null };
  settings: { start_ruleset: string; open_osk: boolean; credits: boolean };
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

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  node.append(...children.filter((c): c is Node | string => !!c));
  return node;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const status = $("#status");
const player = $<HTMLAudioElement>("#player");
const save = $<HTMLButtonElement>("#save");
const reload = $<HTMLButtonElement>("#reload");

// ---- colour scheme -------------------------------------------------------
const currentScheme = (): Scheme =>
  vosu.colorScheme ??
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
function applyScheme() {
  const scheme = currentScheme();
  document.documentElement.dataset.scheme = scheme;
  document.documentElement.style.colorScheme = scheme;
  setScheme(scheme);
}
document.documentElement.dataset.scheme = currentScheme();
document.documentElement.style.colorScheme = currentScheme();

// ---- state ---------------------------------------------------------------
let library: Library | null = null;
let libraryError = "";
const loaded = new Map<string, Loaded>();
let focused: string | null = null;
let category: Category = "osu";
let categoryChosen = false;
let view: "elements" | "ini" = "elements";
let iniMode: "focus" | "mix" = "focus";
let saving = false;
let conflict = false;
let diskRevision = "";
let savedText = "";
let composedIni = "";
let composeError = "";
let counts = new Map<string, number>();
let blanks = 0;
let currentSkinName: string | null = null;

const RECIPE_KEY = "skin-studio:recipe";
// The recipe holds only skin names/paths the user picked; never sessions.
let recipe: Recipe = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(RECIPE_KEY) ?? "null");
    if (stored && typeof stored.name === "string" && stored.picks)
      return stored as Recipe;
  } catch {
    /* fall through to a fresh recipe */
  }
  return { name: "My mix", base: null, picks: {} };
})();
const persist = () => localStorage.setItem(RECIPE_KEY, JSON.stringify(recipe));

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
  if (!response.ok)
    throw new HttpError(
      (await response.text()) || response.statusText,
      response.status,
    );
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
const skinName = (key: string) => skinByKey(key)?.name ?? key;

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
const focusModel = monaco.editor.createModel("", "skin-ini");
const mixModel = monaco.editor.createModel("", "skin-ini");
const editor = await createEditor($("#editor"), currentScheme());
editor.setModel(focusModel);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  if (!save.disabled) void storeIni();
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!save.disabled) void storeIni();
  }
});
const focusDirty = () =>
  focused !== null && focusModel.getValue() !== savedText;
const mixEdited = () => mixModel.getValue() !== composedIni;

function renderIni() {
  const model = iniMode === "focus" ? focusModel : mixModel;
  if (editor.getModel() !== model) editor.setModel(model);
  const loadedFocus = focused ? loaded.get(focused) : undefined;
  const writable =
    iniMode === "focus" && !!loadedFocus?.snapshot.writable && vosu.canWrite;
  editor.updateOptions({ readOnly: iniMode === "focus" && !writable });
  $("#ini-focus").setAttribute("aria-pressed", String(iniMode === "focus"));
  $("#ini-mix").setAttribute("aria-pressed", String(iniMode === "mix"));
  save.hidden = reload.hidden = iniMode !== "focus";
  $("#ini-reset").hidden = iniMode !== "mix" || !mixEdited();
  save.disabled = !writable || saving || conflict || !focusDirty();
  reload.disabled = !focused || saving;
  const skin = skinByKey(focused);
  $("#ini-note").textContent =
    iniMode === "mix"
      ? mixEdited()
        ? "Edited by hand · used as-is when you build"
        : `Composed from your picks for “${recipe.name.trim() || "My mix"}”`
      : !focused
        ? "Select a skin"
        : skin?.origin === "lazer"
          ? "Lazer skins are read-only here"
          : !loadedFocus?.snapshot.writable
            ? "Read-only (not UTF-8)"
            : !vosu.canWrite
              ? "Read-only tab · open from the vosu dashboard to save"
              : `${skin?.name ?? ""} · saves keep a .bak copy`;
  const issues = check(model);
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
                onclick: () => {
                  editor.revealLineInCenter(d.line);
                  editor.setPosition({ lineNumber: d.line, column: d.column });
                  editor.focus();
                },
              },
              h("span", { class: "line" }, `L${d.line}`),
              h("span", { class: "message" }, d.message),
            ),
          ),
        )
      : [
          h(
            "li",
            { class: "clean" },
            "No problems against the wiki reference.",
          ),
        ]),
  );
}
focusModel.onDidChangeContent(() => {
  renderIni();
  if (iniMode === "focus") renderColours();
});
mixModel.onDidChangeContent(() => renderIni());

async function storeIni() {
  if (!focused) return;
  saving = true;
  renderIni();
  const text = focusModel.getValue();
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
      ? `Saved skin.ini. Previous version kept as ${data.backup}.`
      : "Saved. Created a new skin.ini.";
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
      h("p", { class: "none" }, libraryError || "Loading skins…"),
    );
    return;
  }
  const query = filter.value.trim().toLowerCase();
  const sections: [string, Skin["origin"]][] = [
    ["Stable", "stable"],
    ["Added folders", "added"],
    ["Lazer", "lazer"],
  ];
  const nodes: Node[] = [];
  for (const [title, origin] of sections) {
    const all = library.skins.filter((s) => s.origin === origin);
    const shown = all.filter(
      (s) => !query || s.name.toLowerCase().includes(query),
    );
    let note: string | null = null;
    if (origin === "stable" && !library.stable_dir)
      note =
        "No stable Skins folder. Attach vosu to osu!stable, or set one in this tool's settings.";
    if (origin === "lazer")
      note = !library.lazer.enabled
        ? "Hidden in settings."
        : library.lazer.error;
    if (!all.length && !note && origin === "added") continue;
    nodes.push(
      h("h2", {}, title, h("span", {}, all.length ? String(all.length) : "")),
    );
    if (note) nodes.push(h("p", { class: "note" }, note));
    if (all.length && !shown.length)
      nodes.push(h("p", { class: "none" }, "No match."));
    nodes.push(
      h(
        "ul",
        {},
        ...shown.map((skin) =>
          h(
            "li",
            { class: skin.available ? "" : "gone" },
            h(
              "button",
              {
                type: "button",
                class: "skin",
                disabled: !skin.available,
                title: skin.builtin
                  ? `Built into lazer (${skin.builtin}): no files to browse`
                  : skin.origin === "lazer"
                    ? `lazer${skin.creator ? ` · by ${skin.creator}` : ""}`
                    : skin.key,
                ariaCurrent: String(skin.key === focused),
                onclick: () => void focus(skin.key),
              },
              h("span", { class: "name" }, skin.name),
              skin.current && h("span", { class: "tag current" }, "current"),
              skin.builtin && h("span", { class: "tag" }, "built-in"),
              !skin.available &&
                !skin.builtin &&
                h("span", { class: "tag gone" }, "gone"),
              recipe.base === skin.key &&
                h("span", { class: "tag base" }, "base"),
            ),
            skin.origin === "added"
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "forget",
                    title: "Remove from the library (files stay untouched)",
                    ariaLabel: `Forget ${skin.name}`,
                    disabled: !vosu.canWrite,
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
  list.replaceChildren(...nodes);
}
filter.addEventListener("input", renderLibrary);

async function loadLibrary(): Promise<Library | null> {
  try {
    library = await request<Library>("v1/library");
    libraryError = "";
    currentSkinName = library.current?.name ?? null;
  } catch (error) {
    libraryError = `Skin library unavailable: ${message(error)}`;
  }
  renderLibrary();
  renderMix();
  if (!focused) renderGuide();
  return library;
}

async function forget(skin: Skin) {
  try {
    library = await post<Library>("v1/folders/forget", { skin: skin.key });
    loaded.delete(skin.key);
    if (focused === skin.key) await focus(null);
    status.textContent = `Forgot ${skin.key}. Its files were not touched.`;
    renderLibrary();
  } catch (error) {
    status.textContent = message(error);
  }
}

const folderHint = $("#folder-hint");
const folderHintText = folderHint.textContent!;
$<HTMLFormElement>("#add-folder").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("#folder-path");
  const path = input.value.trim();
  if (!path) return input.focus();
  const before = new Set(library?.skins.map((s) => s.key));
  folderHint.classList.remove("error");
  folderHint.removeAttribute("role");
  try {
    library = await post<Library>("v1/folders/add", { path });
    input.value = "";
    folderHint.textContent = folderHintText;
    renderLibrary();
    const added = library.skins.find((s) => !before.has(s.key));
    if (added) await focus(added.key);
  } catch (error) {
    folderHint.textContent = message(error);
    folderHint.classList.add("error");
    folderHint.setAttribute("role", "alert");
  }
});

// ---- focused skin ----------------------------------------------------------
async function focus(key: string | null) {
  if (focusDirty() && !confirm("Discard unsaved skin.ini changes?")) return;
  focused = key;
  conflict = false;
  renderLibrary();
  if (!key) {
    focusModel.setValue("");
    savedText = "";
    renderFocus();
    return;
  }
  status.textContent = `Reading ${skinName(key)}…`;
  try {
    const { snapshot } = await load(key, true);
    if (focused !== key) return;
    diskRevision = snapshot.revision;
    setFiles(
      focusModel,
      skinByKey(key)?.origin === "lazer"
        ? undefined
        : snapshot.files.map((f) => f.name),
    );
    focusModel.setValue(snapshot.text);
    // Monaco normalises mixed line endings; compare against what it holds.
    savedText = focusModel.getValue();
    status.textContent = `${skinName(key)} · ${snapshot.files.length} files`;
  } catch (error) {
    status.textContent = message(error);
  }
  renderFocus();
}

function renderColours() {
  const doc = parse(focusModel.getValue());
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
            onclick: () => {
              showView("ini");
              iniMode = "focus";
              renderIni();
              editor.revealLineInCenter(l.line);
              editor.setPosition({
                lineNumber: l.line,
                column: l.valueColumn ?? 1,
              });
              editor.focus();
            },
          },
          chip,
          h(
            "span",
            { class: "chip-label" },
            /^Combo(\d)$/.exec(l.key!)?.[1] ?? l.key!.replace(/[a-z]/g, ""),
          ),
        ),
      );
    }),
  );
}

function renderFocus() {
  const skin = skinByKey(focused);
  const entry = focused ? loaded.get(focused) : undefined;
  $("#focus-name").textContent = skin?.name ?? "No skin selected";
  const author = entry
    ? getValue(parseIni(entry.data.text), "General", "Author")
    : undefined;
  $("#focus-meta").textContent = skin
    ? [
        author ? `by ${author}` : skin.creator ? `by ${skin.creator}` : "",
        skin.origin === "lazer" ? "lazer · read-only" : skin.key,
        entry ? `${entry.snapshot.files.length} files` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  $<HTMLButtonElement>("#use-base").disabled = !focused;
  $<HTMLButtonElement>("#use-base").textContent =
    recipe.base === focused && focused ? "Mix base ✓" : "Use as mix base";
  renderColours();
  $("#guide").hidden = !!focused;
  $("#elements-view").hidden = !focused || view !== "elements";
  $("#ini-view").hidden = view !== "ini";
  if (!focused) renderGuide();
  renderCats();
  renderGroups();
  renderIni();
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

/** Collapses a group's files into preview tiles (frames become one tile). */
function tiles(data: SkinData, owned: string[]): Node[] {
  const byStem = new Map<string, string[]>();
  for (const file of owned) {
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
  const nodes: Node[] = [];
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
    nodes.push(tile(s, assetUrl(data.key, file), hd ? "@2x" : "SD"));
  }
  return nodes;
}

function tile(label: string, src: string, meta: string) {
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
  );
  const toggle = () => figure.classList.toggle("zoomed");
  figure.onclick = toggle;
  figure.onkeydown = (e) => {
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
      class: "play",
      ariaLabel: `Play ${file}`,
      onclick: () => {
        if (player.dataset.src === url && !player.paused) {
          player.pause();
          return;
        }
        player.src = url;
        player.dataset.src = url;
        void player.play().catch((error) => {
          status.textContent = `Cannot play ${file}: ${message(error)}`;
        });
      },
    },
    "▶",
  );
  button.dataset.src = url;
  return h(
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
        `${file.split(".").pop()} · ${size ? `${Math.max(1, Math.round(size / 1024))} KB` : "empty (silent)"}`,
      ),
    ),
  );
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
  if (!pick)
    return recipe.base
      ? `from base · ${skinName(recipe.base)}`
      : "osu! default";
  if (pick.kind === "skin") return skinName(pick.key);
  return pick.kind === "default" ? "osu! default" : "blank (hidden)";
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
  const controls = h(
    "div",
    { class: "pick" },
    h("span", { class: "pick-now" }, "Mix: ", h("b", {}, pickLabel(pick))),
    h(
      "button",
      {
        type: "button",
        class: isThis ? "chosen" : "",
        ariaPressed: String(isThis),
        onclick: () =>
          setPick(group.id, isThis ? null : { kind: "skin", key: data.key }),
      },
      isThis ? "Using this skin" : "Use this skin",
    ),
    h(
      "button",
      {
        type: "button",
        class: pick?.kind === "default" ? "chosen" : "",
        ariaPressed: String(pick?.kind === "default"),
        title: "Leave these elements out so osu! uses its default skin",
        onclick: () =>
          setPick(
            group.id,
            pick?.kind === "default" ? null : { kind: "default" },
          ),
      },
      "Default",
    ),
    canBlank &&
      h(
        "button",
        {
          type: "button",
          class: pick?.kind === "blank" ? "chosen" : "",
          ariaPressed: String(pick?.kind === "blank"),
          title: "Replace these elements with invisible images / silent sounds",
          onclick: () =>
            setPick(
              group.id,
              pick?.kind === "blank" ? null : { kind: "blank" },
            ),
        },
        "Blank",
      ),
  );
  const body = tiles(data, owned);
  return h(
    "section",
    { class: `group${pick ? " picked" : ""}` },
    h(
      "header",
      {},
      h(
        "h3",
        {},
        group.label,
        h("span", {}, owned.length ? `${owned.length} files` : ""),
      ),
      controls,
    ),
    iniLines.length
      ? h(
          "dl",
          { class: "ini-values" },
          ...iniLines.flatMap((line) => {
            const [key, ...rest] = line.split(":");
            const value = rest.join(":").trim();
            const c = rgb(value);
            const swatch = c && h("span", { class: "swatch" });
            if (swatch && c)
              swatch.style.backgroundColor = `rgb(${c[0]} ${c[1]} ${c[2]})`;
            return [h("dt", {}, key.trim()), h("dd", {}, swatch, value)];
          }),
        )
      : null,
    body.length
      ? h("div", { class: "tiles" }, ...body)
      : !iniLines.length
        ? h(
            "p",
            { class: "none" },
            "This skin has none of these elements; osu! uses its defaults.",
          )
        : null,
    missing.length && body.length
      ? missing.length > 8
        ? h(
            "details",
            { class: "missing" },
            h(
              "summary",
              {},
              `${missing.length} not in this skin (osu! default used)`,
            ),
            missing.join(", "),
          )
        : h(
            "p",
            { class: "missing" },
            "Not in this skin (osu! default used): ",
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
      h("p", { class: "none" }, focused ? "Reading skin…" : ""),
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
  recipe.base = recipe.base === focused ? null : focused;
  persist();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
};

// ---- views -----------------------------------------------------------------
function showView(next: "elements" | "ini") {
  view = next;
  $("#tab-elements").setAttribute("aria-selected", String(view === "elements"));
  $("#tab-ini").setAttribute("aria-selected", String(view === "ini"));
  $("#elements-view").hidden = view !== "elements" || !focused;
  $("#ini-view").hidden = view !== "ini";
  $("#guide").hidden = !!focused || view === "ini";
  if (view === "ini") {
    if (!focused) iniMode = "mix";
    renderIni();
    editor.layout();
  }
}
$("#tab-elements").onclick = () => showView("elements");
$("#tab-ini").onclick = () => showView("ini");
$("#ini-focus").onclick = () => {
  iniMode = "focus";
  renderIni();
};
$("#ini-mix").onclick = () => {
  iniMode = "mix";
  renderIni();
};
$("#ini-reset").onclick = () => {
  mixModel.setValue(composedIni);
};
reload.onclick = () => {
  if (
    focused &&
    (!focusDirty() || confirm("Discard unsaved skin.ini changes?"))
  ) {
    savedText = focusModel.getValue();
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
async function composeFor(target: Plan["target"], fresh = false) {
  const keys = recipeSkins(recipe);
  const map = new Map<string, SkinData>();
  for (const key of keys) {
    if (!skinByKey(key)?.available)
      throw new Error(
        `${skinName(key)} is no longer available; pick another skin for it.`,
      );
    map.set(key, (await load(key, fresh)).data);
  }
  return compose(recipe, map, target);
}
async function recompose() {
  try {
    const composed = await composeFor("stable");
    const wasEdited = mixEdited();
    composedIni = composed.plan.ini;
    counts = composed.counts;
    blanks = composed.plan.blanks.length;
    composeError = "";
    if (!wasEdited || !mixModel.getValue()) mixModel.setValue(composedIni);
  } catch (error) {
    composeError = message(error);
  }
  renderMix();
  renderIni();
}

function renderMix() {
  const base = recipe.base;
  $("#mix-base").textContent = base
    ? skinName(base)
    : "None, start from osu!'s defaults";
  $("#mix-base-clear").hidden = !base;
  const picks = Object.entries(recipe.picks)
    .map(([id, pick]) => ({ id, pick, group: groupById(id) }))
    .filter((p) => p.group);
  $("#mix-picks").replaceChildren(
    ...(picks.length
      ? picks.map(({ id, pick, group }) =>
          h(
            "li",
            {},
            h(
              "span",
              { class: "pick-group" },
              categories.find((c) => c.id === group!.category)?.label ?? "",
              " · ",
              h("b", {}, group!.label),
            ),
            h("span", { class: `pick-source ${pick.kind}` }, pickLabel(pick)),
            h(
              "button",
              {
                type: "button",
                class: "remove",
                ariaLabel: `Remove ${group!.label} from the mix`,
                onclick: () => setPick(id, null),
              },
              "×",
            ),
          ),
        )
      : [
          h(
            "li",
            { class: "empty" },
            "No element groups picked yet. Open a skin and press “Use this skin” on any group, or set a base.",
          ),
        ]),
  );
  const total = [...counts.values()].reduce((a, b) => a + b, 0) + blanks;
  $("#mix-summary").replaceChildren(
    ...(composeError
      ? [h("span", { class: "error" }, composeError)]
      : total || picks.length || base
        ? [
            `${total} files`,
            ...[...counts].map(([key, n]) => ` · ${n} from ${skinName(key)}`),
            blanks ? ` · ${blanks} blank` : "",
            mixEdited() ? " · skin.ini edited by hand" : "",
          ]
        : []),
  );
  const empty = !base && !picks.length;
  const reason = !vosu.canWrite
    ? "Open Skin studio from the vosu dashboard to build."
    : empty
      ? "Pick a base or at least one group."
      : composeError
        ? composeError
        : "";
  const stable = $<HTMLButtonElement>("#build-stable");
  const osk = $<HTMLButtonElement>("#build-osk");
  stable.disabled = !!reason || !library?.stable_dir || building;
  osk.disabled = !!reason || building;
  stable.title =
    reason ||
    (library?.stable_dir
      ? `Creates ${library.stable_dir}/${recipe.name.trim()}`
      : "No stable Skins folder known; set one in this tool's settings.");
  osk.title =
    reason ||
    `Writes ${library?.export_dir ?? "the export folder"}/${recipe.name.trim()}.osk${library?.settings.open_osk ? " and opens it so lazer imports it" : ""}`;
}
$("#mix-base-clear").onclick = () => {
  recipe.base = null;
  persist();
  renderFocus();
  renderLibrary();
  renderMix();
  scheduleCompose();
};
$("#mix-reset").onclick = () => {
  if (!confirm("Clear the mix (base and every pick)?")) return;
  recipe = { name: recipe.name, base: null, picks: {} };
  persist();
  mixModel.setValue("");
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
    const { plan } = await composeFor(library?.stable_dir ? "stable" : "osk");
    plan.ini = mixModel.getValue() || plan.ini;
    const link = h("a", {
      href: URL.createObjectURL(
        new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" }),
      ),
      download: `${plan.name || "mix"}.skin-plan.json`,
    });
    link.click();
    URL.revokeObjectURL(link.href);
    status.textContent = `Plan saved. Build it later with: vosux skin-studio build "${link.download}"`;
  } catch (error) {
    status.textContent = message(error);
  }
};

let building = false;
async function buildMix(target: Plan["target"]) {
  building = true;
  renderMix();
  const result = $("#mix-result");
  result.replaceChildren(
    h("p", {}, target === "stable" ? "Creating skin…" : "Packing .osk…"),
  );
  try {
    // Re-read every source so the plan matches the files on disk now.
    const composed = await composeFor(target, true);
    const plan = composed.plan;
    plan.ini =
      mixEdited() && mixModel.getValue()
        ? mixModel.getValue()
        : composed.plan.ini;
    let built: {
      path: string;
      replaced: boolean;
      files: number;
      opened: boolean;
    };
    try {
      built = await post("v1/build", plan);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      if (!confirm(`${message(error)}\n\nReplace it with this mix?`)) {
        result.replaceChildren(h("p", {}, "Nothing was changed."));
        return;
      }
      built = await post("v1/build", { ...plan, overwrite: true });
    }
    const nodes: Node[] = [
      h(
        "p",
        { class: "ok" },
        `${built.replaced ? "Replaced" : "Created"} ${built.files} files: `,
        h("code", {}, built.path),
      ),
    ];
    if (target === "stable")
      nodes.push(
        h(
          "p",
          {},
          "Select it in osu!stable's skin list (it rescans Skins when you open options).",
        ),
      );
    else {
      nodes.push(
        h(
          "p",
          {},
          built.opened
            ? "Handed to the system; osu!lazer imports it when it is your .osk handler."
            : "Open it with osu!lazer (or drag it onto lazer) to import.",
        ),
        h(
          "button",
          {
            type: "button",
            class: "quiet",
            onclick: () =>
              void post("v1/open", { path: built.path })
                .then(
                  () => (status.textContent = "Opened .osk with the system."),
                )
                .catch((e) => (status.textContent = message(e))),
          },
          built.opened ? "Open again" : "Open with lazer",
        ),
      );
    }
    result.replaceChildren(...nodes);
    status.textContent = `${recipe.name.trim()} built.`;
    await loadLibrary();
  } catch (error) {
    result.replaceChildren(h("p", { class: "error" }, message(error)));
  } finally {
    building = false;
    renderMix();
  }
}
$("#build-stable").onclick = () => void buildMix("stable");
$("#build-osk").onclick = () => void buildMix("osk");

// ---- guide -------------------------------------------------------------------
function renderGuide() {
  const blocks: Node[] = [
    h("p", { class: "kicker" }, "Skin studio"),
    h("h2", {}, "Pick a skin from the library to browse its elements."),
    h(
      "ol",
      { class: "steps" },
      h(
        "li",
        {},
        "Open a skin. Elements are grouped per ruleset: circles, sliders, mania stages, taiko drum, catcher, cursor, numbers, hitsounds and interface.",
      ),
      h(
        "li",
        {},
        "Press ",
        h("b", {}, "Use as mix base"),
        " for the skin you start from, then ",
        h("b", {}, "Use this skin"),
        " on any group you want from another skin.",
      ),
      h(
        "li",
        {},
        "Review the merged skin.ini in ",
        h("b", {}, "skin.ini → Mix draft"),
        "; edits there are used as-is.",
      ),
      h(
        "li",
        {},
        h("b", {}, "Create stable skin"),
        " writes a new folder in Skins (never over an existing one without asking). ",
        h("b", {}, "Export .osk"),
        " packs it for osu!lazer to import.",
      ),
    ),
  ];
  if (library?.lazer.enabled && library.lazer.error)
    blocks.push(
      h(
        "p",
        { class: "note" },
        "Lazer skins: ",
        library.lazer.error,
        " Until then, add the folder from lazer's skin editor → File → Edit externally… with ",
        h("b", {}, "Add a skin folder"),
        ".",
      ),
    );
  if (library && !library.stable_dir)
    blocks.push(
      h(
        "p",
        { class: "note" },
        "No stable Skins folder is known, so new skins can only be exported as .osk. Set the Skins folder in this tool's settings on the vosu dashboard.",
      ),
    );
  if (!vosu.canWrite)
    blocks.push(
      h(
        "p",
        { class: "note" },
        "This tab is read-only. Open Skin studio from the vosu dashboard to build, save and add folders.",
      ),
    );
  $("#guide").replaceChildren(h("div", { class: "guide-body" }, ...blocks));
}

// ---- live game state -------------------------------------------------------
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
  };
  vosu.subscribe(["/folders/skin", "/beatmap/mode/name"], onFrame, (state) => {
    // Older bridges never report a state; the badge stays hidden for them.
    live.hidden = false;
    live.dataset.state = state;
    live.textContent =
      state === "open"
        ? "Game live"
        : state === "connecting"
          ? "Connecting…"
          : "Game offline";
    live.title = "Follows the game's skin and the current beatmap's ruleset";
  });
}

// ---- start -------------------------------------------------------------------
try {
  await vosu.ready;
} catch (error) {
  status.textContent = message(error);
}
applyScheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!vosu.colorScheme) applyScheme();
});
$("#mode").textContent = vosu.canWrite ? "Write session" : "Read-only";
$("#mode").title = vosu.canWrite
  ? "Opened from the dashboard: saving and building are enabled."
  : "Open Skin studio from the vosu dashboard to save, add folders and build.";
$("#mode").classList.toggle("live", vosu.canWrite);
for (const control of document.querySelectorAll<
  HTMLInputElement | HTMLButtonElement
>("#add-folder input, #add-folder button"))
  control.disabled = !vosu.canWrite;
$("#revision").textContent =
  `Key reference: osu! wiki at ${revision.slice(0, 10)}. Checks run locally.`;
const initial = await loadLibrary();
if (initial) {
  const library = initial;
  const start = library.settings.start_ruleset;
  if (start !== "follow" && rulesets[start]) category = rulesets[start];
  for (const key of recipeSkins(recipe))
    if (!library.skins.some((s) => s.key === key)) {
      status.textContent = `${key} from the saved mix is not in the library any more.`;
    }
  const current = library.skins.find((s) => s.current && s.available);
  if (current) await focus(current.key);
  else {
    renderFocus();
    status.textContent = `${library.skins.length} skins in the library.`;
  }
} else renderFocus();
renderMix();
scheduleCompose();
subscribe();

setInterval(async () => {
  if (document.hidden) return;
  // Lazer skins appear once lazer-library has read lazer's database.
  if (library?.lazer.enabled && library.lazer.error) await loadLibrary();
  if (saving || !focused) return;
  const skin = skinByKey(focused);
  if (!skin || skin.origin === "lazer") return;
  try {
    const snapshot = await request<Snapshot>(
      `v1/skin?skin=${encodeURIComponent(focused)}`,
    );
    if (snapshot.revision !== diskRevision && !conflict) {
      conflict = true;
      status.textContent =
        "skin.ini changed on disk. Reload before saving; your editor text is kept until then.";
      renderIni();
    }
  } catch {
    await loadLibrary();
  }
}, 4000);
