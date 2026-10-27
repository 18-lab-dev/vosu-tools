// Explorer: an in-page file browser for one skin (stable, added folder, .osk
// or lazer through lazer-library), whose selections feed per-asset mixing.
// Read-only by design: nothing here renames, moves or deletes files.

import { type AssetRef, assetId, fontPrefixes } from "./assets";
import { $, h } from "./dom";
import {
  type FileInfo,
  type Row,
  folders,
  formatSize,
  rowUnits,
  rows,
} from "./explorer-model";
import { parseIni } from "./ini";
import { type Thumb, Thumbnails, paint, thumbCanvas } from "./thumbs";

export interface ExplorerSkin {
  key: string;
  name: string;
  origin: string;
  available: boolean;
}
export interface ExplorerHost {
  skins(): ExplorerSkin[];
  load(key: string): Promise<{ text: string; files: FileInfo[] }>;
  assetUrl(skin: string, file: string): string;
  animationUrl(skin: string, element: string): string;
  /** Plays or pauses a sound; only ever called from an explicit click or key. */
  play(url: string, label: string): void;
  /** The skin the mix takes this asset from, if any. */
  inMix(ref: AssetRef): string | undefined;
  /** Takes (`on`) or drops these assets from `skin` in the mix. */
  use(refs: AssetRef[], skin: string, on: boolean): void;
  /** The element group label of an asset, if Elements shows it. */
  group(ref: AssetRef, ini: string): string | undefined;
  showInElements(ref: AssetRef, skin: string): void;
  status(text: string): void;
  /** The Keymodes screen: its selected slot, assigning to it, dragging onto slots. */
  keymodes: {
    /**
     * The selected slots, or null: the button's label (`Use as 7K column 3
     * note`, `Use for 7 slots`) and what they are.
     */
    target(): { label: string; slots: string } | null;
    assign(skin: string, name: string): void;
    drag(data: DataTransfer, skin: string, name: string): void;
  };
}

const ROW = 32;
const OVERSCAN = 6;
const ORIGINS: [string, string][] = [
  ["stable", "Stable"],
  ["added", "Added"],
  ["osk", ".osk"],
  ["lazer", "Lazer"],
];

export class Explorer {
  #host: ExplorerHost;
  #skin: string | null = null;
  #data: { text: string; files: FileInfo[]; fonts: Set<string> } | null = null;
  #error = "";
  #ticket = 0;
  #folder: string | null = null;
  #grouped = true;
  #rows: Row[] = [];
  #selected = new Set<string>();
  #active = -1;
  #anchor = -1;
  /** Measured image sizes by `skin\nfile`. */
  #dims = new Map<string, [number, number]>();
  /** Worker-made list thumbnails (their decode also gives the pixel size). */
  #thumbs = new Thumbnails(48);
  #frame = 0;
  #detailsFor = "";

  #select = $<HTMLSelectElement>("#x-skin");
  #filter = $<HTMLInputElement>("#x-filter");
  #tree = $("#x-tree");
  #list = $("#x-list");
  #spacer = $("#x-spacer");
  #details = $("#x-details");
  #count = $("#x-count");
  #use = $<HTMLButtonElement>("#x-use");
  #keymodes = $<HTMLButtonElement>("#x-keymodes");

