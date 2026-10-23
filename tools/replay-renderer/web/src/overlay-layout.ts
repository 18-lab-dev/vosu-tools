/** What the render service receives for each overlay layer. */
export interface OverlayLayer {
  folder: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  settings: Record<string, unknown>;
}
/** An installed overlay as `GET /v1/overlays` lists it. */
export interface InstalledOverlay {
  id: string;
  name: string;
  author: string | null;
  folder: string;
  /** Remembered page size, else the overlay's metadata `Resolution`. */
  width: number | null;
  height: number | null;
}
/** A layer in the studio: the render fields plus where its folder came from. */
export interface Layer extends OverlayLayer {
  /** Installed overlay id, or null for a custom folder. */
  id: string | null;
  name: string;
}
const DEFAULT_PAGE = { width: 640, height: 180 };
export const PAGE_LIMITS = { min: 16, max: 4096 };

/**
 * Overlay layers: each is an installed overlay picked by name (or, as an
 * advanced option, a custom folder). Overlay pages are never embedded in the
 * tool UI; they render only in the private MP4 browser.
 */
export class OverlayEditor {
  readonly layers: Layer[] = [];
  private installed: InstalledOverlay[] = [];
  private list = document.createElement("div");
  private add = document.createElement("button");
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
    this.add.onclick = () => this.addLayer();
    head.append(label, help, spacer, this.add);
    root.append(head, this.list);
  }
  /** Installed overlays from the service; `available` false on older vosu. */
  setInstalled(installed: InstalledOverlay[]) {
    this.installed = installed;
    this.render();
  }
  get configured() {
    return this.layers.length > 0;
  }
  private page(entry: InstalledOverlay | undefined) {
    return entry?.width && entry.height
      ? { width: entry.width, height: entry.height }
      : { ...DEFAULT_PAGE };
  }
  private addLayer() {
    const entry = this.installed[0];
    const layer: Layer = {
      id: entry?.id ?? null,
      name: entry?.name ?? "Custom folder",
      folder: entry?.folder ?? "",
      ...this.page(entry),
      x: 0,
      y: 0,
      scale: 1,
      opacity: 1,
      settings: {},
    };
    this.layers.push(layer);
    this.render();
    this.hooks.changed();
    this.hooks.select(layer);
  }
  render() {
    const selected = this.hooks.selected();
    this.list.replaceChildren(
      ...this.layers.map((layer) => {
        const row = document.createElement("div");
        row.className = "layer";
        row.setAttribute("aria-selected", String(layer === selected));
        row.onclick = (event) => {
          if (!(event.target as HTMLElement).closest("select, input, button"))
            this.hooks.select(layer);
        };
        const pick = document.createElement("select");
        pick.className = "v-select";
        pick.setAttribute("aria-label", "Overlay");
        for (const entry of this.installed) pick.add(new Option(entry.name, entry.id));
        pick.add(new Option("Custom folder…", ""));
        pick.value = layer.id ?? "";
        pick.onchange = () => {
          const entry = this.installed.find((e) => e.id === pick.value);
          layer.id = entry?.id ?? null;
          layer.name = entry?.name ?? "Custom folder";
          layer.folder = entry?.folder ?? "";
          Object.assign(layer, this.page(entry));
          this.render();
          this.hooks.changed();
          this.hooks.select(layer);
        };
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "v-btn v-btn--sm v-btn--ghost";
        remove.textContent = "Remove";
        remove.onclick = () => {
          this.layers.splice(this.layers.indexOf(layer), 1);
          this.render();
          this.hooks.changed();
        };
        row.append(pick, remove);
        if (layer.id === null) {
          const folder = document.createElement("input");
          folder.className = "v-input v-input--mono folder";
          folder.placeholder = "Absolute overlay folder";
          folder.setAttribute("aria-label", "Overlay folder");
          folder.value = layer.folder;
          folder.oninput = () => (layer.folder = folder.value.trim());
          row.append(folder);
        }
        return row;
      }),
    );
  }
  read(): OverlayLayer[] {
    return this.layers.map((layer) => {
      if (!layer.folder) throw new Error("Choose a folder for every overlay layer");
      const { folder, width, height, x, y, scale, opacity, settings } = layer;
      if (![width, height, x, y, scale, opacity].every(Number.isFinite))
        throw new Error("Overlay transforms must be finite numbers");
      return { folder, width, height, x, y, scale, opacity, settings };
    });
  }
}
