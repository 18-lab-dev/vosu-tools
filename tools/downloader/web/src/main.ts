import { vosu } from "/tools/_host/v1/bridge.js";
import "./style.css";

function applyScheme() {
  document.documentElement.dataset.scheme =
    vosu.colorScheme ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
applyScheme();

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
  concurrency: number;
  max_file_mb: number;
  no_video: boolean;
  hide_owned: boolean;
  follow_current_map: boolean;
  songs_dir: string;
  credentials_configured: boolean;
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

const RULESETS = ["osu!", "taiko", "catch", "mania"];
/** Discovery modes that derive their query from the map selected in osu!. */
const FOLLOWING: Record<string, true> = {
  mapper: true,
  similar: true,
  "similar-msd": true,
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
  filter_scope?: string;
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

const notice = (s: string) => {
  el("notice").textContent = s;
};
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

// ── Collapsible filter groups, remembered per browser ─────────────────
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
document.querySelectorAll<HTMLDetailsElement>("details[data-panel]").forEach(
  (d) => {
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
  },
);
function openPanel(id: string) {
  const d = document.querySelector<HTMLDetailsElement>(
    `details[data-panel="${id}"]`,
  );
  if (d && !d.open) {
    d.dataset.auto = "1";
    d.open = true;
  }
}
/** Shows how many filters are set inside each closed-or-open group. */
function updateBadges() {
  document.querySelectorAll<HTMLDetailsElement>(".group").forEach((g) => {
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
    badge.textContent = n ? `${n} set` : "";
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
/** `match`: MD5 of a difficulty to mark (the linked or the current map). */
function mapRow(s: Mapset, match?: string) {
  const row = node("article", undefined, "map");
  const check = node("input");
  check.type = "checkbox";
  check.value = String(s.id);
  check.setAttribute("aria-label", `Select ${s.artist} — ${s.title}`);
  const content = node("div");
  const title = node("a", `${s.artist} — ${s.title}`);
  title.href = `https://osu.ppy.sh/beatmapsets/${s.id}`;
  title.target = "_blank";
  title.rel = "noopener noreferrer";
  const meta = node(
    "p",
    `${s.creator} / ${s.status.toUpperCase()} / #${s.id}`,
    "meta",
  );
  if (s.owned) meta.append(node("span", "IN LIBRARY", "stamp owned"));
  if (s.downloaded) meta.append(node("span", "DOWNLOADED", "stamp downloaded"));
  const diffs = node("div", undefined, "diffs");
  const sorted = [...s.beatmaps].sort(
    (a, b) => a.difficulty_rating - b.difficulty_rating,
  );
  // Large packs list the first 12 by stars, always keeping the matched one.
  const shown = sorted.filter((d, i) => i < 12 || d.checksum === match);
  for (const d of shown)
    diffs.append(
      node(
        "span",
        `${d.difficulty_rating.toFixed(2)}★ ${RULESETS[d.mode_int] ?? "?"} · ${d.version} · ${d.total_length}s`,
        match && d.checksum === match ? "match" : undefined,
      ),
    );
  if (sorted.length > shown.length)
    diffs.append(
      node("span", `+${sorted.length - shown.length} more`, "more"),
    );
  content.append(title, meta, diffs);
  row.append(check, content);
  return row;
}
function showResults(sets: Mapset[], hidden = 0, match?: string) {
  results = sets;
  const root = el("results");
  root.replaceChildren(...sets.map((s) => mapRow(s, match)));
  root.scrollTop = 0;
  el("result-count").textContent =
    `${sets.length} set${sets.length === 1 ? "" : "s"}` +
    (hidden ? ` · ${hidden} hidden (already have)` : "");
  if (!sets.length)
    root.append(
      node(
        "p",
        hidden
          ? "Every set on this page is one you already have. Try the next page, or untick “Hide sets I already have”."
          : "No matching sets on this page. Try the next page or relax filters.",
        "empty",
      ),
    );
}
function showPacks(v: SearchResult) {
  const root = el("results");
  root.replaceChildren();
  for (const p of v.beatmap_packs ?? []) {
    const row = node("article", undefined, "map");
    const b = node("button", `${p.tag} / ${p.name}`);
    b.type = "button";
    b.disabled = !vosu.canWrite;
    b.onclick = () => {
      input("pack").value = p.tag;
      input("provider").value = "official";
      searchForm.requestSubmit();
    };
    row.append(b, node("p", `${p.date ?? ""} · ${p.author ?? ""}`, "meta"));
    root.append(row);
  }
  el("result-count").textContent = "Official packs";
}
function showBasedOn() {
  const p = el("based-on");
  if (!basedOn || !lastQuery || !FOLLOWING[String(lastQuery.discovery)]) {
    p.hidden = true;
    return;
  }
  const following = config?.follow_current_map && vosu.canWrite;
  p.replaceChildren(
    node("span", "Based on", "k"),
    node(
      "strong",
      `${basedOn.artist} — ${basedOn.title} [${basedOn.version}]`,
    ),
    node("span", `by ${basedOn.creator} · ${basedOn.stars.toFixed(2)}★`),
    node(
      "span",
      following
        ? "Follows the map you select in osu!"
        : !vosu.canWrite
          ? "Read-only: open from the dashboard to follow"
          : "Following is off in Settings",
      "state",
    ),
  );
  p.hidden = false;
}
let pendingFollow = false;
async function runSearch(q: Search) {
  el<HTMLButtonElement>("cancel-search").disabled = false;
  try {
    notice("Searching… requests are paced and cached.");
    lastQuery = q;
    const r = await api<{ job: string }>("v1/search", q);
    activeSearch = r.job;
    const v = await pollJob<SearchResult>(r.job);
    if (v.beatmap_packs) {
      results = [];
      basedOn = null;
      showPacks(v);
      notice("Choose a pack to inspect its sets. Official credentials required.");
    } else {
      basedOn = v.based_on ?? null;
      showResults(v.beatmapsets ?? [], v.hidden ?? 0, basedOn?.checksum);
      cursor = v.cursor_string ?? null;
      el<HTMLButtonElement>("next-page").disabled = !vosu.canWrite;
      notice(
        [...(v.notices ?? []), v.filter_scope ?? ""].join(" ") ||
          "Search complete.",
      );
    }
    showBasedOn();
  } catch (e) {
    notice(String(e));
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
    void api(`v1/jobs/${activeSearch}`, undefined, "DELETE").catch((e) =>
      notice(String(e)),
    );
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
  for (const c of checks) c.checked = value;
};
el("enqueue").onclick = async () => {
  try {
    const chosen = new Set(
      [
        ...el("results").querySelectorAll<HTMLInputElement>("input:checked"),
      ].map((c) => Number(c.value)),
    );
    if (!chosen.size) {
      notice("Tick the sets you want first.");
      return;
    }
    await api("v1/queue", {
      sets: results.filter((s) => chosen.has(s.id)),
      source: el<HTMLSelectElement>("download-source").value,
      no_video: el<HTMLInputElement>("no-video").checked,
    });
    notice(
      "Selected sets queued. Resume the queue when ready; it starts paused and every restart pauses it.",
    );
    await refresh();
  } catch (e) {
    notice(String(e));
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
];
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
    notice("Reading your library (stable databases are copied first)…");
    const j = await api<{ job: string }>("v1/library", {});
    await pollJob(j.job);
    notice("Library refreshed.");
    await refresh();
  } catch (e) {
    notice(String(e));
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
        notice(String(e));
      }
    };
  });
async function saveNamed(kind: "saved_searches" | "presets") {
  const name = prompt(
    kind === "presets" ? "Name this filter preset" : "Name this search",
  );
  if (!name?.trim()) return;
  try {
    workspace = await api<Workspace>("v1/workspace", {
      ...workspace,
      [kind]: { ...workspace[kind], [name.trim()]: readSearch() },
    });
    showWorkspace();
    notice(`Saved “${name.trim()}”.`);
  } catch (e) {
    notice(String(e));
  }
}
el("save-search").onclick = () => void saveNamed("saved_searches");
el("save-preset").onclick = () => void saveNamed("presets");
el<HTMLSelectElement>("saved").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (workspace.saved_searches[name]) applySearch(workspace.saved_searches[name]);
};
el<HTMLSelectElement>("presets").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (workspace.presets[name]) applySearch(workspace.presets[name], true);
};
function options(id: string, placeholder: string, values: string[]) {
  const s = el<HTMLSelectElement>(id);
  const old = s.value;
  const first = node("option", placeholder);
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
  options("saved", "Choose a saved search", Object.keys(workspace.saved_searches));
  options("presets", "Choose a preset", Object.keys(workspace.presets));
}
function showLibrary(lib: Library) {
  const chip = el("ownership");
  const where =
    lib.source === "stable"
      ? "stable"
      : lib.source === "lazer-library"
        ? "lazer"
        : null;
  chip.textContent = where
    ? `Library · ${where} · ${lib.owned_sets.toLocaleString()} sets`
    : lib.loaded
      ? "Library · ownership unknown"
      : "Library · not loaded";
  chip.title = where
    ? `Sets you already have, from ${lib.source === "stable" ? "a read-only osu!.db copy" : "the Lazer library tool"}`
    : "Sets you already have cannot be detected yet; see Local library";
  el("library-state").textContent = !lib.loaded
    ? "Loads automatically with the first search."
    : where
      ? `${lib.owned_sets.toLocaleString()} sets in your ${where} library`
      : "Ownership unknown";
  el("library-warnings").replaceChildren(
    ...lib.warnings.map((w) => node("li", w)),
  );
  const songs = el<HTMLInputElement>("songs");
  if (!songs.value) songs.value = config?.songs_dir || lib.songs_dir || "";
}
function jobRow(j: Job) {
  const row = node("article", undefined, "queue-job");
  row.dataset.state = j.state;
  const head = node("div", undefined, "head");
  head.append(
    node("strong", `${j.set.artist} — ${j.set.title}`),
    node("span", j.state.toUpperCase()),
  );
  const p = node("progress");
  p.max = 1;
  p.value = j.progress;
  const info = node(
    "p",
    `${j.message} · ${(j.bytes / 1048576).toFixed(2)}${j.total ? ` / ${(j.total / 1048576).toFixed(2)}` : ""} MiB`,
  );
  const actions = node("div", undefined, "toolbar");
  if (j.state === "queued" || j.state === "running") {
    const b = node("button", "Cancel");
    b.type = "button";
    b.disabled = !vosu.canWrite;
    b.onclick = async () => {
      await api(`v1/jobs/${j.id}`, undefined, "DELETE").catch((e) =>
        notice(String(e)),
      );
      await refresh();
    };
    actions.append(b);
  }
  if (j.state === "done") {
    const b = node("button", j.imported_to ? "Import again" : "Import");
    b.type = "button";
    b.disabled = !vosu.canWrite;
    b.onclick = () => void importJob(j);
    actions.append(b);
    if (j.sha256) actions.append(node("small", `SHA-256 ${j.sha256}`, "hash"));
  }
  row.append(head, p, info, actions);
  if (j.imported_to) row.append(node("p", `Placed: ${j.imported_to}`));
  return row;
}
async function importJob(j: Job) {
  const client = el<HTMLSelectElement>("client").value;
  const songs = el<HTMLInputElement>("songs").value.trim();
  if (client === "stable" && !songs) {
    openPanel("import");
    notice("Enter the stable Songs folder under Import destination first.");
    return;
  }
  if (
    !confirm(
      client === "stable"
        ? `Place set #${j.set.id} as an .osz into exactly:\n${songs}\n\nNothing is overwritten; stable imports it on F5 or next start.`
        : `Open set #${j.set.id} with the system .osz handler? Choose lazer if prompted. This launches an external application.`,
    )
  )
    return;
  try {
    const v = await api<{ message: string; path?: string }>(
      `v1/import/${j.id}`,
      { client, songs_dir: songs || null },
    );
    notice(`${v.message} ${v.path ?? ""}`);
    await refresh();
  } catch (e) {
    notice(String(e));
  }
}
function showQueue(q: State["queue"]) {
  el("queue-status").textContent = q.paused ? "Paused" : "Running";
  const root = el("queue");
  const scroll = root.scrollTop;
  root.replaceChildren(...q.jobs.map(jobRow));
  if (!q.jobs.length)
    root.append(
      node(
        "p",
        "Nothing queued. Tick sets in the manifest and press “Queue selected”; nothing downloads until you resume.",
        "queue-empty",
      ),
    );
  root.scrollTop = scroll;
}
function showConfig(state: State) {
  config = state.config;
  const err = el("config-error");
  err.hidden = !state.config_error;
  err.textContent = state.config_error
    ? `Tool settings need attention: ${state.config_error}. Fix them in Settings; downloads wait until then.`
    : "";
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
    notice(String(e));
  } finally {
    refreshing = false;
  }
}

