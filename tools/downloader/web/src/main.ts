import { vosu } from "/tools/_host/v1/bridge.js";
import "./style.css";

type Difficulty = {
  difficulty_rating: number;
  version: string;
  mode_int: number;
  total_length: number;
  checksum?: string | null;
};
type Mapset = {
  id: number;
  artist: string;
  title: string;
  creator: string;
  status: string;
  owned: boolean;
  downloaded: boolean;
  beatmaps: Difficulty[];
};
type Search = Record<string, unknown>;
type Source = { name: string; enabled: boolean; priority: number };
type Config = {
  sources: Source[];
  no_video: boolean;
  hide_owned: boolean;
  follow_current_map: boolean;
  songs_dir: string;
};
type Workspace = {
  saved_searches: Record<string, Search>;
  presets: Record<string, Search>;
};
type Library = {
  client: string | null;
  source: "stable" | "lazer-library" | "none";
  loaded: boolean;
  owned_sets: number;
  refreshed_at: number | null;
  songs_dir: string | null;
  warnings: string[];
};
type Job = {
  id: string;
  set: Mapset;
  state: string;
  progress: number;
  message: string;
  bytes: number;
  total: number | null;
  sha256: string | null;
  imported_to: string | null;
};
type State = {
  config: Config | null;
  config_error: string | null;
  workspace: Workspace;
  queue: { paused: boolean; jobs: Job[] };
  library: Library;
};
type BasedOn = {
  checksum: string;
  artist: string;
  title: string;
  version: string;
  creator: string;
  stars: number;
};
type Pack = { tag: string; name: string; date?: string; author?: string };
type TaskStatus = { state: string; message: string; result: unknown };
type SearchResult = {
  beatmap_packs?: Pack[];
  beatmapsets?: Mapset[];
  hidden?: number;
  based_on?: BasedOn | null;
  cursor_string?: string | null;
  notices?: string[];
  library?: Library;
};

const RULESETS = ["osu!", "taiko", "catch", "mania"];
/** Discovery modes that derive their query from the map selected in osu!. */
const FOLLOWING: Record<string, true> = {
  mapper: true,
  similar: true,
  "similar-msd": true,
};
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const searchForm = el<HTMLFormElement>("search");
let config: Config | null = null;
let workspace: Workspace = { saved_searches: {}, presets: {} };
let results: Mapset[] = [];
let cursor: string | null = null;
let activeSearch: string | null = null;
let lastQuery: Search | null = null;
let basedOn: BasedOn | null = null;
let refreshing = false;
let filled = false;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
let toastTimer: number | undefined;
/** Short status line at the bottom right; errors stay longer. */
function toast(message: string, tone?: "ok" | "error") {
  const t = el("toast");
  t.textContent = message;
  if (tone) t.dataset.tone = tone;
  else delete t.dataset.tone;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => (t.hidden = true),
    tone === "error" ? 8000 : 4000,
  );
}
const fail = (e: unknown) =>
  toast(e instanceof Error ? e.message : String(e), "error");
/** Calls this tool's own service; `T` is the documented route response. */
async function api<T = unknown>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await vosu.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(v.error ?? `Request failed (${r.status})`);
  return v;
}
function input(name: string) {
  return searchForm.elements.namedItem(name) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
}
function empty(root: HTMLElement, text: string) {
  root.replaceChildren(node("p", text, "v-empty"));
}

