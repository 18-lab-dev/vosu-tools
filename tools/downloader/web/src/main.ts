import { vosu } from "/tools/_host/v1/bridge.js";
import "./style.css";
type Mapset = {
  id: number;
  artist: string;
  title: string;
  creator: string;
  status: string;
  owned: boolean;
  beatmaps: {
    difficulty_rating: number;
    version: string;
    mode_int: number;
    total_length: number;
  }[];
};
type Search = Record<string, unknown>;
type Source = { name: string; enabled: boolean; priority: number };
type Settings = {
  sources: Source[];
  concurrency: number;
  max_file_mb: number;
  saved_searches: Record<string, Search>;
  presets: Record<string, Search>;
  credentials_configured: boolean;
};
type Job = {
  id: string;
  set: Mapset;
  state: string;
  progress: number;
  message: string;
  bytes: number;
  total: number | null;
  result: string | null;
  sha256: string | null;
  imported_to: string | null;
};
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const searchForm = el<HTMLFormElement>("search");
const settingsForm = el<HTMLFormElement>("settings");
let config: Settings;
let results: Mapset[] = [];
let cursor: string | null = null;
let activeSearch: string | null = null;
let lastQuery: Search = {};
let refreshing = false;
const notice = (s: string) => {
  el("notice").textContent = s;
};
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<any> {
  const r = await vosu.fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? `Request failed (${r.status})`);
  return v;
}
function writeAccess() {
  document
    .querySelectorAll<HTMLButtonElement>(".write")
    .forEach((b) => (b.disabled = !vosu.canWrite));
}
function input(form: HTMLFormElement, name: string) {
  return form.elements.namedItem(name) as
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}
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
  q.hide_owned = (input(searchForm, "hide_owned") as HTMLInputElement).checked;
  return q;
}
function applySearch(q: Search, filtersOnly = false) {
  for (const [key, value] of Object.entries(q)) {
    if (
      filtersOnly &&
      ["query", "discovery", "provider", "ids", "pack", "cursor"].includes(key)
    )
      continue;
    const field = searchForm.elements.namedItem(key);
    if (field instanceof HTMLInputElement && field.type === "checkbox")
      field.checked = Boolean(value);
    else if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement ||
      field instanceof HTMLTextAreaElement
    )
      field.value = value == null ? "" : String(value);
  }
}
async function pollJob(id: string) {
  for (;;) {
    const j = await api(`v1/jobs/${id}`);
    if (j.state === "done") return j.result;
    if (j.state === "failed" || j.state === "cancelled")
      throw new Error(j.message);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 650);
    await promise;
  }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function showResults(sets: Mapset[]) {
  results = sets;
  const root = el("results");
  root.replaceChildren();
  el("result-count").textContent =
    `${sets.length.toString().padStart(2, "0")} SETS`;
  for (const s of sets) {
    const row = node("article");
    row.className = "map";
    const check = node("input");
    check.type = "checkbox";
    check.value = String(s.id);
    check.setAttribute("aria-label", `Select ${s.title}`);
    const content = node("div");
    const title = node("a", `${s.artist} — ${s.title}`);
    title.href = `https://osu.ppy.sh/beatmapsets/${s.id}`;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    const meta = node(
      "p",
      `${s.creator} / ${s.status.toUpperCase()} / #${s.id}${s.owned ? " / OWNED" : ""}`,
    );
    meta.className = "mono";
    content.append(title, meta);
    const diffs = node("div");
    diffs.className = "diffs";
    for (const d of s.beatmaps) {
      const modes = ["osu!", "taiko", "catch", "mania"];
      diffs.append(
        node(
          "span",
          `${d.difficulty_rating.toFixed(2)}★ ${modes[d.mode_int] ?? "?"} · ${d.version} · ${d.total_length}s`,
        ),
      );
    }
    content.append(diffs);
    row.append(check, content);
    root.append(row);
  }
  if (!sets.length)
    root.append(
      node(
        "p",
        "No matching sets on this page. Try another page or relax filters.",
      ),
    );
}
function showPacks(v: any) {
  const root = el("results");
  root.replaceChildren();
  for (const p of v.beatmap_packs ?? []) {
    const row = node("article");
    row.className = "map";
    const b = node("button", `${p.tag} / ${p.name}`);
    b.disabled = !vosu.canWrite;
    b.onclick = () => {
      input(searchForm, "pack").value = p.tag;
      input(searchForm, "provider").value = "official";
      searchForm.requestSubmit();
    };
    row.append(b, node("p", `${p.date ?? ""} · ${p.author ?? ""}`));
    root.append(row);
  }
  el("result-count").textContent = "OFFICIAL PACKS";
}
async function runSearch(q: Search) {
  el<HTMLButtonElement>("cancel-search").disabled = false;
  try {
    notice("Searching… requests are paced and cached.");
    lastQuery = q;
    const r = await api("v1/search", q);
    activeSearch = r.job;
    const v = await pollJob(r.job);
    if (v.beatmap_packs) {
      results = [];
      showPacks(v);
      notice(
        "Choose a pack to inspect its sets. Official credentials required.",
      );
    } else {
      showResults(v.beatmapsets ?? []);
      cursor = v.cursor_string ?? null;
      el<HTMLButtonElement>("next-page").disabled = !vosu.canWrite;
      notice(
        [...(v.notices ?? []), v.filter_scope ?? ""].join(" ") ||
          "Search complete.",
      );
    }
  } catch (e) {
    notice(String(e));
  } finally {
    activeSearch = null;
    el<HTMLButtonElement>("cancel-search").disabled = true;
  }
}
searchForm.onsubmit = (e) => {
  e.preventDefault();
  void runSearch(readSearch());
};
el("next-page").onclick = () => {
  const q = {
    ...lastQuery,
    offset: Number(lastQuery.offset ?? 0) + Number(lastQuery.limit ?? 20),
    cursor: cursor ?? "",
  };
  input(searchForm, "offset").value = String(q.offset);
  void runSearch(q);
};
el("cancel-search").onclick = () => {
  if (activeSearch)
    void api(`v1/jobs/${activeSearch}`, undefined, "DELETE").catch((e) =>
      notice(String(e)),
    );
};
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
    await api("v1/queue", {
      sets: results.filter((s) => chosen.has(s.id)),
      source: el<HTMLSelectElement>("download-source").value,
      no_video: el<HTMLInputElement>("no-video").checked,
    });
    notice(
      "Selected sets queued. Resume when ready; queue starts paused and restart always pauses.",
    );
    await refresh();
  } catch (e) {
    notice(String(e));
  }
};
el("library").onclick = async () => {
  try {
    notice("Copying and parsing read-only stable database snapshots…");
    const j = await api("v1/library", {});
    const v = await pollJob(j.job);
    const songs = v.context?.songs_dir;
    if (songs && !el<HTMLInputElement>("songs").value)
      el<HTMLInputElement>("songs").value = songs;
    notice((v.warnings ?? []).join(" ") || "Library snapshot refreshed.");
    await refresh();
  } catch (e) {
    notice(String(e));
  }
};
document.querySelectorAll<HTMLButtonElement>("[data-control]").forEach(
  (b) =>
    (b.onclick = async () => {
      try {
        await api("v1/queue/control", { action: b.dataset.control });
        await refresh();
      } catch (e) {
        notice(String(e));
      }
    }),
);
async function saveNamed(kind: "saved_searches" | "presets") {
  const name = prompt(
    kind === "presets" ? "Name this filter preset" : "Name this search",
  );
  if (!name?.trim()) return;
  try {
    const next = {
      ...config,
      [kind]: { ...config[kind], [name.trim()]: readSearch() },
    };
    await api("v1/settings", next);
    await refresh(true);
  } catch (e) {
    notice(String(e));
  }
}
el("save-search").onclick = () => void saveNamed("saved_searches");
el("save-preset").onclick = () => void saveNamed("presets");
el<HTMLSelectElement>("saved").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (config.saved_searches[name]) applySearch(config.saved_searches[name]);
};
el<HTMLSelectElement>("presets").onchange = (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (config.presets[name]) applySearch(config.presets[name], true);
};
settingsForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const s = {
      ...config,
      concurrency: Number(input(settingsForm, "concurrency").value),
      max_file_mb: Number(input(settingsForm, "max_file_mb").value),
      client_id: input(settingsForm, "client_id").value,
      client_secret: input(settingsForm, "client_secret").value,
      sources: JSON.parse(input(settingsForm, "sources").value),
    };
    await api("v1/settings", s);
    input(settingsForm, "client_id").value = "";
    input(settingsForm, "client_secret").value = "";
    notice("Settings saved. Credentials never read back.");
    await refresh(true);
  } catch (e) {
    notice(String(e));
  }
};
function options(id: string, values: string[]) {
  const s = el<HTMLSelectElement>(id);
  const old = s.value;
  s.replaceChildren(
    node(
      "option",
      id === "saved" ? "Choose a saved search" : "Choose a preset",
    ),
  );
  s.options[0].value = "";
  for (const value of values) {
    const o = node("option", value);
    o.value = value;
    s.append(o);
  }
  s.value = old;
}
async function refresh(fill = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const v = await api("v1/state");
    config = v.settings;
    el("queue-status").textContent = v.queue.paused ? "PAUSED" : "RUNNING";
    el("library-state").textContent =
      `${v.library.maps.toLocaleString()} maps / ${v.library.scores.toLocaleString()} plays / ${v.library.collections.length} collections`;
    if (fill) {
      input(settingsForm, "concurrency").value = String(config.concurrency);
      input(settingsForm, "max_file_mb").value = String(config.max_file_mb);
      input(settingsForm, "sources").value = JSON.stringify(
        config.sources,
        null,
        2,
      );
      el("credential-state").textContent = config.credentials_configured
        ? "osu! API credentials configured (not returned to browser)."
        : "No osu! API credentials saved. Mirror search does not need them.";
      options("saved", Object.keys(config.saved_searches));
      options("presets", Object.keys(config.presets));
      const sources = el<HTMLSelectElement>("download-source");
      sources.replaceChildren();
      for (const s of config.sources
        .filter((s) => s.enabled)
        .sort((a, b) => a.priority - b.priority)) {
        const o = node("option", s.name);
        o.value = s.name;
        sources.append(o);
      }
    }
    const root = el("queue");
    root.replaceChildren();
    for (const j of v.queue.jobs as Job[]) {
      const row = node("article");
      row.className = "queue-job";
      const head = node("div");
      head.className = "section-head";
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
      const actions = node("div");
      actions.className = "toolbar";
      if (j.state === "queued" || j.state === "running") {
        const b = node("button", "Cancel");
        b.disabled = !vosu.canWrite;
        b.onclick = async () => {
          await api(`v1/jobs/${j.id}`, undefined, "DELETE");
          await refresh();
        };
        actions.append(b);
      }
      if (j.state === "done") {
        const b = node(
          "button",
          j.imported_to ? "Import another copy" : "Import archive",
        );
        b.disabled = !vosu.canWrite;
        b.onclick = async () => {
          const client = el<HTMLSelectElement>("client").value;
          const songs = el<HTMLInputElement>("songs").value;
          if (
            !confirm(
              client === "stable"
                ? `Place set #${j.set.id} as an .osz into exactly:\n${songs}\n\nNo overwrite; stable imports on F5 / next start.`
                : `Open set #${j.set.id} with the OS .osz handler? Choose lazer if prompted. This launches an external application.`,
            )
          )
            return;
          try {
            const v = await api(`v1/import/${j.id}`, {
              client,
              songs_dir: songs || null,
            });
            notice(`${v.message} ${v.path ?? ""}`);
            await refresh();
          } catch (e) {
            notice(String(e));
          }
        };
        actions.append(b);
        if (j.sha256) {
          const hash = node("small", `SHA-256 ${j.sha256}`);
          hash.className = "hash";
          actions.append(hash);
        }
      }
      row.append(head, p, info, actions);
      if (j.imported_to) row.append(node("p", `Placed: ${j.imported_to}`));
      root.append(row);
    }
    if (!v.queue.jobs.length)
      root.append(
        node(
          "p",
          "No downloads queued. Selected sets are never downloaded automatically.",
        ),
      );
  } catch (e) {
    notice(String(e));
  } finally {
    refreshing = false;
  }
}
await vosu.ready;
el("access").textContent = vosu.canWrite
  ? "AUTHORIZED WORKSPACE"
  : "READ-ONLY · Open this tool from the vosu dashboard to search, queue or import.";
writeAccess();
await refresh(true);
setInterval(() => void refresh(), 1500);
