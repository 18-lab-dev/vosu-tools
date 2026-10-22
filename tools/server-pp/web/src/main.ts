import { vosu } from "/tools/_host/v1/bridge.js";
import "./style.css";

function applyScheme() {
  document.documentElement.dataset.scheme =
    vosu.colorScheme ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
applyScheme();

type Server = {
  id: string;
  kind: "builtin" | "custom";
  name?: string;
  version?: string | null;
  status?: "ready" | "disabled" | "error";
  error?: string;
  rulesets?: string[];
  md5?: string;
  path?: string;
  coverage?: string;
};
type Servers = {
  servers: Server[];
  calculators?: {
    folder: string;
    fuel: number;
    memory_bytes: number;
    settings_error: string | null;
    folder_error: string | null;
  };
};
type Result = {
  current: number;
  if_fc: number;
  stars: number;
  name?: string;
  breakdown?: Record<string, number | null>;
  official?: { available: boolean; result?: { pp?: number }; reason?: string };
};
type Row = { server: Server; result?: Result; error?: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = $<HTMLFormElement>("score");
const tbody = $("ledger").querySelector("tbody")!;
const note = $("ledger-note");

let servers: Server[] = [];
let generation = 0;
let timer: number | undefined;
const map = { checksum: "", artist: "", title: "", version: "", mode: "", state: -1 };
/** An .osu file opened in the tool instead of the game's selected map. */
let file: { name: string; bytes: ArrayBuffer } | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await vosu.fetch(path, init);
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

const pp = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function source(): "whatif" | "live" {
  return new FormData(form).get("source") === "live" ? "live" : "whatif";
}

/** The request for one calculator: live play, an opened file, or the selected map. */
function request(server: Server): [string, RequestInit?] {
  const data = new FormData(form);
  if (source() === "live") return [`v1/current?server=${encodeURIComponent(server.id)}`];
  const params = new URLSearchParams({ server: server.id });
  const mods = String(data.get("mods") ?? "").trim();
  if (mods) params.set("mods", mods);
  for (const key of ["acc", "misses", "combo", "mode"]) {
    const value = String(data.get(key) ?? "").trim();
    if (value) params.set(key, value);
  }
  if (file) return [`v1/calculate?${params}`, { method: "POST", body: file.bytes }];
  if (map.checksum) params.set("checksum", map.checksum);
  return [`v1/pp?${params}`];
}

async function calculate() {
  const run = ++generation;
  const rows: Row[] = servers
    .filter((server) => server.kind === "builtin" || server.status === "ready")
    .map((server) => ({ server }));
  if (!map.checksum && !(file && source() === "whatif")) {
    note.textContent = "Waiting for a map.";
    render([]);
    return;
  }
  note.textContent =
    source() === "live"
      ? map.state === 2
        ? "Live play: the score as it stands."
        : "Live play shows your score while you play; it is empty in song select."
      : file
        ? `What if: ${file.name} with the numbers above.`
        : "What if: the selected map with the numbers above.";
  tbody.setAttribute("aria-busy", "true");
  await Promise.all(
    rows.map(async (row) => {
      try {
        row.result = await api<Result>(...request(row.server));
      } catch (error) {
        // The selected map can change between the frame and the request.
        if (String(error).includes("checksum not cached")) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 300);
          await promise;
          try {
            row.result = await api<Result>(...request(row.server));
            return;
          } catch (retry) {
            error = retry;
          }
        }
        row.error = error instanceof Error ? error.message : String(error);
      }
    }),
  );
  if (run !== generation) return;
  tbody.removeAttribute("aria-busy");
  render(rows);
}

function schedule(delay = 150) {
  clearTimeout(timer);
  timer = window.setTimeout(() => void calculate(), delay);
}