  constructor(host: ExplorerHost) {
    this.#host = host;
    this.#select.onchange = () => void this.open(this.#select.value || null);
    this.#filter.addEventListener("input", () => this.#refresh(false));
    // From the filter, Down/Enter continue in the results.
    this.#filter.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "Enter") && this.#rows.length) {
        e.preventDefault();
        this.#list.focus();
        this.#pick(Math.max(0, this.#active), "only");
      }
    });
    $("#x-grouped").onclick = () => this.#setGrouped(true);
    $("#x-flat").onclick = () => this.#setGrouped(false);
    this.#use.onclick = () => this.#useSelection();
    this.#keymodes.onclick = () => {
      const unit = this.#keymodeUnit();
      if (unit && this.#skin) this.#host.keymodes.assign(this.#skin, unit.name);
    };
    this.#list.addEventListener("scroll", () => this.#schedule());
    this.#list.addEventListener("keydown", (e) => this.#key(e));
    new ResizeObserver(() => this.#schedule()).observe(this.#list);
    this.refreshSkins();
  }

  get skin() {
    return this.#skin;
  }

  /** Rebuilds the skin switcher after the library changed. */
  refreshSkins() {
    const skins = this.#host.skins().filter((s) => s.available);
    this.#select.replaceChildren(
      h("option", { value: "" }, skins.length ? "Choose a skin" : "No skins"),
      ...ORIGINS.flatMap(([origin, label]) => {
        const list = skins.filter((s) => s.origin === origin);
        return list.length
          ? [
              h(
                "optgroup",
                { label },
                ...list.map((s) =>
                  h(
                    "option",
                    { value: s.key, selected: s.key === this.#skin },
                    s.name,
                  ),
                ),
              ),
            ]
          : [];
      }),
    );
    this.#select.value = this.#skin ?? "";
    if (this.#skin && !skins.some((s) => s.key === this.#skin))
      void this.open(null);
  }

  /** Browses a skin (null: none). Keeps the view when it is already open. */
  async open(key: string | null) {
    if (key === this.#skin && (this.#data || this.#error)) return;
    const ticket = ++this.#ticket;
    this.#skin = key;
    this.#select.value = key ?? "";
    this.#data = null;
    this.#error = "";
    this.#folder = null;
    this.#selected.clear();
    this.#active = this.#anchor = -1;
    this.#list.scrollTop = 0;
    this.#refresh(false);
    if (!key) return;
    try {
      const loaded = await this.#host.load(key);
      if (ticket !== this.#ticket) return;
      this.#data = {
        text: loaded.text,
        files: loaded.files,
        fonts: fontPrefixes(parseIni(loaded.text)),
      };
    } catch (error) {
      if (ticket !== this.#ticket) return;
      this.#error = error instanceof Error ? error.message : String(error);
    }
    this.#refresh(false);
  }

  /** Opens `skin`, selects the unit and scrolls it into view. */
  async reveal(skin: string, ref: AssetRef) {
    await this.open(skin);
    if (this.#skin !== skin || !this.#data) return;
    this.#folder = null;
    this.#filter.value = "";
    this.#grouped = true;
    this.#refresh(false);
    const index = this.#rows.findIndex((r) => r.id === assetId(ref));
    if (index < 0) {
      this.#host.status(`${ref.name} is not in this skin`);
      return;
    }
    this.#pick(index, "only");
    this.#list.focus();
  }

  /** Mix changed: update badges and the Use button. */
  refreshMix() {
    this.#renderToolbar();
    this.#renderWindow();
    this.#renderDetails(true);
  }

  // ---- state ---------------------------------------------------------------
  #setGrouped(grouped: boolean) {
    if (grouped === this.#grouped) return;
    // Keep the selection's files selected across the switch.
    const files = new Set(this.#selectedRows().flatMap((r) => r.files));
    const active = this.#rows[this.#active]?.files[0];
    this.#grouped = grouped;
    this.#refresh(false);
    this.#selected = new Set(
      this.#rows
        .filter((r) => r.files.some((f) => files.has(f)))
        .map((r) => r.id),
    );
    this.#active = this.#rows.findIndex(
      (r) => active && r.files.includes(active),
    );
    this.#anchor = this.#active;
    this.#renderAll();
    if (this.#active >= 0) this.#scrollTo(this.#active);
  }

  #refresh(keepScroll: boolean) {
    const data = this.#data;
    this.#rows = data
      ? rows(data.files, data.fonts, {
          folder: this.#filter.value.trim() ? null : this.#folder,
          query: this.#filter.value,
          grouped: this.#grouped,
        })
      : [];
    const ids = new Set(this.#rows.map((r) => r.id));
    for (const id of this.#selected)
      if (!ids.has(id)) this.#selected.delete(id);
    if (this.#active >= this.#rows.length) this.#active = this.#rows.length - 1;
    if (!keepScroll) this.#list.scrollTop = 0;
    this.#renderAll();
  }

  #renderAll() {
    $("#x-grouped").setAttribute("aria-pressed", String(this.#grouped));
    $("#x-flat").setAttribute("aria-pressed", String(!this.#grouped));
    this.#renderTree();
    this.#spacer.style.height = `${this.#rows.length * ROW}px`;
    this.#renderToolbar();
    this.#renderWindow();
    this.#renderDetails(false);
  }

  #selectedRows() {
    return this.#rows.filter((r) => this.#selected.has(r.id));
  }

  /** Moves the active row; `mode` decides what happens to the selection. */
  #pick(index: number, mode: "only" | "toggle" | "range" | "move") {
    if (!this.#rows.length) return;
    index = Math.max(0, Math.min(this.#rows.length - 1, index));
    const id = this.#rows[index].id;
    if (mode === "only") {
      this.#selected = new Set([id]);
      this.#anchor = index;
    } else if (mode === "toggle") {
      if (this.#selected.has(id)) this.#selected.delete(id);
      else this.#selected.add(id);
      this.#anchor = index;
    } else if (mode === "range") {
      const from = this.#anchor < 0 ? index : this.#anchor;
      const [a, b] = from < index ? [from, index] : [index, from];
      this.#selected = new Set(this.#rows.slice(a, b + 1).map((r) => r.id));
    }
    this.#active = index;
    this.#scrollTo(index);
    this.#renderToolbar();
    this.#renderWindow();
    this.#renderDetails(false);
  }

  #scrollTo(index: number) {
    const top = index * ROW,
      view = this.#list.clientHeight - ROW;
    if (top < this.#list.scrollTop) this.#list.scrollTop = top;
    else if (top > this.#list.scrollTop + view)
      this.#list.scrollTop = top - view;
  }

  #key(e: KeyboardEvent) {
    const page = Math.max(1, Math.floor(this.#list.clientHeight / ROW) - 1);
    const at = this.#active;
    const mode = e.shiftKey
      ? "range"
      : e.ctrlKey || e.metaKey
        ? "move"
        : "only";
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: Math.max(0, at - 1),
      PageDown: at + page,
      PageUp: at - page,
      Home: 0,
      End: this.#rows.length - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      this.#pick(at < 0 && e.key === "ArrowDown" ? 0 : moves[e.key], mode);
    } else if (e.key === " " && at >= 0) {
      e.preventDefault();
      this.#pick(at, "toggle");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.#selected = new Set(this.#rows.map((r) => r.id));
      this.#renderToolbar();
      this.#renderWindow();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.#useSelection();
    } else if (e.key === "Escape" && this.#selected.size) {
      e.preventDefault();
      this.#selected.clear();
      this.#renderToolbar();
      this.#renderWindow();
    }
  }

  #useSelection() {
    const units = rowUnits(this.#selectedRows());
    if (!units.length || !this.#skin) return;
    const all = units.every((u) => this.#host.inMix(u) === this.#skin);
    this.#host.use(units, this.#skin, !all);
    this.#host.status(
      all
        ? `Removed ${units.length === 1 ? units[0].name : `${units.length} assets`} from the mix`
        : `${units.length === 1 ? units[0].name : `${units.length} assets`} in mix`,
    );
  }

  // ---- rendering -------------------------------------------------------------
  #renderTree() {
    const data = this.#data;
    if (!data) {
      this.#tree.replaceChildren();
      return;
    }
    const searching = !!this.#filter.value.trim();
    const item = (
      label: string,
      path: string | null,
      count: number,
      depth: number,
    ) =>
      h(
        "button",
        {
          type: "button",
          class: "x-folder",
          ariaCurrent: String(!searching && this.#folder === path),
          title: path ?? "Every file",
          onclick: () => {
            this.#folder = path;
            this.#filter.value = "";
            this.#refresh(false);
          },
        },
        h("span", { class: "x-folder__name" }, label),
        h("span", { class: "v-muted" }, String(count)),
      );
    const tree = folders(data.files);
    const nodes = [item("All files", null, data.files.length, 0)];
    for (const f of tree) {
      const button = item(
        f.path ? f.name : "Skin root",
        f.path,
        f.count,
        f.depth,
      );
      button.style.paddingLeft = `calc(var(--space-2) + ${f.depth} * var(--space-3))`;
      nodes.push(button);
    }
    this.#tree.replaceChildren(...nodes);
  }

  #renderToolbar() {
    const selected = this.#selectedRows();
    const units = rowUnits(selected);
    const skin = this.#skin;
    const inMix =
      !!units.length && units.every((u) => this.#host.inMix(u) === skin);
    this.#use.disabled = !units.length;
    this.#use.setAttribute("aria-pressed", String(inMix));
    // Primary until everything selected is in the mix; then a pressed toggle.
    this.#use.classList.toggle("v-btn--primary", !inMix);
    this.#use.textContent = inMix
      ? "Remove from mix"
      : units.length > 1
        ? `Use ${units.length} in mix`
        : "Use in mix";
    const n = this.#rows.length;
    const noun = this.#grouped
      ? n === 1
        ? "item"
        : "items"
      : n === 1
        ? "file"
        : "files";
    this.#count.textContent = !this.#data
      ? ""
      : selected.length
        ? `${selected.length} selected${units.length !== selected.length ? ` · ${units.length} assets` : ""}`
        : `${n} ${noun}`;
    const target = this.#host.keymodes.target();
    const unit = this.#keymodeUnit();
    this.#keymodes.disabled = !unit || !target;
    this.#keymodes.textContent = target?.label ?? "Use in Keymodes";
    this.#keymodes.title = !target
      ? "Select a slot on the Keymodes tab first"
      : unit
        ? `Set ${target.slots} to ${unit.name} and show it on the Keymodes tab`
        : "Select one image";
  }

  /** The one image selected, for a Keymodes slot. */
  #keymodeUnit() {
    const units = rowUnits(this.#selectedRows());
    return units.length === 1 && units[0].kind === "image" ? units[0] : undefined;
  }

  #schedule() {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#renderWindow());
  }

  #dimsOf(file: string) {
    return this.#skin ? this.#dims.get(`${this.#skin}\n${file}`) : undefined;
  }
  /** Asks for a file's thumbnail; `done` runs if it arrives while `skin` is open. */
  #thumb(skin: string, file: string, done: (thumb: Thumb) => void) {
    const url = new URL(this.#host.assetUrl(skin, file), location.href).href;
    this.#thumbs.request(url, (thumb) => {
      if (!thumb) return;
      this.#dims.set(`${skin}\n${file}`, [thumb.width, thumb.height]);
      if (this.#skin === skin) done(thumb);
    });
    return url;
  }

  #renderWindow() {
    const list = this.#list;
    if (!this.#data) {
      const text = this.#error || (this.#skin ? "Reading…" : "Select a skin.");
      list.replaceChildren(
        this.#spacer,
        h("p", { class: "v-empty x-empty" }, text),
      );
      list.removeAttribute("aria-activedescendant");
      return;
    }
    if (!this.#rows.length) {
      list.replaceChildren(
        this.#spacer,
        h("p", { class: "v-empty x-empty" }, "No files match."),
      );
      list.removeAttribute("aria-activedescendant");
      return;
    }
    // Hidden (another tab is open): nothing to draw or decode until shown;
    // the resize observer renders the rows once the list has a size.
    if (!list.clientHeight) {
      list.replaceChildren(this.#spacer);
      this.#thumbs.want([]);
      return;
    }
    const first = Math.max(0, Math.floor(list.scrollTop / ROW) - OVERSCAN);
    const last = Math.min(
      this.#rows.length,
      Math.ceil((list.scrollTop + list.clientHeight) / ROW) + OVERSCAN,
    );
    const nodes: Node[] = [this.#spacer];
    const urls: string[] = [];
    for (let i = first; i < last; i++) nodes.push(this.#row(i, urls));
    list.replaceChildren(...nodes);
    // Thumbnails for rows scrolled away are not made.
    this.#thumbs.want(urls);
    const active = this.#active;
    if (active >= first && active < last)
      list.setAttribute("aria-activedescendant", `x-opt-${active}`);
    else list.removeAttribute("aria-activedescendant");
  }

  #row(index: number, urls: string[]) {
    const row = this.#rows[index];
    const skin = this.#skin!;
    const file = row.files[0];
    const dims = this.#dimsOf(file);
    const dimsCell = h(
      "span",
      { class: "x-dims v-mono" },
      dims ? `${dims[0]}×${dims[1]}` : "",
    );
    let thumb: Node;
    if (row.kind === "image") {
      const canvas = thumbCanvas(undefined);
      urls.push(
        this.#thumb(skin, file, (t) => {
          paint(canvas, t);
          dimsCell.textContent = `${t.width}×${t.height}`;
        }),
      );
      thumb = canvas;
    } else if (row.kind === "sound") {
      const url = this.#host.assetUrl(skin, file);
      const play = h(
        "button",
        {
          type: "button",
          class: "v-btn v-btn--sm v-btn--icon play",
          ariaLabel: `Play ${row.label}`,
          tabIndex: -1,
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            this.#host.play(url, row.label);
          },
        },
        "▶",
      );
      play.dataset.src = url;
      thumb = play;
    } else
      thumb = h("span", { class: "x-ext v-mono" }, file.split(".").pop() ?? "");
    const fromHere = row.unit && this.#host.inMix(row.unit) === skin;
    const element = h(
      "div",
      {
        id: `x-opt-${index}`,
        role: "option",
        class: `x-row${index === this.#active ? " active" : ""}`,
        ariaSelected: String(this.#selected.has(row.id)),
        title: row.files.join("\n"),
        draggable: row.unit?.kind === "image",
        onclick: (event: MouseEvent) => {
          this.#pick(
            index,
            event.shiftKey
              ? "range"
              : event.ctrlKey || event.metaKey
                ? "toggle"
                : "only",
          );
          this.#list.focus({ preventScroll: true });
        },
        ondblclick: () => this.#useSelection(),
        // Images drag onto Keymodes slots (the Keymodes tab opens on hover).
        ondragstart: (event: DragEvent) => {
          if (row.unit?.kind !== "image" || !event.dataTransfer) return;
          this.#host.keymodes.drag(event.dataTransfer, skin, row.unit.name);
        },
      },
      h("span", { class: "x-thumb" }, thumb),
      h(
        "span",
        { class: "x-name" },
        this.#folder === null && row.folder
          ? h("span", { class: "x-path" }, `${row.folder}/`)
          : null,
        row.label,
      ),
      h("span", { class: "x-detail v-muted" }, row.detail),
      h("span", { class: "x-kind v-muted" }, row.kind),
      h("span", { class: "x-size v-mono" }, formatSize(row.size)),
      dimsCell,
      h(
        "span",
        { class: "x-mix" },
        fromHere
          ? h("span", { class: "v-badge v-badge--accent" }, "in mix")
          : null,
      ),
    );
    element.style.top = `${index * ROW}px`;
    return element;
  }

  /** Details of the active row; `soft` keeps an unchanged preview (no refetch). */
  #renderDetails(soft: boolean) {
    const row = this.#rows[this.#active];
    const skin = this.#skin;
    const data = this.#data;
    const key = row && skin ? `${skin}\n${row.id}` : "";
    if (!row || !skin || !data) {
      this.#detailsFor = "";
      this.#details.replaceChildren(
        h(
          "p",
          { class: "v-empty" },
          data && this.#rows.length ? "Select a file." : "",
        ),
      );
      return;
    }
    const keepPreview = soft && key === this.#detailsFor;
    const oldPreview = this.#details.querySelector(".x-preview");
    this.#detailsFor = key;
    const preview =
      keepPreview && oldPreview ? oldPreview : this.#preview(row, skin);
    const unit = row.unit;
    const mixSkin = unit ? this.#host.inMix(unit) : undefined;
    const group = unit ? this.#host.group(unit, data.text) : undefined;
    const fileFacts = row.files.map((file) => {
      const d = this.#dimsOf(file);
      const size = data.files.find((f) => f.name === file)?.size ?? 0;
      return h(
        "li",
        {},
        h("span", { class: "v-mono" }, file),
        h(
          "span",
          { class: "v-muted" },
          [formatSize(size), d ? `${d[0]}×${d[1]}` : ""]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    });
    const facts: [string, Node | string][] = [
      ["Kind", row.kind + (row.detail ? ` · ${row.detail}` : "")],
      ["Size", formatSize(row.size)],
    ];
    if (unit) {
      facts.push([
        "Asset",
        `${unit.kind} ${unit.name}${unit.kind === "font" ? "-*" : ""}`,
      ]);
      facts.push(["Element group", group ?? "None"]);
      facts.push([
        "In mix",
        mixSkin === undefined
          ? "No"
          : mixSkin === skin
            ? "From this skin"
            : `From ${this.#host.skins().find((s) => s.key === mixSkin)?.name ?? mixSkin}`,
      ]);
    }
    const actions = unit
      ? h(
          "div",
          { class: "v-row" },
          h(
            "button",
            {
              type: "button",
              class: "v-btn v-btn--sm",
              disabled: !group,
              title: group ? "" : "Not one of the element groups",
              onclick: () => this.#host.showInElements(unit, skin),
            },
            "Show in Elements",
          ),
        )
      : null;
    this.#details.replaceChildren(
      preview,
      h("h3", { class: "x-title" }, row.label),
      h(
        "dl",
        { class: "v-facts" },
        ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
      ),
      h("ol", { class: "x-members", ariaLabel: "Files" }, ...fileFacts),
      ...(actions ? [actions] : []),
    );
    // Measure member images not seen yet (frames, @2x variants).
    if (row.kind === "image")
      for (const file of row.files.slice(0, 24))
        if (!this.#dimsOf(file))
          this.#thumb(skin, file, () => {
            if (this.#detailsFor === key) this.#renderDetails(true);
          });
  }

  #preview(row: Row, skin: string): Element {
    const box = h("div", { class: "x-preview frame" });
    const unit = row.unit;
    if (row.kind === "image") {
      const frames = unit?.kind === "image" && /frames/.test(row.detail);
      box.append(
        h("img", {
          src: frames
            ? this.#host.animationUrl(skin, unit.name)
            : this.#host.assetUrl(skin, row.files[0]),
          alt: row.label,
          decoding: "async",
        }),
      );
    } else if (row.kind === "sound") {
      const url = this.#host.assetUrl(skin, row.files[0]);
      const play = h(
        "button",
        {
          type: "button",
          class: "v-btn v-btn--icon play",
          ariaLabel: `Play ${row.label}`,
          onclick: () => this.#host.play(url, row.label),
        },
        "▶",
      );
      play.dataset.src = url;
      box.append(play);
    } else if (row.kind === "text") {
      box.classList.replace("frame", "x-text");
      const pre = h("pre", { class: "v-mono" }, "Reading…");
      box.append(pre);
      fetch(this.#host.assetUrl(skin, row.files[0]), { credentials: "omit" })
        .then(async (r) =>
          r.ok ? r.text() : Promise.reject(new Error(await r.text())),
        )
        .then(
          (text) =>
            (pre.textContent =
              text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text),
          (error: Error) => (pre.textContent = error.message),
        );
    } else {
      box.classList.replace("frame", "x-text");
      box.append(
        h("p", { class: "v-muted" }, "No preview for this file type."),
      );
    }
    return box;
  }
}