// ── Collapsible search groups, remembered per browser ─────────────────
// Only open/closed flags are stored; nothing about the session or the user.
const PANELS_KEY = "vosu-downloader:panels";
function loadPanels(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(PANELS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
const panels = loadPanels();
document
  .querySelectorAll<HTMLDetailsElement>("details[data-panel]")
  .forEach((d) => {
    const id = d.dataset.panel!;
    if (id in panels) d.open = panels[id];
    d.addEventListener("toggle", () => {
      // Groups opened for the user (deep links, mode changes) are not choices.
      if (d.dataset.auto) {
        delete d.dataset.auto;
        return;
      }
      panels[id] = d.open;
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
      } catch {
        // Storage may be disabled; the groups still work for this page.
      }
    });
  });
function openPanel(id: string) {
  const d = document.querySelector<HTMLDetailsElement>(
    `details[data-panel="${id}"]`,
  );
  if (d && !d.open) {
    d.dataset.auto = "1";
    d.open = true;
  }
}
/** Counts the filters set inside each group. */
function updateBadges() {
  document.querySelectorAll<HTMLDetailsElement>(".dl-group").forEach((g) => {
    const badge = g.querySelector<HTMLElement>("[data-badge]");
    if (!badge) return;
    let n = 0;
    g.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input:not([name=limit]):not([name=offset]), textarea",
    ).forEach((f) => {
      if (f.value.trim()) n++;
    });
    if (g.dataset.panel === "discovery") {
      if (input("mode").value) n++;
      if (input("status").value !== "any") n++;
    }
    badge.textContent = n ? String(n) : "";
  });
}
searchForm.addEventListener("input", updateBadges);
input("discovery").addEventListener("change", () => {
  const mode = input("discovery").value;
  if (mode === "ids" || mode === "packs") openPanel("ids");
});