function render(rows: Row[]) {
  $("ledger").hidden = rows.length === 0;
  $("empty").hidden = rows.length > 0;
  const official = rows
    .map((row) => row.result?.official)
    .find((o) => o?.available && typeof o.result?.pp === "number")?.result?.pp;
  const top = Math.max(
    official ?? 0,
    ...rows.map((row) => row.result?.current ?? 0),
  );
  const body: HTMLTableRowElement[] = [];
  const reference = el("tr", "reference");
  const name = el("th", "", "Official");
  name.scope = "row";
  name.append(el("span", "tag", "vosu"));
  reference.append(name, cell(official, top), el("td", "num", "—"), el("td", "num", "—"), el("td", "num", "—"), el("td", "fine", official === undefined ? "Unavailable" : "Reference for the deltas"));
  if (rows.length) body.push(reference);
  for (const row of rows) {
    const tr = el("tr", row.server.kind);
    const th = el("th", "", row.result?.name ?? row.server.name ?? row.server.id);
    th.scope = "row";
    th.append(el("span", "tag", row.server.kind === "builtin" ? "built-in" : row.server.id));
    tr.append(th);
    if (row.error || !row.result) {
      // A calculator that does not handle this ruleset is not a failure.
      const unsupported = row.error?.includes("does not support") ?? false;
      const td = el("td", unsupported ? "muted" : "error", row.error ?? "No result");
      td.colSpan = 5;
      tr.append(td);
    } else {
      const r = row.result;
      const delta =
        official && official > 0 ? ((r.current - official) / official) * 100 : undefined;
      const deltaCell = el("td", "num delta", delta === undefined ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`);
      tr.append(cell(r.current, top), el("td", "num", pp(r.if_fc)), deltaCell, el("td", "num", pp(r.stars)), breakdown(r.breakdown));
    }
    body.push(tr);
  }
  tbody.replaceChildren(...body);
}

function cell(value: number | undefined, top: number) {
  const td = el("td", "num amount", pp(value));
  if (value !== undefined && top > 0)
    td.style.setProperty("--share", String(Math.min(1, value / top)));
  return td;
}

function breakdown(values: Record<string, number | null> | undefined) {
  const td = el("td", "breakdown");
  for (const [label, value] of Object.entries(values ?? {})) {
    const item = el("span", "item");
    item.append(el("span", "label", label.replaceAll("_", " ")), el("span", "value", pp(value)));
    td.append(item);
  }
  if (!td.childElementCount) td.textContent = "—";
  return td;
}

function renderModules(data: Servers) {
  const list = $("modules");
  const items = data.servers.map((server) => {
    const li = el("li", `module ${server.kind} ${server.status ?? "ready"}`);
    const head = el("div", "module-head");
    head.append(
      el("span", "module-name", server.name ?? server.id),
      el("span", "state", server.kind === "builtin" ? "built-in" : (server.status ?? "")),
    );
    li.append(head);
    const meta = [server.id];
    if (server.version) meta.push(server.kind === "builtin" ? server.version.slice(0, 10) : `v${server.version}`);
    if (server.rulesets?.length) meta.push(server.rulesets.join(" · "));
    li.append(el("p", "meta", meta.join("  ·  ")));
    if (server.error) li.append(el("p", "error", server.error));
    if (server.kind === "custom" && server.path) li.append(el("p", "path", server.path));
    return li;
  });
  if (!data.servers.some((server) => server.kind === "custom")) {
    const li = el("li", "guide");
    li.append(
      el("strong", "", "No custom calculators yet."),
      el("p", "", "Drop a .wasm calculator into the folder below and it appears here within a second. The tool's CALCULATORS.md describes the format, with Rust and AssemblyScript examples."),
    );
    items.push(li);
  }
  list.replaceChildren(...items);
  const config = data.calculators;
  const footer = $("config");
  footer.replaceChildren();
  if (config) {
    footer.append(el("span", "label", "Folder"), el("span", "path", config.folder));
    footer.append(
      el("span", "label", "Limits"),
      el("span", "", `${(config.fuel / 1e6).toLocaleString()} M fuel · ${Math.round(config.memory_bytes / 1048576)} MiB per call`),
    );
    for (const problem of [config.settings_error, config.folder_error])
      if (problem) footer.append(el("span", "label", "Problem"), el("span", "error", problem));
  }
}

let serversKey = "";
async function refreshServers() {
  try {
    const data = await api<Servers>("v1/servers");
    servers = data.servers;
    renderModules(data);
    const key = servers.map((s) => `${s.id}:${s.status}:${s.md5}`).join("|");
    if (key !== serversKey) {
      serversKey = key;
      schedule(0);
    }
  } catch (error) {
    $("modules").replaceChildren(el("li", "error", `Service unavailable: ${String(error)}`));
  }
}

function showMap() {
  const label = file
    ? `${file.name} · opened file`
    : map.checksum
      ? `${map.artist} – ${map.title} [${map.version}]${map.mode ? ` · ${map.mode}` : ""}`
      : "No map selected in osu!";
  const node = $("map");
  node.textContent = label;
  node.title = label;
}

const FIELDS = [
  "/beatmap/checksum",
  "/beatmap/artist",
  "/beatmap/title",
  "/beatmap/version",
  "/beatmap/mode/name",
  "/state/number",
  "/play/combo/current",
  "/play/hits/0",
  "/play/hits/300",
  "/play/hits/100",
];
const values: unknown[] = [];
let lastPlay = "";
function onFrame(frame: unknown) {
  if (!Array.isArray(frame) || (frame[0] !== 0 && frame[0] !== 1)) return;
  if (frame[0] === 0) values.length = 0;
  if (Array.isArray(frame[2]))
    for (const change of frame[2])
      if (Array.isArray(change) && typeof change[0] === "number") values[change[0]] = change[1];
  if (Array.isArray(frame[3]))
    for (const index of frame[3]) if (typeof index === "number") delete values[index];
  const text = (i: number) => (typeof values[i] === "string" ? (values[i] as string) : "");
  const previous = map.checksum;
  Object.assign(map, {
    checksum: text(0),
    artist: text(1),
    title: text(2),
    version: text(3),
    mode: text(4),
    state: Number(values[5] ?? -1),
  });
  showMap();
  const play = values.slice(5, 10).join(",");
  if (map.checksum !== previous) schedule();
  else if (source() === "live" && play !== lastPlay) schedule(400);
  lastPlay = play;
}

form.addEventListener("input", () => schedule(250));
form.addEventListener("submit", (event) => event.preventDefault());

const picker = $<HTMLInputElement>("file");
const clear = $<HTMLButtonElement>("clear-file");
picker.addEventListener("change", async () => {
  const chosen = picker.files?.[0];
  picker.value = "";
  if (!chosen) return;
  if (chosen.size > 1024 * 1024) {
    note.textContent = `${chosen.name} is larger than the 1 MiB .osu limit.`;
    return;
  }
  file = { name: chosen.name, bytes: await chosen.arrayBuffer() };
  clear.hidden = false;
  showMap();
  schedule(0);
});
clear.addEventListener("click", () => {
  file = null;
  clear.hidden = true;
  showMap();
  schedule(0);
});

await vosu.ready.catch(() => undefined);
applyScheme();
// Opened files are uploaded through the write route, so only a tab opened
// from the dashboard can use them.
picker.disabled = !vosu.canWrite;
$("empty-file").hidden = !vosu.canWrite;
$("open-label").title = vosu.canWrite
  ? "Score an .osu file instead of the selected map"
  : "Open this tool from the vosu dashboard to score your own .osu files";
$<HTMLAnchorElement>("settings-link").href = new URL(
  "/settings?tool=server-pp",
  vosu.dashboardUrl,
).href;
vosu.subscribe(FIELDS, onFrame, (state) => {
  const live = $("live");
  live.hidden = false;
  live.dataset.state = state;
  live.textContent = state === "open" ? "Live" : state === "connecting" ? "Reconnecting…" : "Offline";
});
await refreshServers();
setInterval(() => {
  if (document.visibilityState === "visible") void refreshServers();
}, 2000);