// ── Deep link: #md5=<32 hex> (e.g. from the replay renderer) ─────────
async function openLink() {
  const md5 = new URLSearchParams(location.hash.slice(1)).get("md5");
  if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) return;
  input("discovery").value = "ids";
  input("ids").value = md5.toLowerCase();
  openPanel("ids");
  updateBadges();
  notice(`Looking up the set for MD5 ${md5}…`);
  try {
    const v = await vosu
      .fetch(`v1/lookup/${md5}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? `Lookup failed (${r.status})`);
        return body;
      });
    showResults([v.beatmapset], 0, md5.toLowerCase());
    lastQuery = { ...readSearch(), discovery: "ids" };
    if (vosu.canWrite) {
      const check = el("results").querySelector<HTMLInputElement>(
        "input[type=checkbox]",
      );
      if (check) check.checked = true;
      notice(
        "Requested by link: this set contains that difficulty. Queue it when ready.",
      );
    } else {
      const p = el("link-note");
      const copy = node("button", "Copy MD5", "copy");
      copy.type = "button";
      copy.onclick = () =>
        void navigator.clipboard
          .writeText(md5)
          .then(() => (copy.textContent = "Copied"));
      p.replaceChildren(
        node("span", "Requested by link", "k"),
        node("span", md5, "data"),
        copy,
      );
      p.hidden = false;
      notice(
        "This tab is read-only. Open the Beatmap downloader from the vosu dashboard, then paste this MD5 into “IDs, links & packs” to download the set.",
      );
    }
  } catch (e) {
    notice(String(e));
  }
}

// ── Start ─────────────────────────────────────────────────────────────
await vosu.ready.catch((e) => notice(String(e)));
applyScheme();
const access = el("access");
access.dataset.state = vosu.canWrite ? "write" : "read";
access.textContent = vosu.canWrite ? "AUTHORIZED" : "READ-ONLY";
access.title = vosu.canWrite
  ? "Opened from the vosu dashboard: search, queue and import are enabled."
  : "Open this tool from the vosu dashboard to search, queue or import.";
document
  .querySelectorAll<HTMLButtonElement>(".write")
  .forEach((b) => (b.disabled ||= !vosu.canWrite));
const settingsLink = el<HTMLAnchorElement>("settings-link");
settingsLink.href = new URL(
  "/settings?tool=downloader",
  vosu.dashboardUrl,
).href;
updateBadges();
vosu.subscribe(POINTERS, onFrame);
await refresh();
await openLink();
setInterval(() => void refresh(), 1500);