// ── Search ────────────────────────────────────────────────────────────
function readSearch(): Search {
  const q: Search = {};
  new FormData(searchForm).forEach((value, key) => (q[key] = String(value)));
  for (const key of [
    "min_stars",
    "max_stars",
    "min_bpm",
    "max_bpm",
    "min_length",
    "max_length",
    "mode",
  ])
    q[key] = q[key] === "" ? null : Number(q[key]);
  q.limit = Number(q.limit);
  q.offset = Number(q.offset);
  q.hide_owned = el<HTMLInputElement>("hide-owned").checked;
  return q;
}
function applySearch(q: Search, filtersOnly = false) {
  for (const [key, value] of Object.entries(q)) {
    if (
      filtersOnly &&
      ["query", "discovery", "provider", "ids", "pack", "cursor"].includes(key)
    )
      continue;
    if (key === "hide_owned") {
      el<HTMLInputElement>("hide-owned").checked = Boolean(value);
      continue;
    }
    const field = searchForm.elements.namedItem(key);
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement ||
      field instanceof HTMLTextAreaElement
    )
      field.value = value == null ? "" : String(value);
  }
  updateBadges();
}
async function pollJob<T>(id: string): Promise<T> {
  for (;;) {
    const j = await api<TaskStatus>(`v1/jobs/${id}`);
    // Task results are the service's documented route payloads.
    if (j.state === "done") return j.result as T;
    if (j.state === "failed" || j.state === "cancelled")
      throw new Error(j.message);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
}
const length = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** `match`: MD5 of a difficulty to mark (the linked or the current map). */
function mapRow(s: Mapset, match?: string) {
  const row = node("tr");
  const pick = node("td", undefined, "dl-pick");
  const check = node("input");
  check.type = "checkbox";
  check.value = String(s.id);
  check.setAttribute("aria-label", `Select ${s.artist} — ${s.title}`);
  pick.append(check);
  const title = node("td", undefined, "dl-title");
  const link = node("a", `${s.artist} — ${s.title}`);
  link.href = `https://osu.ppy.sh/beatmapsets/${s.id}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const diffs = node("div", undefined, "dl-diffs");
  const sorted = [...s.beatmaps].sort(
    (a, b) => a.difficulty_rating - b.difficulty_rating,
  );
  // Long sets list the first 8 by stars, always keeping the matched one.
  const shown = sorted.filter((d, i) => i < 8 || d.checksum === match);
  shown.forEach((d, i) => {
    if (i) diffs.append(" · ");
    diffs.append(
      node(
        "span",
        `${d.difficulty_rating.toFixed(2)}★ ${d.version}`,
        match && d.checksum === match ? "match" : undefined,
      ),
    );
  });
  if (sorted.length > shown.length)
    diffs.append(` · +${sorted.length - shown.length}`);
  // The line is clamped to two rows; the full list stays one hover away.
  diffs.title = sorted
    .map((d) => `${d.difficulty_rating.toFixed(2)}★ ${d.version}`)
    .join("\n");
  title.append(link, diffs);
  const modes = [...new Set(s.beatmaps.map((d) => RULESETS[d.mode_int]))];
  const stars = s.beatmaps.map((d) => d.difficulty_rating);
  const longest = Math.max(0, ...s.beatmaps.map((d) => d.total_length));
  const flags = node("td", undefined, "");
  const wrap = node("div", undefined, "dl-flags");
  if (s.owned) wrap.append(node("span", "In library", "v-badge v-badge--ok"));
  if (s.downloaded)
    wrap.append(node("span", "Downloaded", "v-badge v-badge--ok"));
  flags.append(wrap);
  row.append(
    pick,
    title,
    node("td", s.creator),
    node("td", s.status, "v-muted"),
    node("td", modes.join(", "), "v-muted"),
    node(
      "td",
      stars.length
        ? `${Math.min(...stars).toFixed(2)}–${Math.max(...stars).toFixed(2)}`
        : "",
      "v-num",
    ),
    node("td", length(longest), "v-num"),
    flags,
  );
  return row;
}
function showResults(sets: Mapset[], hidden = 0, match?: string) {
  results = sets;
  const root = el("results");
  el("result-count").textContent = `${sets.length}`;
  const hiddenBadge = el("hidden-count");
  hiddenBadge.hidden = !hidden;
  hiddenBadge.textContent = `${hidden} hidden`;
  if (!sets.length) {
    empty(root, hidden ? "All results are already in your library." : "No results.");
    return;
  }
  const table = node("table", undefined, "v-table");
  const head = node("tr");
  for (const [label, cls] of [
    ["", "dl-pick"],
    ["Set", ""],
    ["Mapper", ""],
    ["Status", ""],
    ["Mode", ""],
    ["Stars", "v-num"],
    ["Length", "v-num"],
    ["", ""],
  ])
    head.append(node("th", label, cls || undefined));
  const thead = node("thead");
  thead.append(head);
  const body = node("tbody");
  body.append(...sets.map((s) => mapRow(s, match)));
  body.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    box.closest("tr")?.setAttribute("aria-selected", String(box.checked));
  });
  table.append(thead, body);
  root.replaceChildren(table);
  root.scrollTop = 0;
}
function showPacks(v: SearchResult) {
  const root = el("results");
  const packs = v.beatmap_packs ?? [];
  el("result-count").textContent = `${packs.length}`;
  el("hidden-count").hidden = true;
  if (!packs.length) return empty(root, "No packs.");
  const table = node("table", undefined, "v-table");
  const head = node("tr");
  for (const label of ["Pack", "Date", "Author", ""])
    head.append(node("th", label));
  const thead = node("thead");
  thead.append(head);
  const body = node("tbody");
  for (const p of packs) {
    const row = node("tr");
    const open = node("button", "Open", "v-btn v-btn--sm");
    open.type = "button";
    open.disabled = !vosu.canWrite;
    open.onclick = () => {
      input("pack").value = p.tag;
      input("provider").value = "official";
      searchForm.requestSubmit();
    };
    const action = node("td", undefined, "v-num");
    action.append(open);
    row.append(
      node("td", `${p.tag} · ${p.name}`),
      node("td", p.date ?? "", "v-muted"),
      node("td", p.author ?? "", "v-muted"),
      action,
    );
    body.append(row);
  }
  table.append(thead, body);
  root.replaceChildren(table);
}
function showBasedOn() {
  const p = el("based-on");
  if (!basedOn || !lastQuery || !FOLLOWING[String(lastQuery.discovery)]) {
    p.hidden = true;
    return;
  }
  const following = config?.follow_current_map && vosu.canWrite;
  p.replaceChildren(
    node(
      "span",
      following ? "Following" : "Based on",
      following ? "v-badge v-badge--accent" : "v-badge",
    ),
    node(
      "span",
      `${basedOn.artist} — ${basedOn.title} [${basedOn.version}] · ${basedOn.stars.toFixed(2)}★`,
    ),
  );
  p.title = `${basedOn.artist} — ${basedOn.title} [${basedOn.version}] by ${basedOn.creator}`;
  p.hidden = false;
}
let pendingFollow = false;
async function runSearch(q: Search) {
  el<HTMLButtonElement>("cancel-search").disabled = false;
  el("result-count").textContent = "…";
  try {
    lastQuery = q;
    el("link-note").hidden = true;
    const r = await api<{ job: string }>("v1/search", q);
    activeSearch = r.job;
    const v = await pollJob<SearchResult>(r.job);
    if (v.beatmap_packs) {
      results = [];
      basedOn = null;
      showPacks(v);
    } else {
      basedOn = v.based_on ?? null;
      if (v.library) showLibrary(v.library);
      showResults(v.beatmapsets ?? [], v.hidden ?? 0, basedOn?.checksum);
      cursor = v.cursor_string ?? null;
      el<HTMLButtonElement>("next-page").disabled = !vosu.canWrite;
    }
    if (v.notices?.length) toast(v.notices.join(" · "));
    showBasedOn();
  } catch (e) {
    el("result-count").textContent = "";
    fail(e);
  } finally {
    activeSearch = null;
    el<HTMLButtonElement>("cancel-search").disabled = true;
    if (pendingFollow) {
      pendingFollow = false;
      followCurrentMap();
    }
  }
}
searchForm.onsubmit = (e) => {
  e.preventDefault();
  const q = readSearch();
  q.cursor = "";
  void runSearch(q);
};
el("next-page").onclick = () => {
  if (!lastQuery) return;
  const q = {
    ...lastQuery,
    offset: Number(lastQuery.offset ?? 0) + Number(lastQuery.limit ?? 20),
    cursor: cursor ?? "",
  };
  input("offset").value = String(q.offset);
  void runSearch(q);
};
el("cancel-search").onclick = () => {
  if (activeSearch)
    void api(`v1/jobs/${activeSearch}`, undefined, "DELETE").catch(fail);
};
el("hide-owned").addEventListener("change", () => {
  if (lastQuery && vosu.canWrite && !activeSearch)
    void runSearch({ ...lastQuery, hide_owned: readSearch().hide_owned });
});
el("select-all").onclick = () => {
  const checks = [
    ...el("results").querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
  ];
  const value = checks.some((c) => !c.checked);
  for (const c of checks) {
    c.checked = value;
    c.closest("tr")?.setAttribute("aria-selected", String(value));
  }
};
el("enqueue").onclick = async () => {
  const chosen = new Set(
    [...el("results").querySelectorAll<HTMLInputElement>("input:checked")].map(
      (c) => Number(c.value),
    ),
  );
  if (!chosen.size) return toast("Select sets first.");
  try {
    await api("v1/queue", {
      sets: results.filter((s) => chosen.has(s.id)),
      source: el<HTMLSelectElement>("download-source").value,
      no_video: el<HTMLInputElement>("no-video").checked,
    });
    toast(`Queued ${chosen.size} set${chosen.size === 1 ? "" : "s"}.`, "ok");
    await refresh();
  } catch (e) {
    fail(e);
  }
};

// ── Follow the map selected in osu! ──────────────────────────────────
// /websocket/v2/subscribe: request JSON Pointers, then frames
// [0, rev, [[index, value]…]] (full), [1, rev, [[index, value]…], [removed…]]
// (changes) or [2, code, message] (error).
const POINTERS = [
  "/beatmap/checksum",
  "/beatmap/artist",
  "/beatmap/title",
  "/beatmap/version",
  "/beatmap/mapper",
  "/client",
] as const;
const live: unknown[] = POINTERS.map(() => undefined);
let followTimer: number | undefined;
function onFrame(frame: unknown) {
  if (!Array.isArray(frame)) return;
  const [kind, , changes, removed] = frame as [
    number,
    number,
    [number, unknown][],
    number[]?,
  ];
  if (kind === 2) return;
  const before = live[0];
  if (kind === 0) live.fill(undefined);
  for (const [i, v] of changes ?? []) live[i] = v;
  for (const i of removed ?? []) live[i] = undefined;
  showNow();
  if (live[0] !== before) {
    window.clearTimeout(followTimer);
    // Debounced: scrolling through song select fires many changes.
    followTimer = window.setTimeout(followCurrentMap, 1200);
  }
}
function showNow() {
  const [checksum, artist, title, version, mapper, client] = live as (
    | string
    | undefined
  )[];
  el("now-map").textContent = checksum
    ? `${artist ?? "?"} — ${title ?? "?"} [${version ?? "?"}] · ${mapper ?? "?"}`
    : client
      ? "No beatmap selected"
      : "osu! not attached";
}
function followCurrentMap() {
  const checksum = live[0];
  if (
    typeof checksum !== "string" ||
    !checksum ||
    !lastQuery ||
    !FOLLOWING[String(lastQuery.discovery)] ||
    !config?.follow_current_map ||
    !vosu.canWrite ||
    basedOn?.checksum === checksum
  )
    return;
  if (activeSearch) {
    pendingFollow = true;
    return;
  }
  input("offset").value = "0";
  void runSearch({ ...lastQuery, offset: 0, cursor: "" });
}

// ── Library, workspace, queue ────────────────────────────────────────
el("library").onclick = async () => {
  try {
    const j = await api<{ job: string }>("v1/library", {});
    await pollJob(j.job);
    toast("Library refreshed.", "ok");
    await refresh();
  } catch (e) {
    fail(e);
  }
};
document
  .querySelectorAll<HTMLButtonElement>("[data-control]")
  .forEach((b) => {
    b.onclick = async () => {
      try {
        await api("v1/queue/control", { action: b.dataset.control });
        await refresh();
      } catch (e) {
        fail(e);
      }
    };
  });
document.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) => {
  b.onclick = () => b.closest("dialog")?.close("cancel");
});
/** Wires a `.v-seg` so exactly one button is pressed; returns the reader. */
function segment(root: HTMLElement, key: string, onChange?: () => void) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
  for (const b of buttons)
    b.onclick = () => {
      for (const o of buttons) o.setAttribute("aria-pressed", String(o === b));
      onChange?.();
    };
  return {
    get: () =>
      buttons.find((b) => b.getAttribute("aria-pressed") === "true")!.dataset[
        key
      ]!,
    set: (value: string) => {
      for (const o of buttons)
        o.setAttribute("aria-pressed", String(o.dataset[key] === value));
      onChange?.();
    },
  };
}

// Save drawer: replaces the browser prompt for names.
const saveDrawer = el<HTMLDialogElement>("save-drawer");
const saveKind = segment(
  saveDrawer.querySelector<HTMLElement>(".v-seg")!,
  "kind",
);
el("save-open").onclick = () => {
  el<HTMLInputElement>("save-name").value = "";
  saveDrawer.showModal();
};
saveDrawer.addEventListener("close", async () => {
  if (saveDrawer.returnValue !== "save") return;
  const name = el<HTMLInputElement>("save-name").value.trim();
  const kind = saveKind.get() as keyof Workspace;
  if (!name) return;
  try {
    workspace = await api<Workspace>("v1/workspace", {
      ...workspace,
      [kind]: { ...workspace[kind], [name]: readSearch() },
    });
    showWorkspace();
    toast(`Saved “${name}”.`, "ok");
  } catch (e) {
    fail(e);
  }
});
el<HTMLSelectElement>("saved").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (workspace.saved_searches[name]) applySearch(workspace.saved_searches[name]);
};
el<HTMLSelectElement>("presets").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (workspace.presets[name]) applySearch(workspace.presets[name], true);
};
function options(id: string, values: string[]) {
  const s = el<HTMLSelectElement>(id);
  const old = s.value;
  const first = node("option", "None");
  first.value = "";
  s.replaceChildren(first);
  for (const value of values) {
    const o = node("option", value);
    o.value = value;
    s.append(o);
  }
  s.value = values.includes(old) ? old : "";
}
function showWorkspace() {
  options("saved", Object.keys(workspace.saved_searches));
  options("presets", Object.keys(workspace.presets));
}

// Import drawer: replaces the browser confirm, holds the destination.
const importDrawer = el<HTMLDialogElement>("import-drawer");
const importClient = segment(
  importDrawer.querySelector<HTMLElement>(".v-seg")!,
  "client",
  () => (el("songs-field").hidden = importClient.get() !== "stable"),
);
let importing: Job | null = null;
function openImport(j: Job) {
  importing = j;
  const facts = el("import-facts");
  facts.replaceChildren();
  const add = (k: string, v: string) =>
    facts.append(node("dt", k), node("dd", v));
  add("Set", `${j.set.artist} — ${j.set.title}`);
  add("ID", `#${j.set.id}`);
  if (j.sha256) add("SHA-256", j.sha256);
  if (j.imported_to) add("Placed", j.imported_to);
  const songs = el<HTMLInputElement>("songs");
  if (!songs.value) songs.value = config?.songs_dir || libraryDir || "";
  importClient.set(lastLibraryClient === "lazer" ? "lazer" : "stable");
  importDrawer.showModal();
}
importDrawer.addEventListener("close", async () => {
  const j = importing;
  importing = null;
  if (importDrawer.returnValue !== "import" || !j) return;
  const client = importClient.get();
  const songs = el<HTMLInputElement>("songs").value.trim();
  if (client === "stable" && !songs) return toast("Songs folder required.", "error");
  try {
    const v = await api<{ message: string; path?: string }>(
      `v1/import/${j.id}`,
      { client, songs_dir: songs || null },
    );
    toast(v.path ? `Placed ${v.path}` : "Opened with the system handler.", "ok");
    await refresh();
  } catch (e) {
    fail(e);
  }
});

let libraryDir: string | null = null;
let lastLibraryClient: string | null = null;
function showLibrary(lib: Library) {
  libraryDir = lib.songs_dir;
  lastLibraryClient = lib.client;
  const where =
    lib.source === "stable"
      ? "stable"
      : lib.source === "lazer-library"
        ? "lazer"
        : null;
  const chip = el("ownership");
  chip.textContent = where
    ? `${where} · ${lib.owned_sets.toLocaleString()} sets`
    : lib.loaded
      ? "Library unknown"
      : "Library not loaded";
  chip.className = `v-badge${where ? "" : lib.loaded ? " v-badge--warn" : ""}`;
  chip.title = lib.warnings.join("\n");
  const facts = el("library-facts");
  facts.replaceChildren();
  const add = (k: string, v: string) =>
    facts.append(node("dt", k), node("dd", v));
  add("Client", lib.client ?? "—");
  add("Source", where ?? "—");
  add("Sets", where ? lib.owned_sets.toLocaleString() : "—");
  add(
    "Updated",
    lib.refreshed_at
      ? new Date(lib.refreshed_at * 1000).toLocaleTimeString()
      : "—",
  );
  el("library-warnings").replaceChildren(
    ...lib.warnings.map((w) => node("li", w)),
  );
}
function jobRow(j: Job) {
  const row = node("div", undefined, "dl-job");
  row.dataset.state = j.state;
  const title = node("span", `${j.set.artist} — ${j.set.title}`, "dl-job__title");
  title.title = title.textContent ?? "";
  const tone =
    j.state === "done"
      ? " v-badge--ok"
      : j.state === "running"
        ? " v-badge--accent"
        : j.state === "failed" || j.state === "cancelled"
          ? " v-badge--error"
          : "";
  const meter = node("div", undefined, "v-meter");
  meter.style.setProperty("--v-value", String(j.progress));
  if (j.state === "done") meter.style.setProperty("--v-color", "var(--ok)");
  const info = node("div", undefined, "dl-job__info");
  const mib = (n: number) => (n / 1048576).toFixed(1);
  const size = node(
    "span",
    j.state === "failed"
      ? j.message
      : `${mib(j.bytes)}${j.total ? ` / ${mib(j.total)}` : ""} MiB`,
    j.state === "failed" ? "" : "v-mono",
  );
  if (j.state === "failed") size.style.color = "var(--danger)";
  const actions = node("span", undefined, "v-toolbar");
  if (j.state === "queued" || j.state === "running") {
    const b = node("button", "Cancel", "v-btn v-btn--sm");
    b.type = "button";
    b.disabled = !vosu.canWrite;
    b.onclick = async () => {
      await api(`v1/jobs/${j.id}`, undefined, "DELETE").catch(fail);
      await refresh();
    };
    actions.append(b);
  }
  if (j.state === "done") {
    const b = node(
      "button",
      j.imported_to ? "Import again" : "Import",
      "v-btn v-btn--sm",
    );
    b.type = "button";
    b.disabled = !vosu.canWrite;
    b.onclick = () => openImport(j);
    actions.append(b);
  }
  info.append(size, actions);
  row.append(title, node("span", j.state, `v-badge${tone}`), meter, info);
  return row;
}
function showQueue(q: State["queue"]) {
  const status = el("queue-status");
  status.textContent = q.paused ? "Paused" : "Running";
  status.className = `v-badge${q.paused ? "" : " v-badge--accent"}`;
  const root = el("queue");
  const scroll = root.scrollTop;
  if (!q.jobs.length) empty(root, "Queue is empty.");
  else root.replaceChildren(...q.jobs.map(jobRow));
  root.scrollTop = scroll;
}
function showConfig(state: State) {
  config = state.config;
  const err = el("config-error");
  err.hidden = !state.config_error;
  err.title = state.config_error ?? "";
  if (!config) return;
  const sources = el<HTMLSelectElement>("download-source");
  const names = config.sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.name);
  if ([...sources.options].map((o) => o.value).join() !== names.join()) {
    sources.replaceChildren(
      ...names.map((n) => {
        const o = node("option", n);
        o.value = n;
        return o;
      }),
    );
  }
  if (!filled) {
    el<HTMLInputElement>("no-video").checked = config.no_video;
    el<HTMLInputElement>("hide-owned").checked = config.hide_owned;
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await api<State>("v1/state");
    showConfig(state);
    showLibrary(state.library);
    showQueue(state.queue);
    if (!filled) {
      workspace = state.workspace;
      showWorkspace();
      filled = true;
    }
    showBasedOn();
  } catch (e) {
    fail(e);
  } finally {
    refreshing = false;
  }
}

