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
  "lazer-export": "lazer export",
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
      list: HTMLElement;
      filter: HTMLInputElement;
      sources: HTMLElement;
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
      fields: unknown,
      onFrame: (frame: unknown) => void,
      onStatus?: (state: LinkState) => void,
    ) => () => void,
    onStatus: (state: LinkState) => void,
  ) {
    const fields = ["/beatmap/checksum", "/beatmap/artist", "/beatmap/title", "/beatmap/version"];
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
        ? `Now: ${next.artist} – ${next.title} [${next.version}]`
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
  async refresh() {
    const ticket = ++this.loading;
    if (this.tab === "map" && !this.now) {
      this.entries = [];
      this.render(
        "No map is open in osu!. Pick a beatmap in the game, or switch to All.",
      );
      return;
    }
    this.view.list.setAttribute("aria-busy", "true");
    try {
      const query = this.tab === "map" ? `?md5=${this.now!.md5}` : "";
      const listing = (await (await this.fetcher(`v1/replays${query}`)).json()) as Listing;
      if (ticket !== this.loading) return;
      this.entries = listing.replays;
      const folders = listing.sources.map((s) => `${SOURCE_LABEL[s.source as ReplayEntry["source"]] ?? s.source}: ${s.folder}`);
      const scores =
        this.tab === "map" && listing.lazer_scores !== "available" && listing.lazer_scores
          ? [`lazer scores: ${listing.lazer_scores}`]
          : [];
      this.view.sources.textContent = folders.length || scores.length
        ? `Reading ${[...folders, ...scores].join(" · ")}`
        : `No replay folders found. ${listing.lazer}.`;
      this.render(
        this.tab === "map"
          ? "No local replays of this map yet. Play it, or export a replay from lazer's results screen."
          : "No replays found in stable's Replays or lazer's exports folder.",
      );
    } catch (error) {
      if (ticket === this.loading) this.report(error);
    } finally {
      if (ticket === this.loading) this.view.list.removeAttribute("aria-busy");
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
      const note = document.createElement("li");
      note.className = "list-empty";
      note.textContent = this.entries.length ? "No replays match the filter." : empty;
      this.view.list.replaceChildren(note);
      return;
    }
    this.view.list.replaceChildren(
      ...shown.map((entry) => {
        const item = document.createElement("li");
        item.className = "replay";
        const text = document.createElement("div");
        const top = document.createElement("p");
        const player = document.createElement("strong");
        player.textContent = entry.player || "Unknown player";
        const source = document.createElement("span");
        source.className = `chip ${entry.source}`;
        source.textContent = SOURCE_LABEL[entry.source];
        top.append(player, source);
        const detail = document.createElement("p");
        detail.className = "replay-detail";
        detail.textContent = [
          typeof entry.mode === "number" ? MODES[entry.mode] : LAZER_MODES[entry.mode] ?? entry.mode,
          entry.score != null ? Number(entry.score).toLocaleString() : "",
          when(entry.date),
          this.tab === "all" ? entry.name : "",
        ]
          .filter(Boolean)
          .join(" · ");
        text.append(top, detail);
        const add = document.createElement("button");
        add.type = "button";
        add.className = "add";
        add.textContent = "Add";
        add.setAttribute("aria-label", `Add ${entry.player}'s replay to the timeline`);
        add.onclick = async () => {
          add.disabled = true;
          try {
            await this.add(entry);
          } finally {
            add.disabled = false;
          }
        };
        item.append(text, add);
        return item;
      }),
    );
  }
}

function when(date: ReplayEntry["date"]) {
  if (date == null || date === 0) return "";
  const time = typeof date === "number" ? date : Date.parse(date);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Explains a replay whose beatmap is not installed, with the MD5 to find it. */
export function showMissingMap(
  panel: HTMLElement,
  details: { md5: string; searched: string[] },
  downloader: boolean,
) {
  const title = document.createElement("strong");
  title.textContent = "This replay's map is not installed";
  const body = document.createElement("p");
  body.textContent =
    "Rendering needs the exact difficulty the replay was played on. Install it in osu! stable or lazer, then add the replay again.";
  const hash = document.createElement("p");
  hash.className = "hash";
  const label = document.createElement("span");
  label.textContent = "Beatmap MD5";
  const code = document.createElement("code");
  code.textContent = details.md5;
  hash.append(label, code);
  const searched = document.createElement("ul");
  for (const place of details.searched) {
    const item = document.createElement("li");
    item.textContent = place;
    searched.append(item);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy MD5";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(details.md5);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select and copy the MD5 above";
    }
  };
  actions.append(copy);
  if (downloader) {
    const find = document.createElement("a");
    find.className = "button primary";
    find.href = `/tools/downloader/#md5=${details.md5}`;
    find.target = "_blank";
    find.rel = "noopener";
    find.textContent = "Find in Beatmap downloader ↗";
    actions.append(find);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "quiet";
  close.textContent = "Dismiss";
  close.onclick = () => {
    panel.hidden = true;
  };
  actions.append(close);
  panel.replaceChildren(title, body, hash, searched, actions);
  panel.hidden = false;
}
