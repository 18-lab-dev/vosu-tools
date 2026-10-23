import type { Fetcher } from "./studio";

/** One replay offered by `GET /v1/replays`. */
export interface ReplayEntry {
  source: "stable" | "lazer-export" | "lazer-score";
  id: string | number;
  name: string | null;
  player: string;
  md5: string;
  mode: number | string;
  score: number | null;
  mods: number | string | null;
  date: number | string | null;
}
interface Listing {
  replays: ReplayEntry[];
  sources: { source: string; folder: string }[];
  lazer: string;
  lazer_scores: string | null;
}
/** The beatmap open in the game, from the selected-field subscription. */
export interface NowPlaying {
  md5: string;
  artist: string;
  title: string;
  version: string;
}

/** State of the bridge's game subscription. */
export type LinkState = "connecting" | "open" | "closed";

const SOURCE_LABEL: Record<ReplayEntry["source"], string> = {
  stable: "stable",
  "lazer-export": "lazer",
  "lazer-score": "lazer score",
};
const MODES = ["osu!", "taiko", "catch", "mania"];
const LAZER_MODES: Record<string, string> = {
  osu: "osu!",
  taiko: "taiko",
  fruits: "catch",
  mania: "mania",
};

/** Lists local replays (this map or all) and follows the game's beatmap. */
export class ReplayLibrary {
  private tab: "map" | "all" = "map";
  private now: NowPlaying | null = null;
  private entries: ReplayEntry[] = [];
  private loading = 0;
  constructor(
    private view: {
      /** `<tbody>` of the replay table. */
      list: HTMLElement;
      /** Scroll region holding the table; its title lists the folders read. */
      region: HTMLElement;
      filter: HTMLInputElement;
      mapTab: HTMLButtonElement;
      allTab: HTMLButtonElement;
      now: HTMLElement;
    },
    private fetcher: Fetcher,
    private add: (entry: ReplayEntry) => Promise<void>,
    private report: (error: unknown) => void,
  ) {
    view.mapTab.onclick = () => this.show("map");
    view.allTab.onclick = () => this.show("all");
    view.filter.oninput = () => this.render();
    for (const tab of [view.mapTab, view.allTab])
      tab.onkeydown = (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const next = this.tab === "map" ? view.allTab : view.mapTab;
          next.click();
          next.focus();
        }
      };
  }
  /** Follows the game's beatmap. Selected-field frames are
   *  `[0|1, revision, [[index, value], …], removed?]`; the bridge reconnects
   *  after vosu restarts and reports the link through `onStatus`. */
  follow(
    subscribe: (
      fields: readonly `/${string}`[],
      onFrame: (frame: unknown) => void,
      onStatus?: (state: LinkState) => void,
    ) => () => void,
    onStatus: (state: LinkState) => void,
  ) {
    const fields: `/${string}`[] = ["/beatmap/checksum", "/beatmap/artist", "/beatmap/title", "/beatmap/version"];
    const values: unknown[] = [];
    subscribe(fields, (frame) => {
      if (!Array.isArray(frame) || (frame[0] !== 0 && frame[0] !== 1)) return;
      if (frame[0] === 0) values.length = 0;
      for (const [index, value] of (frame[2] ?? []) as [number, unknown][])
        values[index] = value;
      for (const index of (frame[3] ?? []) as number[]) values[index] = undefined;
      const md5 = typeof values[0] === "string" ? values[0].toLowerCase() : "";
      const next = /^[0-9a-f]{32}$/.test(md5)
        ? {
            md5,
            artist: String(values[1] ?? ""),
            title: String(values[2] ?? ""),
            version: String(values[3] ?? ""),
          }
        : null;
      if (next?.md5 === this.now?.md5) return;
      this.now = next;
      this.view.now.hidden = !next;
      this.view.now.textContent = next
        ? `${next.artist} – ${next.title} [${next.version}]`
        : "";
      if (this.tab === "map") void this.refresh();
    }, onStatus);
  }
  show(tab: "map" | "all") {
    this.tab = tab;
    this.view.mapTab.setAttribute("aria-selected", String(tab === "map"));
    this.view.allTab.setAttribute("aria-selected", String(tab === "all"));
    this.view.mapTab.tabIndex = tab === "map" ? 0 : -1;
    this.view.allTab.tabIndex = tab === "all" ? 0 : -1;
    void this.refresh();
  }
  /** One short line in place of the rows. */
  message(text: string) {
    this.entries = [];
    this.render(text);
  }
  async refresh() {
    const ticket = ++this.loading;
    if (this.tab === "map" && !this.now) {
      this.message("No map open in osu!.");
      return;
    }
    this.view.region.setAttribute("aria-busy", "true");
    try {
      const query = this.tab === "map" ? `?md5=${this.now!.md5}` : "";
      const listing = (await (await this.fetcher(`v1/replays${query}`)).json()) as Listing;
      if (ticket !== this.loading) return;
      this.entries = listing.replays;
      const places = listing.sources.map(
        (s) => `${SOURCE_LABEL[s.source as ReplayEntry["source"]] ?? s.source}: ${s.folder}`,
      );
      if (this.tab === "map" && listing.lazer_scores && listing.lazer_scores !== "available")
        places.push(`lazer scores: ${listing.lazer_scores}`);
      this.view.region.title = places.join("\n") || listing.lazer;
      this.render(
        !listing.sources.length && !listing.replays.length
          ? "No replay folders found."
          : this.tab === "map"
            ? "No replays of this map."
            : "No replays found.",
      );
    } catch (error) {
      if (ticket === this.loading) this.report(error);
    } finally {
      if (ticket === this.loading) this.view.region.removeAttribute("aria-busy");
    }
  }
  private render(empty = "") {
    const filter = this.view.filter.value.trim().toLowerCase();
    const shown = this.entries.filter(
      (e) =>
        !filter ||
        e.player.toLowerCase().includes(filter) ||
        (e.name ?? "").toLowerCase().includes(filter),
    );
    if (!shown.length) {
      const row = document.createElement("tr"),
        cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "v-empty";
      cell.textContent = this.entries.length ? "No matches." : empty;
      row.append(cell);
      this.view.list.replaceChildren(row);
      return;
    }
    this.view.list.replaceChildren(
      ...shown.map((entry) => {
        const row = document.createElement("tr");
        if (entry.name) row.title = entry.name;
        const player = document.createElement("td");
        const name = document.createElement("span");
        name.className = "replay-player";
        const who = document.createElement("span");
        who.textContent = entry.player || "Unknown";
        const mode = document.createElement("span");
        mode.className = "v-muted";
        mode.textContent =
          typeof entry.mode === "number" ? MODES[entry.mode] : LAZER_MODES[entry.mode] ?? String(entry.mode);
        const badge = document.createElement("span");
        badge.className = `v-badge${entry.source === "stable" ? "" : " v-badge--accent"}`;
        badge.textContent = SOURCE_LABEL[entry.source];
        name.append(who, mode, badge);
        const detail = document.createElement("span");
        detail.className = "replay-map v-muted";
        detail.textContent = [when(entry.date), this.tab === "all" ? entry.name : ""]
          .filter(Boolean)
          .join(" · ");
        player.append(name, detail);
        const score = document.createElement("td");
        score.className = "v-num";
        score.textContent = entry.score != null ? Number(entry.score).toLocaleString() : "";
        const action = document.createElement("td");
        const add = document.createElement("button");
        add.type = "button";
        add.className = "v-btn v-btn--sm";
        add.textContent = "Add";
        add.setAttribute("aria-label", `Add ${entry.player}'s replay`);
        add.onclick = async () => {
          add.disabled = true;
          try {
            await this.add(entry);
          } finally {
            add.disabled = false;
          }
        };
        action.append(add);
        row.append(player, score, action);
        return row;
      }),
    );
  }
}