// ── Deep link: #md5=<32 hex> (e.g. from the replay renderer) ─────────
async function openLink() {
  const md5 = new URLSearchParams(location.hash.slice(1)).get("md5");
  if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) return;
  const hash = md5.toLowerCase();
  input("discovery").value = "ids";
  input("ids").value = hash;
  openPanel("ids");
  updateBadges();
  try {
    const r = await vosu.fetch(`v1/lookup/${hash}`);
    const v = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(v.error ?? `Lookup failed (${r.status})`);
    showResults([v.beatmapset], 0, hash);
    lastQuery = { ...readSearch(), discovery: "ids" };
    el("link-md5").textContent = hash;
    el("link-note").hidden = false;
    const check = el("results").querySelector<HTMLInputElement>(
      "input[type=checkbox]",
    );
    if (check && vosu.canWrite) {
      check.checked = true;
      check.closest("tr")?.setAttribute("aria-selected", "true");
    }
  } catch (e) {
    fail(e);
  }
}
el("copy-md5").onclick = () =>
  void navigator.clipboard
    .writeText(el("link-md5").textContent ?? "")
    .then(() => toast("MD5 copied.", "ok"), fail);

// ── Start ─────────────────────────────────────────────────────────────
await vosu.ready.catch(fail);
const access = el("access");
access.hidden = vosu.canWrite;
access.title = "Open from the vosu dashboard to search and download.";
document
  .querySelectorAll<HTMLButtonElement>(".write")
  .forEach((b) => (b.disabled ||= !vosu.canWrite));
el<HTMLAnchorElement>("settings-link").href = new URL(
  "/settings?tool=downloader",
  vosu.dashboardUrl,
).href;
updateBadges();
// Bridges from vosu 1.2.0 reconnect by themselves and report the connection;
// older ones never call onStatus, so the indicator stays hidden there.
vosu.subscribe(POINTERS, onFrame, (state) => {
  el("live").hidden = false;
  el("live-dot").dataset.state =
    state === "open" ? "ok" : state === "connecting" ? "busy" : "error";
  el("live-text").textContent =
    state === "open" ? "Live" : state === "connecting" ? "Connecting" : "Offline";
});
await refresh();
await openLink();
setInterval(() => void refresh(), 1500);
