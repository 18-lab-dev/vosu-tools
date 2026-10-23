import { vosu } from "/tools/_host/v1/bridge.js";
import "./style.css";

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
const table = $<HTMLTableElement>("ledger");
const tbody = table.querySelector("tbody")!;
const empty = $("empty");

let servers: Server[] = [];
let source: "whatif" | "live" = "whatif";
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

/** The request for one calculator: live play, an opened file, or the selected map. */
function request(server: Server): [string, RequestInit?] {
  const data = new FormData(form);
  if (source === "live") return [`v1/current?server=${encodeURIComponent(server.id)}`];
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

function showEmpty(text: string) {
  table.hidden = true;
  empty.hidden = false;
  empty.textContent = text;
}

async function calculate() {
  const run = ++generation;
  const rows: Row[] = servers
    .filter((server) => server.kind === "builtin" || server.status === "ready")
    .map((server) => ({ server }));
  if (source === "live" && map.state !== 2) return showEmpty("Not playing.");
  if (!map.checksum && !(file && source === "whatif")) return showEmpty("No map selected.");
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

function nameCell(name: string, tag: string) {
  const th = el("th", "name", name);
  th.scope = "row";
  th.append(el("span", "tag v-mono v-muted", tag));
  return th;
}

function render(rows: Row[]) {
  table.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = "No calculators.";
  const official = rows
    .map((row) => row.result?.official)
    .find((o) => o?.available && typeof o.result?.pp === "number")?.result?.pp;
  const reference = el("tr", "reference");
  reference.append(
    nameCell("Official", "vosu"),
    el("td", "v-num", pp(official)),
    el("td", "v-num", "—"),
    el("td", "v-num", "—"),
    el("td", "v-num", "—"),
    el("td", "v-muted", "—"),
  );
  const body = [reference];
  for (const row of rows) {
    const tr = el("tr");
    tr.append(
      nameCell(row.result?.name ?? row.server.name ?? row.server.id, row.server.kind === "builtin" ? "built-in" : row.server.id),
    );
    if (row.error || !row.result) {
      // A calculator that does not handle this ruleset is not a failure.
      const unsupported = row.error?.includes("does not support") ?? false;
      const td = el("td", unsupported ? "v-muted" : "error", row.error ?? "No result");
      td.colSpan = 5;
      tr.append(td);
    } else {
      const r = row.result;
      const delta =
        official && official > 0 ? ((r.current - official) / official) * 100 : undefined;
      tr.append(
        el("td", "v-num", pp(r.current)),
        el("td", "v-num", pp(r.if_fc)),
        el(
          "td",
          "v-num v-muted",
          delta === undefined ? "—" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`,
        ),
        el("td", "v-num", pp(r.stars)),
        breakdown(r.breakdown),
      );
    }
    body.push(tr);
  }
  tbody.replaceChildren(...body);
}

function breakdown(values: Record<string, number | null> | undefined) {
  const td = el("td", "breakdown");
  for (const [label, value] of Object.entries(values ?? {})) {
    const item = el("span", "item");
    item.append(el("span", "v-muted", label.replaceAll("_", " ")), el("span", "v-mono", pp(value)));
    td.append(item);
  }
  if (!td.childElementCount) {
    td.textContent = "—";
    td.classList.add("v-muted");
  }
  return td;
}

const STATE_BADGE: Record<string, string> = {
  ready: "v-badge--ok",
  disabled: "",
  error: "v-badge--error",
};

function renderModules(data: Servers) {
  const custom = data.servers.filter((server) => server.kind === "custom");
  $("module-count").textContent = String(data.servers.length);
  const items = data.servers.map((server) => {
    const li = el("li", `module ${server.status ?? "ready"}`);
    const head = el("div", "module__head");
    const state = server.kind === "builtin" ? "built-in" : (server.status ?? "");
    head.append(
      el("span", "module__name", server.name ?? server.id),
      el("span", `v-badge ${STATE_BADGE[state] ?? ""}`, state),
    );
    li.append(head);
    const meta = [server.id];
    if (server.version)
      meta.push(server.kind === "builtin" ? server.version.slice(0, 10) : `v${server.version}`);
    if (server.rulesets?.length) meta.push(server.rulesets.join(" "));
    li.append(el("span", "module__meta v-mono v-muted", meta.join(" · ")));
    if (server.error) li.append(el("span", "module__error", server.error));
    if (server.kind === "custom" && server.path)
      li.append(el("span", "module__path v-mono v-muted", server.path));
    return li;
  });
  if (!custom.length) items.push(el("li", "v-empty", "No custom calculators."));
  $("modules").replaceChildren(...items);
  const config = data.calculators;
  const facts: HTMLElement[] = [];
  if (config) {
    facts.push(el("dt", "", "Folder"), el("dd", "v-mono", config.folder));
    facts.push(
      el("dt", "", "Limits"),
      el(
        "dd",
        "v-mono",
        `${(config.fuel / 1e6).toLocaleString()}M fuel · ${Math.round(config.memory_bytes / 1048576)} MiB`,
      ),
    );
    for (const problem of [config.settings_error, config.folder_error])
      if (problem) facts.push(el("dt", "", "Error"), el("dd", "module__error", problem));
  }
  $("config").replaceChildren(...facts);
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
    $("modules").replaceChildren(el("li", "module__error", `Service unavailable: ${String(error)}`));
  }
}

function showMap() {
  const label = file
    ? file.name
    : map.checksum
      ? `${map.artist} – ${map.title} [${map.version}]`
      : "No map selected";
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
] as const;
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
  const previousState = map.state;
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
  if (map.checksum !== previous || map.state !== previousState) schedule();
  else if (source === "live" && play !== lastPlay) schedule(400);
  lastPlay = play;
}

const segment = form.querySelector(".v-seg")!;
segment.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-source]");
  if (!button) return;
  source = button.dataset.source === "live" ? "live" : "whatif";
  for (const b of segment.querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b === button));
  schedule(0);
});
form.addEventListener("input", () => schedule(250));
form.addEventListener("submit", (event) => event.preventDefault());

const picker = $<HTMLInputElement>("file");
const clear = $<HTMLButtonElement>("clear-file");
picker.addEventListener("change", async () => {
  const chosen = picker.files?.[0];
  picker.value = "";
  if (!chosen) return;
  if (chosen.size > 1024 * 1024) {
    showEmpty("File is larger than 1 MiB.");
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
// Opened files are uploaded through the write route, so only a tab opened
// from the dashboard can use them.
picker.disabled = !vosu.canWrite;
const openLabel = $("open-label");
openLabel.toggleAttribute("aria-disabled", !vosu.canWrite);
if (!vosu.canWrite) openLabel.title = "Open from the dashboard to use files";
$<HTMLAnchorElement>("settings-link").href = new URL(
  "/settings?tool=server-pp",
  vosu.dashboardUrl,
).href;
vosu.subscribe(FIELDS, onFrame, (state) => {
  $("live-dot").dataset.state = state === "open" ? "ok" : state === "connecting" ? "busy" : "error";
  $("live").textContent =
    state === "open" ? "Live" : state === "connecting" ? "Connecting" : "Offline";
});
await refreshServers();
setInterval(() => {
  if (document.visibilityState === "visible") void refreshServers();
}, 2000);
