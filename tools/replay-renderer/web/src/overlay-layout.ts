/** What the render service receives for each overlay layer. */
export interface OverlayLayer {
  /** Overlay folder (with `index.html`) or a single `.html` file. */
  folder: string;
  width: number;
  height: number;
  /** Position from the corner of each player's cell, output pixels. */
  x: number;
  y: number;
  scale: number;
  opacity: number;
  settings: Record<string, unknown>;
  /** Tracks (by index) that show it; null: every track. */
  tracks: number[] | null;
}
/** An installed overlay as `GET /v1/overlays` lists it. */
export interface InstalledOverlay {
  /** Folder path relative to vosu's overlays folder. */
  id: string;
  /** metadata.txt `Name`, else the folder name. */
  name: string;
  /** The dashboard's nickname, if the user gave one. */
  nickname: string | null;
  author: string | null;
  folder: string;
  /** Remembered page size, else the overlay's metadata `Resolution`. */
  width: number | null;
  height: number | null;
}
/** A layer in the studio: the render fields plus where it came from. */
export interface Layer extends Omit<OverlayLayer, "tracks"> {
  source: "installed" | "file" | "folder";
  /** Ids of the tracks that switched this overlay off (all show it by default). */
  hidden: Set<string>;
  /** Installed overlay id; null for a file or custom folder. */
  id: string | null;
  name: string;
}
const DEFAULT_PAGE = { width: 640, height: 180 };
export const PAGE_LIMITS = { min: 16, max: 4096 };
/** Matches shown at once; typing narrows the rest. */
const SHOWN = 80;

/** How an installed overlay is shown: its nickname, else its name. */
export const displayName = (entry: InstalledOverlay) => entry.nickname || entry.name;
/** The last segment of an installed overlay's id: its folder name. */
const folderName = (entry: InstalledOverlay) => entry.id.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.id;
const fold = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export interface SearchEntry {
  entry: InstalledOverlay;
  /** Folded display name, for ranking. */
  title: string;
  /** Folded nickname, name, author and id, for matching. */
  text: string;
}
/** Precomputes the folded search text once per listing. */
export function searchIndex(list: readonly InstalledOverlay[]): SearchEntry[] {
  return list.map((entry) => ({
    entry,
    title: fold(displayName(entry)),
    text: fold([entry.nickname ?? "", entry.name, entry.author ?? "", entry.id].join("\n")),
  }));
}
/**
 * Installed overlays matching every word of `query` (in nickname, name,
 * author or folder id; case and accents ignored). Names that start with the
 * query come first, then names with a word starting with it, then the rest,
 * each in listing order. `total` counts all matches; at most `limit` return.
 */
export function filterOverlays(index: readonly SearchEntry[], query: string, limit = SHOWN) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const whole = words.join(" ");
  const ranked: [number, InstalledOverlay][] = [];
  for (const item of index) {
    if (!words.every((word) => item.text.includes(word))) continue;
    const rank = !whole
      ? 0
      : item.title.startsWith(whole)
        ? 0
        : item.title.split(/[\s\-_.]+/).some((part) => part.startsWith(words[0]))
          ? 1
          : 2;
    ranked.push([rank, item.entry]);
  }
  // Array sort is stable: equal ranks keep the listing order.
  ranked.sort((a, b) => a[0] - b[0]);
  return { matches: ranked.slice(0, limit).map(([, entry]) => entry), total: ranked.length };
}

/**
 * Overlay layers. Add opens a searchable list of the overlays installed in
 * vosu; a single `.html` file or a custom folder can be given by path instead.
 * Overlay pages are never embedded in the tool UI; they render only in the
 * private MP4 browser.
 */