function when(date: ReplayEntry["date"]) {
  if (date == null || date === 0) return "";
  const time = typeof date === "number" ? date : Date.parse(date);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}

/** A replay whose beatmap is not installed: its MD5, where we looked, and ways to find it. */
export function showMissingMap(
  panel: HTMLElement,
  details: { md5: string; searched: string[] },
  downloader: boolean,
) {
  const title = document.createElement("span");
  title.className = "v-title";
  title.textContent = "Map not installed";
  const code = document.createElement("code");
  code.className = "v-mono";
  code.textContent = details.md5;
  const searched = document.createElement("ul");
  searched.className = "v-muted";
  for (const place of details.searched) {
    const item = document.createElement("li");
    item.textContent = place;
    searched.append(item);
  }
  const actions = document.createElement("div");
  actions.className = "v-row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "v-btn v-btn--sm";
  copy.textContent = "Copy MD5";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(details.md5);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
  };
  actions.append(copy);
  if (downloader) {
    const find = document.createElement("a");
    find.className = "v-btn v-btn--sm v-btn--primary";
    find.href = `/tools/downloader/#md5=${details.md5}`;
    find.target = "_blank";
    find.rel = "noopener";
    find.textContent = "Find in downloader";
    actions.append(find);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "v-btn v-btn--sm v-btn--ghost";
  close.textContent = "Dismiss";
  close.onclick = () => {
    panel.hidden = true;
  };
  actions.append(close);
  const head = document.createElement("div");
  head.className = "v-row";
  head.append(title, code);
  panel.replaceChildren(head, searched, actions);
  panel.hidden = false;
}