export class OverlayEditor {
  readonly layers: Layer[] = [];
  private index: SearchEntry[] = [];
  private available = false;
  private list = document.createElement("div");
  private add = document.createElement("button");
  private picker = document.createElement("div");
  private search = document.createElement("input");
  private options = document.createElement("ul");
  private status = document.createElement("p");
  private shown: InstalledOverlay[] = [];
  private active = 0;
  constructor(
    root: HTMLElement,
    private hooks: {
      /** A layer was added, removed or re-pointed. */
      changed(): void;
      select(layer: Layer): void;
      selected(): Layer | null;
    },
  ) {
    const head = document.createElement("div"),
      label = document.createElement("span"),
      help = document.createElement("span"),
      spacer = document.createElement("span");
    head.className = "subhead";
    label.className = "v-label";
    label.textContent = "Overlays";
    help.className = "v-help";
    help.tabIndex = 0;
    help.setAttribute("role", "img");
    help.dataset.tipPos = "left";
    const tip = "MP4 only. Driven by the first track.";
    help.setAttribute("aria-label", tip);
    help.dataset.tip = tip;
    spacer.className = "v-bar__spacer";
    this.list.className = "layers";
    this.add.type = "button";
    this.add.className = "v-btn v-btn--sm";
    this.add.textContent = "Add";
    this.add.setAttribute("aria-label", "Add overlay layer");
    this.add.setAttribute("aria-expanded", "false");
    this.add.setAttribute("aria-controls", "overlay-picker");
    this.add.onclick = () => this.toggle(this.picker.hidden);
    head.append(label, help, spacer, this.add);

    this.picker.id = "overlay-picker";
    this.picker.className = "overlay-picker";
    this.picker.hidden = true;
    this.search.type = "search";
    this.search.className = "v-input";
    this.search.placeholder = "Search overlays";
    this.search.setAttribute("role", "combobox");
    this.search.setAttribute("aria-label", "Search installed overlays");
    this.search.setAttribute("aria-autocomplete", "list");
    this.search.setAttribute("aria-expanded", "true");
    this.search.setAttribute("aria-controls", "overlay-options");
    this.search.oninput = () => {
      this.active = 0;
      this.renderOptions();
    };
    this.search.onkeydown = (event) => this.key(event);
    this.options.id = "overlay-options";
    this.options.className = "overlay-options v-scroll";
    this.options.setAttribute("role", "listbox");
    this.options.setAttribute("aria-label", "Installed overlays");
    this.status.className = "v-muted overlay-status";
    this.status.setAttribute("aria-live", "polite");
    const other = document.createElement("div");
    other.className = "v-row";
    other.append(
      this.button("Open .html file…", () => this.addPath("file")),
      this.button("Custom folder…", () => this.addPath("folder")),
    );
    this.picker.append(this.search, this.options, this.status, other);
    root.append(head, this.picker, this.list);
  }
  /** Installed overlays from the service; `available` is false on vosu builds without the list. */
  setInstalled(installed: InstalledOverlay[], available: boolean) {
    this.available = available;
    this.index = searchIndex(installed);
    if (!this.picker.hidden) this.renderOptions();
  }
  get configured() {
    return this.layers.length > 0;
  }
  private button(text: string, onclick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "v-btn v-btn--sm v-btn--ghost";
    button.textContent = text;
    button.onclick = onclick;
    return button;
  }
  private toggle(open: boolean) {
    this.picker.hidden = !open;
    this.add.setAttribute("aria-expanded", String(open));
    if (open) {
      this.search.value = "";
      this.active = 0;
      this.renderOptions();
      this.search.focus();
    }
  }
  private key(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.toggle(false);
      this.add.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = this.shown[this.active];
      if (entry) this.addInstalled(entry);
      return;
    }
    const step = ({ ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 } as Record<string, number>)[event.key];
    // Home/End stay with the text field's caret.
    if (step === undefined || !this.shown.length) return;
    event.preventDefault();
    this.active = Math.min(this.shown.length - 1, Math.max(0, this.active + step));
    this.highlight();
  }
  private highlight() {
    const nodes = this.options.children;
    for (let i = 0; i < nodes.length; i++) nodes[i].setAttribute("aria-selected", String(i === this.active));
    const node = nodes[this.active] as HTMLElement | undefined;
    if (node) {
      this.search.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    } else this.search.removeAttribute("aria-activedescendant");
  }
  private renderOptions() {
    const { matches, total } = filterOverlays(this.index, this.search.value);
    this.shown = matches;
    this.options.replaceChildren(
      ...matches.map((entry, i) => {
        const option = document.createElement("li");
        option.id = `overlay-option-${i}`;
        option.className = "overlay-option";
        option.setAttribute("role", "option");
        const name = document.createElement("span"),
          meta = document.createElement("span");
        name.className = "overlay-option__name";
        name.textContent = displayName(entry);
        meta.className = "overlay-option__meta v-mono v-muted";
        meta.textContent = [
          folderName(entry),
          entry.author,
          entry.width && entry.height ? `${entry.width}×${entry.height}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        option.title = entry.folder;
        option.append(name, meta);
        option.onpointerdown = (event) => event.preventDefault();
        option.onclick = () => this.addInstalled(entry);
        return option;
      }),
    );
    this.status.textContent = !this.available
      ? "This vosu does not list installed overlays."
      : !this.index.length
        ? "No overlays installed."
        : total > matches.length
          ? `${matches.length} of ${total} shown. Type to narrow.`
          : total
            ? ""
            : "No match.";
    this.status.hidden = !this.status.textContent;
    this.highlight();
  }
  private page(entry: InstalledOverlay | null) {
    return entry?.width && entry.height
      ? { width: entry.width, height: entry.height }
      : { ...DEFAULT_PAGE };
  }
  private push(layer: Layer) {
    this.layers.push(layer);
    this.toggle(false);
    this.render();
    this.hooks.changed();
    this.hooks.select(layer);
  }
  private blank(entry: InstalledOverlay | null) {
    return { ...this.page(entry), x: 0, y: 0, scale: 1, opacity: 1, settings: {}, hidden: new Set<string>() };
  }
  private addInstalled(entry: InstalledOverlay) {
    this.push({
      source: "installed",
      id: entry.id,
      name: displayName(entry),
      folder: entry.folder,
      ...this.blank(entry),
    });
  }
  private addPath(source: "file" | "folder") {
    this.push({
      source,
      id: null,
      name: source === "file" ? "HTML file" : "Custom folder",
      folder: "",
      ...this.blank(null),
    });
    (this.list.querySelector(".layer:last-child input") as HTMLInputElement | null)?.focus();
  }
  render() {
    const selected = this.hooks.selected();
    this.list.replaceChildren(
      ...this.layers.map((layer) => {
        const row = document.createElement("div");
        row.className = "layer";
        row.setAttribute("aria-selected", String(layer === selected));
        row.onclick = (event) => {
          if (!(event.target as HTMLElement).closest("input, button")) this.hooks.select(layer);
        };
        const title = document.createElement("span");
        title.className = "layer__title";
        const name = document.createElement("span");
        name.className = "layer__name";
        name.textContent = layer.name;
        title.append(name);
        if (layer.source === "installed") {
          const meta = document.createElement("span");
          meta.className = "v-mono v-muted layer__meta";
          meta.textContent = layer.id ?? "";
          title.title = layer.folder;
          title.append(meta);
        }
        const remove = this.button("Remove", () => {
          this.layers.splice(this.layers.indexOf(layer), 1);
          this.render();
          this.hooks.changed();
        });
        remove.setAttribute("aria-label", `Remove ${layer.name}`);
        row.append(title, remove);
        if (layer.source !== "installed") {
          const path = document.createElement("input");
          path.className = "v-input v-input--mono folder";
          path.spellcheck = false;
          path.placeholder =
            layer.source === "file" ? "Absolute path to an .html file" : "Absolute overlay folder";
          path.setAttribute("aria-label", layer.source === "file" ? "Overlay HTML file" : "Overlay folder");
          path.value = layer.folder;
          path.oninput = () => (layer.folder = path.value.trim());
          row.append(path);
        }
        return row;
      }),
    );
  }
  /** The render request's layers; `tracks` are the composition's track ids in order. */
  read(tracks: readonly string[]): OverlayLayer[] {
    return this.layers.map((layer) => {
      if (!layer.folder)
        throw new Error(layer.source === "file" ? "Give the path of every overlay .html file" : "Choose a folder for every overlay layer");
      if (layer.source === "file" && !/\.html?$/i.test(layer.folder))
        throw new Error("An overlay file must be an .html file");
      const { folder, width, height, x, y, scale, opacity, settings } = layer;
      if (![width, height, x, y, scale, opacity].every(Number.isFinite))
        throw new Error("Overlay transforms must be finite numbers");
      const shown = tracks.flatMap((id, index) => (layer.hidden.has(id) ? [] : [index]));
      return {
        folder,
        width,
        height,
        x,
        y,
        scale,
        opacity,
        settings,
        tracks: shown.length === tracks.length ? null : shown,
      };
    });
  }
}
