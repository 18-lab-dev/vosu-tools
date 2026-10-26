// The Keymodes screen: per key count of the mix draft, which image each
// column slot uses (with where the client finds it), the columns' visual
// values, and a picker of images from any skin the studio can open. Every
// change edits the mix recipe's `keymodes` (one undo step each) and so the
// `[Mania]` block the mix builds.

import {
  maniaKeyCounts,
  maniaValue,
  parse,
  resolve as specOf,
} from "@vosu-tools/skin-spec";
import {
  MANIA_SCALE,
  fallbackColumnIndex,
  maniaConfig,
  maniaLayout,
  type ManiaImageResolution,
} from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { $, h } from "./dom";
import {
  COLUMN_ROLES,
  History,
  applyToAll,
  columnKey,
  copyStage,
  defaultPattern,
  imageUnit,
  mirror,
  patternOf,
  remapColumns,
  stageImages,
  stageStatus,
  type KeymodeDraft,
  type Keymodes,
  type Slot,
  type SlotImage,
} from "./keymodes";
import { frameNames, imageIndex, lookupFiles } from "./mania";
import { checkDrop, type DroppedImage } from "./uploads";
import type { Preview, PreviewSource } from "./preview";

/** Key counts render-core draws (dual stages above 10K are not previewed). */
const DRAWN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DUAL = [12, 14, 16, 18];
/** Library key of dropped files (the service's `uploads::KEY`). */
export const UPLOADS = "uploads:";
const MIX = "mix:";
const DRAG_TYPE = "application/x-skin-studio-image";

export interface PickerSource {
  key: string;
  name: string;
  group: string;
}
export interface KeymodesHost {
  /** The recipe's drafts (live object). */
  drafts(): Keymodes;
  /** Stores one key count's draft (undefined drops it) and recomposes. */
  apply(keys: number, draft: KeymodeDraft | undefined): void;
  /** The mix draft's skin.ini as the editor holds it. */
  mixText(): string;
  /** The mix's files: lower-cased output path → where it is copied from. */
  mixFiles(): Map<string, { skin: string; from: string; to: string }>;
  sources(): PickerSource[];
  load(key: string): Promise<{ text: string; files: string[] }>;
  assetUrl(skin: string, file: string): string;
  skinName(key: string): string;
  /** Stores a dropped file; resolves with its name under {@link UPLOADS}. */
  upload(group: string, name: string, file: Blob): Promise<string>;
  canWrite(): boolean;
  preview(
    canvas: HTMLCanvasElement,
    stage: HTMLElement,
    onState: (text: string) => void,
  ): Promise<Preview>;
  previewSource(): PreviewSource;
}

/** An image the picker offers. */
interface Unit {
  name: string;
  files: SlotImage["files"];
  frames: number;
  hd: boolean;
  /** Skin and file shown as its thumbnail. */
  thumb: { skin: string; file: string };
}

const ROLE_HINTS: Record<string, RegExp> = {
  "KeyImage#": /(^|\/)mania-key[12s]$|key(?!.*(d|down|press)$)|receptor(?!.*(tap|down|press))/i,
  "KeyImage#D": /mania-key[12s]d$|key.*(d|down|press)$|receptor.*(tap|down|press)/i,
  "NoteImage#": /(^|\/)mania-note[12s]$|note(?!.*[hlt]$)|circle/i,
  "NoteImage#H": /mania-note[12s]h$|head|note.*h$/i,
  "NoteImage#L": /mania-note[12s]l$|body|lnb|hold|long/i,
  "NoteImage#T": /mania-note[12s]t$|tail|lnt|note.*t$/i,
  StageLeft: /stage-?left|left/i,
  StageRight: /stage-?right|right/i,
  StageBottom: /bottom/i,
  StageHint: /hint|judg.*line/i,
  StageLight: /stage-?light|column.*light/i,
  LightingN: /lightingn|explosion|lighting/i,
  LightingL: /lightingl|lighting/i,
  WarningArrow: /warning|arrow/i,
  Hit: /hit|300|200|100|50|miss/i,
};
const hintFor = (pattern: string) =>
  ROLE_HINTS[pattern] ?? (pattern.startsWith("Hit") ? ROLE_HINTS.Hit : /$^/);
const roleLabel = (pattern: string) =>
  COLUMN_ROLES.find((r) => r.pattern === pattern)?.label ?? pattern;

const SOURCE_TEXT = {
  "skin.ini": "ini",
  default: "default",
  "built-in": "built-in",
  missing: "missing",
} as const;

const clone = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);
const emptyDraft = (): KeymodeDraft => ({ images: {}, values: {} });

/** `r,g,b[,a]` ↔ `#rrggbb` for colour inputs (alpha kept aside). */
const toHex = (value: string | undefined, fallback: string) => {
  const c = (value ?? fallback).split(",").map((v) => Number(v.trim()));
  return `#${c
    .slice(0, 3)
    .map((v) => Math.max(0, Math.min(255, v || 0)).toString(16).padStart(2, "0"))
    .join("")}`;
};
const fromHex = (hex: string, previous: string | undefined, alpha: boolean) => {
  const rgb = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const a = previous?.split(",")[3]?.trim();
  return [...rgb, ...(alpha && a !== undefined ? [a] : [])].join(",");
};

/** First 16 hex digits of the SHA-256 of all `blobs`, in order. */
async function groupOf(blobs: Blob[]): Promise<string> {
  const bytes = new Uint8Array(await new Blob(blobs).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class KeymodesView {
  #host: KeymodesHost;
  #history = new History();
  #keys = 0;
  /** The slot the picker assigns to (an image key of the shown key count). */
  #armed: string | null = null;
  /** Grid cell with keyboard focus: [row, column]. */
  #cell: [number, number] = [0, 0];
  #source = MIX;
  #filter = "";
  #units: Unit[] = [];
  /** The source's own keys per role, for ranking (`NoteImage#H` → names). */
  #sourceRoles = new Map<string, Set<string>>();
  #loadingSource = 0;
  #dragged: { unit: Unit; source: string } | null = null;
  #preview?: Preview;
  #previewLoading?: Promise<Preview | undefined>;
  #playing = false;
  #visible = false;
  #resolved: ManiaImageResolution[] = [];
  #mixIndex = new Map<string, string[]>();

  constructor(host: KeymodesHost) {
    this.#host = host;
    $("#km-undo").onclick = () => this.undo();
    $("#km-redo").onclick = () => this.redo();
    $("#km-all").onclick = () => this.#applyToAll();
    $("#km-mirror").onclick = () =>
      this.#change("Mirror", (draft) =>
        Object.assign(draft.images, mirror(this.#keys, this.#current)),
      );
    $("#km-pattern").onclick = () =>
      this.#change("osu! column pattern", (draft) =>
        Object.assign(draft.images, defaultPattern(this.#keys, this.#current)),
      );
    $("#km-still").onclick = () => this.#setPlaying(false);
    $("#km-play").onclick = () => this.#setPlaying(true);
    $<HTMLSelectElement>("#km-add").onchange = (event) => {
      const select = event.target as HTMLSelectElement;
      const keys = Number(select.value);
      select.value = "";
      if (keys) this.#addKeyCount(keys);
    };
    $<HTMLSelectElement>("#km-copy-skin").onchange = () =>
      void this.#copyCounts();
    $<HTMLFormElement>("#km-copy").onsubmit = (event) => {
      event.preventDefault();
      void this.#copy();
    };
    const source = $<HTMLSelectElement>("#km-source");
    source.onchange = () => void this.#openSource(source.value);
    const filter = $<HTMLInputElement>("#km-filter");
    filter.oninput = () => {
      this.#filter = filter.value.trim().toLowerCase();
      this.#renderImages();
    };
    filter.onkeydown = (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.#focusTile(0);
      }
    };
    $("#km-images").onkeydown = (event) => this.#tileKey(event);
    const picker = $(".km-picker");
    this.#acceptFiles(picker, (images, files) =>
      this.#uploadImages(images, files).then((slots) => {
        if (slots.length) void this.#openSource(UPLOADS);
      }),
    );
    $("#km-grid").onkeydown = (event) => this.#gridKey(event);
    $("#km-shared-grid").onkeydown = (event) => this.#gridKey(event);
    $("#keymodes-view").addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, select, textarea")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.redo();
      }
    });
    new ResizeObserver(() => this.#renderColumns()).observe($("#km-stage"));
  }

  // ---- state --------------------------------------------------------------

  /** Key counts shown: the mix's `[Mania]` blocks plus added ones. */
  #counts(): number[] {
    const counts = new Set(maniaKeyCounts(parse(this.#host.mixText())));
    for (const key of Object.keys(this.#host.drafts())) counts.add(Number(key));
    return [...counts].filter((k) => k > 0).sort((a, b) => a - b);
  }
  #draft(): KeymodeDraft | undefined {
    return this.#host.drafts()[String(this.#keys)];
  }
  /** The slot a key has now: the draft's, else a value naming what the mix draws. */
  #current = (key: string): Slot => {
    const draft = this.#draft();
    if (draft && key in draft.images) return clone(draft.images[key]);
    const r = this.#resolved.find((i) => i.key === key);
    if (!r || r.source === "missing") return null;
    return { value: r.value ?? r.name };
  };

  /** One undoable change of the shown key count's draft. */
  #change(label: string, mutate: (draft: KeymodeDraft) => void, keys = this.#keys) {
    if (!keys) return;
    if (!this.#host.canWrite()) {
      this.#error("Read-only tab: open Skin studio from the dashboard to edit.");
      return;
    }
    const before = clone(this.#host.drafts()[String(keys)]);
    const after = clone(before) ?? emptyDraft();
    mutate(after);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    this.#history.push({ keys, before, after, label });
    this.#host.apply(keys, after);
    this.#error("");
    this.#state(label);
  }
  undo() {
    const change = this.#history.undo();
    if (!change) return;
    this.#keys = change.keys;
    this.#host.apply(change.keys, clone(change.before));
    this.#state(`Undid ${change.label}`);
  }
  redo() {
    const change = this.#history.redo();
    if (!change) return;
    this.#keys = change.keys;
    this.#host.apply(change.keys, clone(change.after));
    this.#state(`Redid ${change.label}`);
  }
  #state(text: string) {
    $("#km-state").textContent = text;
  }
  #error(text: string) {
    const error = $("#km-error");
    error.textContent = text;
    error.hidden = !text;
  }

  #assign(key: string, slot: Slot, label: string) {
    this.#change(label, (draft) => {
      draft.images[key] = slot;
    });
  }
  #clear(key: string) {
    this.#assign(key, null, `Clear ${this.#keyLabel(key)}`);
  }
  #keyLabel(key: string) {
    const column = /\d+/.exec(key);
    return column && /^(KeyImage|NoteImage)/.test(key)
      ? `column ${Number(column[0]) + 1} ${roleLabel(patternOf(key)).toLowerCase()}`
      : key;
  }

  // ---- showing --------------------------------------------------------------

  async show(visible: boolean) {
    this.#visible = visible;
    if (!visible) {
      await this.#preview?.show(false);
      return;
    }
    this.refresh();
    if (this.#source === MIX || !this.#units.length)
      await this.#openSource(this.#source);
    const preview = await this.#ensurePreview();
    if (!preview || !this.#visible) return;
    this.#syncPreview();
    await preview.show(true);
  }

  /** Re-reads the mix (after a compose or an edit of its skin.ini). */
  refresh() {
    const counts = this.#counts();
    if (!counts.includes(this.#keys))
      this.#keys = counts.find((k) => DRAWN.includes(k)) ?? counts[0] ?? 0;
    const files = this.#host.mixFiles();
    this.#mixIndex = imageIndex([...files.keys()]);
    this.#resolved = this.#keys
      ? stageImages(this.#host.mixText(), [...files.keys()], this.#keys)
      : [];
    if (!this.#visible) return;
    this.#renderRail(counts);
    this.#renderToolbar();
    this.#renderGrid();
    this.#renderShared();
    this.#renderColumns();
    this.#renderCopy();
    this.#syncPreview();
    if (this.#source === MIX) void this.#openSource(MIX);
    else this.#renderSources();
  }

  #select(keys: number) {
    if (keys === this.#keys) return;
    this.#keys = keys;
    this.#armed = null;
    this.#cell = [0, 0];
    this.refresh();
  }

  /** An empty draft makes the block (`[Mania]`, `Keys: N`) on its own. */
  #addKeyCount(keys: number) {
    this.#keys = keys;
    this.#change(`Add ${keys}K`, () => {}, keys);
  }

  #renderRail(counts: number[]) {
    const text = this.#host.mixText();
    const files = [...this.#host.mixFiles().keys()];
    const rail = $("#km-counts");
    const hadFocus = rail.contains(document.activeElement);
    rail.replaceChildren(
      ...counts.map((keys) => {
        const drawn = DRAWN.includes(keys);
        const status = drawn ? stageStatus(stageImages(text, files, keys)) : "dual";
        const label = {
          complete: "complete",
          fallback: "falls back",
          missing: "missing images",
          dual: "not previewed",
        }[status];
        const button = h(
          "button",
          {
            type: "button",
            class: "km-count",
            ariaCurrent: String(keys === this.#keys),
            ariaLabel: `${keys}K, ${label}`,
            disabled: !drawn,
            title: drawn
              ? ""
              : "Dual-stage layouts are not supported by render-core's preview yet",
            onclick: () => this.#select(keys),
          },
          this.#miniStage(text, keys),
          h("span", { class: "km-count__name" }, `${keys}K`),
          h("span", { class: `km-status km-status--${status}` }, label),
        );
        return h("li", {}, button);
      }),
    );
    if (hadFocus)
      rail.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    const add = $<HTMLSelectElement>("#km-add");
    add.replaceChildren(
      h("option", { value: "" }, "Add key count…"),
      ...DRAWN.filter((k) => !counts.includes(k)).map((k) =>
        h("option", { value: String(k) }, `${k}K`),
      ),
      ...DUAL.map((k) =>
        h("option", { value: String(k), disabled: true }, `${k}K (dual stage, not yet)`),
      ),
    );
    add.disabled = !this.#host.canWrite();
  }

  /** A stage diagram from render-core's layout: columns, their colours and lines. */
  #miniStage(text: string, keys: number) {
    const canvas = h("canvas", { width: 56, height: 40, ariaHidden: "true" });
    canvas.className = "km-mini";
    const g = canvas.getContext("2d");
    if (!g || !DRAWN.includes(keys)) return canvas;
    const config = maniaConfig(readSkinIni(text), keys);
    const layout = maniaLayout(config, () => undefined);
    const scale = Math.min(48 / layout.width, 1);
    const left = (56 - layout.width * scale) / 2;
    const style = getComputedStyle(document.documentElement);
    g.fillStyle = style.getPropertyValue("--bg-sunken") || "#111";
    g.fillRect(left, 0, layout.width * scale, 40);
    for (const column of layout.columns) {
      const [r, gr, b, a] = column.background.colour;
      g.fillStyle = `rgba(${r * 255},${gr * 255},${b * 255},${Math.max(a, 0.15)})`;
      g.fillRect(left + column.x * scale, 0, column.width * scale - 1, 40);
      g.fillStyle = style.getPropertyValue("--fg-dim") || "#999";
      g.fillRect(left + column.x * scale + 1, 30, column.width * scale - 3, 6);
    }
    g.fillStyle = style.getPropertyValue("--accent") || "#f60";
    g.fillRect(left, (layout.hitY / 768) * 40, layout.width * scale, 1);
    return canvas;
  }

  #renderToolbar() {
    const write = this.#host.canWrite() && !!this.#keys;
    const next = this.#history.next;
    const undo = $<HTMLButtonElement>("#km-undo"),
      redo = $<HTMLButtonElement>("#km-redo");
    undo.disabled = !this.#history.canUndo;
    redo.disabled = !this.#history.canRedo;
    undo.title = next.undo ? `Undo ${next.undo} (Ctrl+Z)` : "Nothing to undo";
    redo.title = next.redo ? `Redo ${next.redo} (Ctrl+Shift+Z)` : "Nothing to redo";
    const all = $<HTMLButtonElement>("#km-all");
    const armed = this.#armed && /\d/.test(this.#armed) && /^(Key|Note)Image/.test(this.#armed);
    all.disabled = !write || !armed;
    all.textContent = armed
      ? `Apply ${roleLabel(patternOf(this.#armed!)).toLowerCase()} to all columns`
      : "Apply to all columns";
    all.title = armed ? "" : "Select a column slot first";
    $<HTMLButtonElement>("#km-mirror").disabled = !write || this.#keys < 2;
    $<HTMLButtonElement>("#km-mirror").title =
      `Right half takes the left half's images: ${this.#mirrorPairs()}`;
    $<HTMLButtonElement>("#km-pattern").disabled = !write || this.#keys < 2;
    $<HTMLButtonElement>("#km-pattern").title =
      `Columns of one kind share the first one's images (osu!'s default names): ${this.#patternText()}`;
    $("#km-still").setAttribute("aria-pressed", String(!this.#playing));
    $("#km-play").setAttribute("aria-pressed", String(this.#playing));
    $<HTMLButtonElement>("#km-play").disabled = !DRAWN.includes(this.#keys);
  }
  #mirrorPairs() {
    const pairs: string[] = [];
    for (let i = 0; i < Math.floor(this.#keys / 2); i++)
      pairs.push(`${i + 1}→${this.#keys - i}`);
    return pairs.join(", ");
  }
  #patternText() {
    return Array.from({ length: this.#keys }, (_, c) =>
      fallbackColumnIndex(this.#keys, c),
    ).join(" ");
  }

  // ---- grid -----------------------------------------------------------------

  #slotInfo(r: ManiaImageResolution) {
    const files = this.#host.mixFiles();
    const draft = this.#draft();
    const managed = !!draft && r.key in draft.images;
    const drawn = r.drawn;
    let thumb: string | undefined,
      frames = 0,
      hd = false,
      from: string | undefined;
    if (drawn && !drawn.builtin) {
      const paths = lookupFiles(this.#mixIndex, drawn.name, r.animated);
      const sd = paths.find((p) => !/@2x\.[^.]+$/i.test(p)) ?? paths[0];
      const source = sd && files.get(sd);
      if (source) {
        thumb = this.#host.assetUrl(source.skin, source.from);
        from = this.#host.skinName(source.skin);
      }
      frames = r.animated ? frameNames(this.#mixIndex, drawn.name).length : 0;
      hd = paths.some((p) => /@2x\.[^.]+$/i.test(p));
    }
    const instead = drawn && drawn.key !== r.key ? drawn.key : undefined;
    const parts = [
      r.value !== undefined ? `${r.key}: ${r.value}` : `${r.key} not set, looks up ${r.fallback}`,
      { "skin.ini": "found from skin.ini", default: "found under its default name", "built-in": "osu!'s built-in look", missing: "not found" }[r.source],
      instead ? `draws ${this.#keyLabel(instead)} instead` : "",
      frames > 1 ? `${frames} frames` : "",
      hd ? "@2x" : "",
      from ? `from ${from}` : "",
      managed ? "set here" : "",
    ].filter(Boolean);
    return { thumb, frames, hd, managed, instead, detail: parts.join(" · ") };
  }

  #slot(r: ManiaImageResolution, label: string, row: number, col: number) {
    const info = this.#slotInfo(r);
    const armed = this.#armed === r.key;
    const cell = h(
      "div",
      {
        class: `km-slot km-slot--${r.source === "skin.ini" ? "ini" : r.source === "built-in" ? "builtin" : r.source}${info.managed ? " km-slot--set" : ""}`,
        role: "gridcell",
        tabIndex: this.#cell[0] === row && this.#cell[1] === col ? 0 : -1,
        ariaLabel: `${label}: ${info.detail}`,
        ariaSelected: String(armed),
        title: info.detail,
      },
      h(
        "span",
        { class: "km-thumb" },
        info.thumb
          ? h("img", { src: info.thumb, alt: "", loading: "lazy", decoding: "async" })
          : h("span", { class: "km-thumb__none" }, r.drawn?.builtin ? "osu!" : "—"),
        info.frames > 1 ? h("span", { class: "km-badge" }, `×${info.frames}`) : null,
      ),
      h(
        "span",
        { class: "km-src" },
        info.instead ? `→ ${roleLabel(patternOf(info.instead)).toLowerCase()}` : SOURCE_TEXT[r.source],
        info.hd ? h("span", { class: "km-hd" }, " 2x") : null,
      ),
      info.managed || r.value !== undefined
        ? h(
            "button",
            {
              type: "button",
              class: "km-clear",
              tabIndex: -1,
              ariaLabel: `Clear ${label}`,
              title: "Clear (Delete): leave the key out so the default name is looked up",
              onclick: (event: MouseEvent) => {
                event.stopPropagation();
                this.#clear(r.key);
              },
            },
            "×",
          )
        : null,
    );
    cell.dataset.key = r.key;
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    cell.onclick = () => {
      this.#cell = [row, col];
      this.#arm(r.key);
      cell.focus();
    };
    this.#acceptDrop(cell, r.key);
    return cell;
  }

  #arm(key: string | null) {
    this.#armed = key;
    for (const cell of document.querySelectorAll<HTMLElement>(".km-slot"))
      cell.setAttribute("aria-selected", String(cell.dataset.key === key));
    for (const column of document.querySelectorAll<HTMLElement>(".km-column"))
      column.classList.toggle(
        "km-column--on",
        !!key && /^(Key|Note)Image/.test(key) && /\d+/.exec(key)?.[0] === column.dataset.col,
      );
    $("#km-for").textContent = key
      ? `For ${this.#keyLabel(key)}`
      : "Select a slot, then an image";
    this.#renderToolbar();
    this.#renderImages();
  }

  #renderGrid() {
    const grid = $("#km-grid");
    const hadFocus = grid.contains(document.activeElement);
    const keys = this.#keys;
    grid.style.setProperty("--km-cols", String(keys || 1));
    if (!keys) {
      grid.replaceChildren(h("p", { class: "v-empty" }, "Add a key count to edit its columns."));
      return;
    }
    const by = new Map(this.#resolved.map((r) => [r.key, r]));
    const rows: HTMLElement[] = [];
    const header = h(
      "div",
      { class: "km-row km-row--head", role: "row" },
      h("span", { class: "km-rowhead", role: "columnheader" }, "Column"),
      ...Array.from({ length: keys }, (_, c) =>
        h(
          "span",
          {
            class: "km-colhead",
            role: "columnheader",
            title: `Column ${c + 1}: default images mania-key${fallbackColumnIndex(keys, c)}, mania-note${fallbackColumnIndex(keys, c)}`,
          },
          String(c + 1),
          h("small", {}, fallbackColumnIndex(keys, c)),
        ),
      ),
    );
    rows.push(header);
    COLUMN_ROLES.forEach((role, row) => {
      rows.push(
        h(
          "div",
          { class: "km-row", role: "row" },
          h("span", { class: "km-rowhead", role: "rowheader" }, role.label),
          ...Array.from({ length: keys }, (_, c) =>
            this.#slot(by.get(columnKey(role.pattern, c))!, `Column ${c + 1} ${role.label.toLowerCase()}`, row, c),
          ),
        ),
      );
    });
    const valueRows = this.#valueRows(keys, COLUMN_ROLES.length);
    grid.replaceChildren(...rows, ...valueRows);
    if (hadFocus) this.#focusCell(grid);
  }

  /** Width, line width, colour and light colour per column. */
  #valueRows(keys: number, first: number) {
    const text = this.#host.mixText();
    const list = (key: string, length: number, fallback: string) => {
      const raw = maniaValue(text, keys, key)?.split(",") ?? [];
      return Array.from({ length }, (_, i) => raw[i]?.trim() || fallback);
    };
    const widths = list("ColumnWidth", keys, specOf("Mania", "ColumnWidth")?.default ?? "30");
    const lines = list("ColumnLineWidth", keys + 1, specOf("Mania", "ColumnLineWidth")?.default ?? "2");
    const setList = (key: string, values: string[], label: string) =>
      this.#change(label, (draft) => {
        draft.values[key] = values.join(",");
      });
    const number = (
      value: string,
      label: string,
      row: number,
      col: number,
      set: (value: string) => void,
    ) => {
      const input = h("input", {
        type: "number",
        min: "0",
        step: "1",
        value,
        class: "v-input km-num",
        ariaLabel: label,
        tabIndex: this.#cell[0] === row && this.#cell[1] === col ? 0 : -1,
      });
      input.onchange = () => {
        const n = Number(input.value);
        if (input.value === "" || !Number.isFinite(n) || n < 0) {
          this.#error(`${label}: a number of 0 or more`);
          input.value = value;
          return;
        }
        set(String(n));
      };
      return this.#valueCell(input, row, col);
    };
    const colour = (key: string, label: string, row: number, col: number, alpha: boolean) => {
      const current = maniaValue(text, keys, key);
      const fallback = specOf("Mania", key)?.default ?? "0,0,0";
      const input = h("input", {
        type: "color",
        value: toHex(current, fallback),
        class: "km-colour",
        ariaLabel: `${label}${current ? `: ${current}` : ` (default ${fallback})`}`,
        title: `${key}: ${current ?? `default ${fallback}`}`,
        tabIndex: this.#cell[0] === row && this.#cell[1] === col ? 0 : -1,
      });
      input.onchange = () =>
        this.#change(`Set ${label.toLowerCase()}`, (draft) => {
          draft.values[key] = fromHex(input.value, current, alpha);
        });
      return this.#valueCell(input, row, col);
    };
    const row = (label: string, index: number, cell: (c: number) => HTMLElement) =>
      h(
        "div",
        { class: "km-row km-row--values", role: "row" },
        h("span", { class: "km-rowhead", role: "rowheader" }, label),
        ...Array.from({ length: keys }, (_, c) => cell(c)),
      );
    return [
      row("Width", first, (c) =>
        number(widths[c], `Column ${c + 1} width`, first, c, (v) =>
          setList("ColumnWidth", widths.map((w, i) => (i === c ? v : w)), `Set column ${c + 1} width`),
        ),
      ),
      row("Line", first + 1, (c) =>
        number(lines[c], `Line left of column ${c + 1}`, first + 1, c, (v) =>
          setList("ColumnLineWidth", lines.map((w, i) => (i === c ? v : w)), `Set column ${c + 1} line`),
        ),
      ),
      row("Colour", first + 2, (c) =>
        colour(`Colour${c + 1}`, `Column ${c + 1} colour`, first + 2, c, true),
      ),
      row("Light", first + 3, (c) =>
        colour(`ColourLight${c + 1}`, `Column ${c + 1} light colour`, first + 3, c, false),
      ),
    ];
  }
  #valueCell(input: HTMLElement, row: number, col: number) {
    const cell = h("div", { class: "km-value", role: "gridcell" }, input);
    input.dataset.row = String(row);
    input.dataset.col = String(col);
    input.addEventListener("focus", () => (this.#cell = [row, col]));
    return cell;
  }

  /** Stage-wide images of the key count. */
  #renderShared() {
    const grid = $("#km-shared-grid");
    if (!this.#keys) {
      grid.replaceChildren();
      return;
    }
    const base = COLUMN_ROLES.length + 4;
    const lookups = this.#resolved.filter((r) => r.column === undefined);
    const cells = lookups.map((r, i) =>
      h("div", { class: "km-shared-item" }, h("span", { class: "km-shared-label" }, r.key), this.#slot(r, r.key, base, i)),
    );
    const arrow = maniaValue(this.#host.mixText(), this.#keys, "WarningArrow");
    grid.replaceChildren(
      ...cells,
      h(
        "p",
        { class: "km-note v-muted" },
        `WarningArrow${arrow ? `: ${arrow}` : ""}: decoded by osu!lazer but not drawn, so not editable here. The right edge line is ${
          maniaValue(this.#host.mixText(), this.#keys, "ColumnLineWidth")?.split(",")[this.#keys]?.trim() ?? "2"
        } wide (ColumnLineWidth).`,
      ),
    );
  }

  #focusCell(scope: HTMLElement = $("#keymodes-view")) {
    const [row, col] = this.#cell;
    scope
      .querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)
      ?.focus();
  }

  /** Arrows move between slots and fields; Enter picks; Delete clears. */
  #gridKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    const row = Number(target.dataset.row),
      col = Number(target.dataset.col);
    if (Number.isNaN(row)) return;
    const typing = target.tagName === "INPUT" && (target as HTMLInputElement).type === "number";
    const shared = row >= COLUMN_ROLES.length + 4;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (move && !(typing && (event.key === "ArrowUp" || event.key === "ArrowDown"))) {
      event.preventDefault();
      let [r, c] = shared ? [row, col + move[0] + move[1]] : [row + move[0], col + move[1]];
      const max = shared
        ? document.querySelectorAll("#km-shared-grid .km-slot").length - 1
        : this.#keys - 1;
      c = Math.max(0, Math.min(max, c));
      r = shared ? row : Math.max(0, Math.min(COLUMN_ROLES.length + 3, r));
      this.#cell = [r, c];
      for (const el of document.querySelectorAll<HTMLElement>("#keymodes-view [data-row]"))
        el.tabIndex = el.dataset.row === String(r) && el.dataset.col === String(c) ? 0 : -1;
      this.#focusCell();
      return;
    }
    const key = target.dataset.key;
    if (!key) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#arm(key);
      this.#focusTile(0) || $<HTMLInputElement>("#km-filter").focus();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.#clear(key);
    } else if (event.key === "Escape") {
      this.#arm(null);
    }
  }

  // ---- stage ----------------------------------------------------------------

  async #ensurePreview() {
    this.#previewLoading ??= this.#host
      .preview($<HTMLCanvasElement>("#km-canvas"), $("#km-stage"), (text) => {
        $("#km-preview-state").textContent = text;
      })
      .then(
        (preview) => (this.#preview = preview),
        (error) => {
          this.#previewLoading = undefined;
          $("#km-preview-state").textContent = String(error);
          return undefined;
        },
      );
    return this.#previewLoading;
  }

  #syncPreview() {
    const preview = this.#preview;
    if (!preview || !this.#visible) return;
    const drawn = DRAWN.includes(this.#keys);
    $("#km-stage").classList.toggle("km-stage--off", !drawn);
    if (!drawn) return;
    if (this.#playing) {
      preview.setStill(null);
      preview.setDemo(`mania-${this.#keys}k`);
      preview.setPlaying(true);
    } else preview.setStill(this.#keys);
    void preview.setSource(this.#host.previewSource());
  }

  #setPlaying(playing: boolean) {
    this.#playing = playing;
    this.#renderToolbar();
    this.#syncPreview();
  }

  /** Column targets over the drawn stage, placed with render-core's layout. */
  #renderColumns() {
    const layer = $("#km-columns");
    const stage = $("#km-stage");
    if (!this.#keys || !DRAWN.includes(this.#keys) || !this.#visible) {
      layer.replaceChildren();
      return;
    }
    const layout = maniaLayout(
      maniaConfig(readSkinIni(this.#host.mixText()), this.#keys),
      () => undefined,
    );
    const { clientWidth: w, clientHeight: hgt } = stage;
    // render-core's projection: 640 × 480 units fit and centred; the stage is
    // 480 units tall around the playfield centre (256, 192).
    const scale = Math.min(w / 640, hgt / 480);
    const x = (units: number) => w / 2 + ((units - layout.width / 2) / MANIA_SCALE) * scale;
    const pattern = this.#armed && /^(Key|Note)Image\d/.test(this.#armed)
      ? patternOf(this.#armed)
      : "NoteImage#";
    layer.replaceChildren(
      ...layout.columns.map((column, c) => {
        const target = h("button", {
          type: "button",
          class: "km-column",
          tabIndex: -1,
          ariaLabel: `Column ${c + 1}`,
          title: `Column ${c + 1}: click to select, drop an image to set its ${roleLabel(pattern).toLowerCase()}`,
          onclick: () => {
            const key = columnKey(pattern, c);
            this.#cell = [COLUMN_ROLES.findIndex((r) => r.pattern === pattern), c];
            this.#arm(key);
            this.#focusCell();
          },
        });
        target.dataset.col = String(c);
        target.style.left = `${x(column.x)}px`;
        target.style.width = `${(column.width / MANIA_SCALE) * scale}px`;
        target.style.top = `${hgt / 2 - 240 * scale}px`;
        target.style.height = `${480 * scale}px`;
        target.classList.toggle(
          "km-column--on",
          !!this.#armed && /\d+/.exec(this.#armed)?.[0] === String(c) && /^(Key|Note)Image/.test(this.#armed),
        );
        this.#acceptDrop(target, () => columnKey(
          this.#armed && /^(Key|Note)Image\d/.test(this.#armed) ? patternOf(this.#armed) : "NoteImage#",
          c,
        ));
        return target;
      }),
    );
  }

  // ---- drops ------------------------------------------------------------------

  #acceptDrop(target: HTMLElement, key: string | (() => string)) {
    const keyOf = () => (typeof key === "string" ? key : key());
    target.addEventListener("dragover", (event) => {
      const types = event.dataTransfer?.types ?? [];
      if (!types.includes(DRAG_TYPE) && !types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      target.classList.add("km-drop");
    });
    target.addEventListener("dragleave", () => target.classList.remove("km-drop"));
    target.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove("km-drop");
      const data = event.dataTransfer;
      if (!data) return;
      const k = keyOf();
      if (data.types.includes(DRAG_TYPE) && this.#dragged) {
        const { unit, source } = this.#dragged;
        this.#dragged = null;
        this.#assign(k, this.#slotFor(unit, source), `Set ${this.#keyLabel(k)}`);
        return;
      }
      if (data.files.length) void this.#dropFiles(k, [...data.files]);
    });
  }

  #acceptFiles(
    target: HTMLElement,
    onImages: (images: DroppedImage[], files: File[]) => Promise<void>,
  ) {
    target.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      target.classList.add("km-drop");
    });
    target.addEventListener("dragleave", () => target.classList.remove("km-drop"));
    target.addEventListener("drop", async (event) => {
      target.classList.remove("km-drop");
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      const images = await this.#check(files);
      if (images) await onImages(images, files);
    });
  }

  /** Validates dropped files; reports problems inline; undefined if nothing usable. */
  async #check(files: File[]): Promise<DroppedImage[] | undefined> {
    if (!this.#host.canWrite()) {
      this.#error("Read-only tab: open Skin studio from the dashboard to add files.");
      return undefined;
    }
    const dropped = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        size: file.size,
        head: new Uint8Array(await file.slice(0, 16).arrayBuffer()),
      })),
    );
    const { images, errors } = checkDrop(dropped);
    this.#error(errors.length ? `Not added: ${errors.join("; ")}` : "");
    return images.length ? images : undefined;
  }

  async #dropFiles(key: string, files: File[]) {
    const images = await this.#check(files);
    if (!images) return;
    if (images.length > 1) {
      this.#error(
        `Drop one image per slot (with its @2x and frames); got ${images.map((i) => i.name).join(", ")}. Drop several on the image list instead.`,
      );
      return;
    }
    const [slot] = await this.#uploadImages(images, files);
    if (slot) this.#assign(key, slot, `Set ${this.#keyLabel(key)} from ${slot.name}`);
  }

  /** Sends dropped images to the service; the slots that name them. */
  async #uploadImages(images: DroppedImage[], files: File[]): Promise<SlotImage[]> {
    const used = images.flatMap((i) => i.files.map((f) => files[f.index]));
    try {
      const group = await groupOf(used);
      const slots: SlotImage[] = [];
      for (const image of images) {
        const stored: SlotImage["files"] = [];
        for (const file of image.files)
          stored.push({
            from: await this.#host.upload(group, file.name, files[file.index]),
            suffix: file.suffix,
          });
        slots.push({ skin: UPLOADS, name: image.name, files: stored });
      }
      this.#state(`Added ${slots.map((s) => s.name).join(", ")} to dropped files`);
      return slots;
    } catch (error) {
      this.#error(`Not added: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ---- bulk -------------------------------------------------------------------

  #applyToAll() {
    const key = this.#armed;
    if (!key || !/^(Key|Note)Image\d/.test(key)) return;
    const pattern = patternOf(key);
    const from = Number(/\d+/.exec(key)![0]);
    this.#change(`Apply ${roleLabel(pattern).toLowerCase()} to all columns`, (draft) =>
      Object.assign(draft.images, applyToAll(this.#keys, pattern, from, this.#current)),
    );
  }

  #renderCopy() {
    const skin = $<HTMLSelectElement>("#km-copy-skin");
    const value = skin.value || MIX;
    skin.replaceChildren(
      h("option", { value: MIX }, "This mix"),
      ...this.#host
        .sources()
        .map((s) => h("option", { value: s.key }, `${s.name} · ${s.group}`)),
    );
    skin.value = [...skin.options].some((o) => o.value === value) ? value : MIX;
    $<HTMLButtonElement>("#km-copy-go").disabled = !this.#host.canWrite() || !this.#keys;
    void this.#copyCounts();
  }
  async #copyCounts() {
    const skin = $<HTMLSelectElement>("#km-copy-skin").value || MIX;
    const select = $<HTMLSelectElement>("#km-copy-keys");
    const text = skin === MIX ? this.#host.mixText() : (await this.#host.load(skin)).text;
    const counts = maniaKeyCounts(parse(text)).filter(
      (k) => DRAWN.includes(k) && !(skin === MIX && k === this.#keys),
    );
    const previous = select.value;
    select.replaceChildren(
      ...counts.map((k) => h("option", { value: String(k) }, `${k}K`)),
    );
    if (counts.map(String).includes(previous)) select.value = previous;
    else if (counts.includes(this.#keys)) select.value = String(this.#keys);
    select.disabled = !counts.length;
    $<HTMLButtonElement>("#km-copy-go").disabled =
      !counts.length || !this.#host.canWrite() || !this.#keys;
  }
  async #copy() {
    const skin = $<HTMLSelectElement>("#km-copy-skin").value || MIX;
    const from = Number($<HTMLSelectElement>("#km-copy-keys").value);
    if (!from || !this.#keys) return;
    const keys = this.#keys;
    let image: (key: string) => Slot, value: (key: string) => string | undefined;
    if (skin === MIX) {
      const text = this.#host.mixText();
      const resolved = new Map(
        stageImages(text, [...this.#host.mixFiles().keys()], from).map((r) => [r.key, r]),
      );
      const draft = this.#host.drafts()[String(from)];
      image = (key) => {
        if (draft && key in draft.images) return clone(draft.images[key]);
        const r = resolved.get(key);
        return r?.drawn && !r.drawn.builtin && r.drawn.key === key
          ? { value: r.value ?? r.name }
          : null;
      };
      value = (key) => maniaValue(text, from, key);
    } else {
      const source = await this.#host.load(skin);
      const resolved = new Map(stageImages(source.text, source.files, from).map((r) => [r.key, r]));
      image = (key) => {
        const r = resolved.get(key);
        if (!r?.drawn || r.drawn.builtin || r.drawn.key !== key) return null;
        const files = imageUnit(source.files, r.drawn.name);
        if (!files.length) return null;
        return { skin, name: files[0].from.replace(/\\/g, "/").slice(0, r.drawn.name.length), files };
      };
      value = (key) => maniaValue(source.text, from, key);
    }
    const copied = copyStage(keys, from, image, value);
    const map = remapColumns(keys, from).map((c) => c + 1);
    const name = skin === MIX ? "this mix" : this.#host.skinName(skin);
    this.#change(`Copy ${from}K from ${name}`, (draft) => {
      Object.assign(draft.images, copied.images);
      Object.assign(draft.values, copied.values);
    });
    if (from !== keys)
      this.#state(
        `Copied ${from}K from ${name} into ${keys}K: columns take ${map.join(", ")} (same column kind 1/2/S, nearest position)`,
      );
  }

  // ---- picker -------------------------------------------------------------------

  #renderSources() {
    const select = $<HTMLSelectElement>("#km-source");
    const groups = new Map<string, PickerSource[]>();
    for (const s of this.#host.sources()) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
    select.replaceChildren(
      h("option", { value: MIX }, "Mix draft"),
      h("option", { value: UPLOADS }, "Dropped files"),
      ...[...groups].map(([group, list]) => {
        const optgroup = h("optgroup", { label: group });
        optgroup.append(...list.map((s) => h("option", { value: s.key }, s.name)));
        return optgroup;
      }),
    );
    select.value = this.#source;
  }

  async #openSource(key: string) {
    this.#source = key;
    this.#renderSources();
    const ticket = ++this.#loadingSource;
    // Picker names (the mix's output paths, a skin's own paths) → the file shown.
    let entries: [string, { skin: string; file: string }][];
    let text: string;
    if (key === MIX) {
      entries = [...this.#host.mixFiles().values()].map((f) => [
        f.to,
        { skin: f.skin, file: f.from },
      ]);
      text = this.#host.mixText();
    } else {
      try {
        $("#km-images").replaceChildren(h("p", { class: "v-empty" }, "Reading…"));
        const loaded = await this.#host.load(key);
        if (ticket !== this.#loadingSource) return;
        entries = loaded.files.map((file) => [file, { skin: key, file }]);
        text = loaded.text;
      } catch (error) {
        if (ticket !== this.#loadingSource) return;
        $("#km-images").replaceChildren(
          h("p", { class: "v-empty" }, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }
    this.#units = this.#unitsOf(
      entries.map(([name]) => name),
      new Map(entries),
    );
    this.#sourceRoles = this.#rolesOf(text);
    this.#renderImages();
  }

  /** Images of a file list, each with its @2x and frames. */
  #unitsOf(names: string[], where: Map<string, { skin: string; file: string }>): Unit[] {
    const index = imageIndex(names);
    const seen = new Set<string>();
    const units: Unit[] = [];
    for (const [lower, files] of index) {
      const frame = /^(.*)-(\d+)$/.exec(lower);
      const base = frame && index.has(`${frame[1]}-0`) ? frame[1] : lower;
      if (seen.has(base)) continue;
      seen.add(base);
      const sample = (index.get(base) ?? index.get(`${base}-0`) ?? files)[0];
      const name = sample.replace(/\\/g, "/").slice(0, base.length);
      const unit = imageUnit(names, name);
      const thumbFile =
        unit.find((f) => !/@2x/i.test(f.suffix))?.from ?? unit[0].from;
      units.push({
        name,
        files: unit,
        frames: frameNames(index, name).length,
        hd: unit.some((f) => /@2x/i.test(f.suffix)),
        thumb: where.get(thumbFile)!,
      });
    }
    return units.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Names a skin.ini gives each role in any of its `[Mania]` blocks. */
  #rolesOf(text: string) {
    const roles = new Map<string, Set<string>>();
    for (const line of parse(text).lines) {
      if (line.section !== "Mania" || !line.key || !line.value) continue;
      if (specOf("Mania", line.key)?.type !== "image") continue;
      const role = /^(Key|Note)Image\d/.test(line.key) ? patternOf(line.key) : line.key.replace(/^Hit.*/, "Hit");
      const value = line.value.split("//")[0].trim().replace(/\\/g, "/").replace(/\.png$/i, "").replace(/@2x$/i, "").toLowerCase();
      roles.set(role, (roles.get(role) ?? new Set()).add(value));
    }
    return roles;
  }

  #slotFor(unit: Unit, source: string): Slot {
    if (source === MIX) return { value: unit.name };
    return { skin: source, name: unit.name, files: unit.files };
  }

  #renderImages() {
    const list = $("#km-images");
    const pattern = this.#armed
      ? /^(Key|Note)Image\d/.test(this.#armed)
        ? patternOf(this.#armed)
        : this.#armed.replace(/^Hit.*/, "Hit")
      : null;
    const own = pattern ? (this.#sourceRoles.get(pattern) ?? new Set()) : new Set<string>();
    const hint = pattern ? hintFor(pattern) : null;
    const shown = this.#units.filter((u) => !this.#filter || u.name.toLowerCase().includes(this.#filter));
    const rank = (u: Unit) => (own.has(u.name.toLowerCase()) ? 0 : hint?.test(u.name) ? 1 : 2);
    const sections: [string, Unit[]][] = pattern
      ? [
          [`Used as ${roleLabel(pattern).toLowerCase()} in this skin`, shown.filter((u) => rank(u) === 0)],
          ["Names that match", shown.filter((u) => rank(u) === 1)],
          ["Other images", shown.filter((u) => rank(u) === 2)],
        ]
      : [["Images", shown]];
    const nodes: Node[] = [];
    let index = 0;
    for (const [title, units] of sections) {
      if (!units.length) continue;
      nodes.push(h("p", { class: "v-label km-images__head" }, title, h("span", {}, String(units.length))));
      for (const unit of units.slice(0, 400)) nodes.push(this.#tile(unit, index++));
    }
    if (!nodes.length)
      nodes.push(
        h(
          "p",
          { class: "v-empty" },
          this.#source === UPLOADS
            ? "Drop PNG or JPEG files here to add them."
            : this.#filter
              ? "No image matches."
              : "No images in this source.",
        ),
      );
    list.replaceChildren(...nodes);
  }

  #tile(unit: Unit, index: number) {
    const meta = [unit.hd ? "@2x" : "", unit.frames > 1 ? `${unit.frames} frames` : ""].filter(Boolean).join(" · ");
    const tile = h(
      "div",
      {
        class: "km-tile",
        role: "option",
        tabIndex: index === 0 ? 0 : -1,
        draggable: true,
        title: `${unit.name}${meta ? ` · ${meta}` : ""}`,
        ariaLabel: `${unit.name}${meta ? `, ${meta}` : ""}`,
      },
      h(
        "span",
        { class: "km-thumb" },
        h("img", { src: this.#host.assetUrl(unit.thumb.skin, unit.thumb.file), alt: "", loading: "lazy", decoding: "async" }),
      ),
      h("span", { class: "km-tile__name" }, unit.name),
      h("span", { class: "km-tile__meta" }, meta),
    );
    tile.dataset.index = String(index);
    tile.onclick = () => this.#pick(unit);
    tile.ondragstart = (event) => {
      this.#dragged = { unit, source: this.#source };
      event.dataTransfer!.setData(DRAG_TYPE, unit.name);
      event.dataTransfer!.setData("text/plain", unit.name);
      event.dataTransfer!.effectAllowed = "copy";
      tile.classList.add("km-tile--drag");
    };
    tile.ondragend = () => {
      tile.classList.remove("km-tile--drag");
      setTimeout(() => (this.#dragged = null));
    };
    return tile;
  }

  #pick(unit: Unit) {
    const key = this.#armed;
    if (!key) {
      this.#error("Select a slot first (click it, or Enter on it), then an image.");
      return;
    }
    this.#assign(key, this.#slotFor(unit, this.#source), `Set ${this.#keyLabel(key)} to ${unit.name}`);
    requestAnimationFrame(() => this.#focusCell());
  }

  #focusTile(index: number) {
    const tiles = [...document.querySelectorAll<HTMLElement>("#km-images .km-tile")];
    const tile = tiles[Math.max(0, Math.min(tiles.length - 1, index))];
    if (!tile) return false;
    for (const t of tiles) t.tabIndex = t === tile ? 0 : -1;
    tile.focus();
    tile.scrollIntoView({ block: "nearest" });
    return true;
  }
  #tileKey(event: KeyboardEvent) {
    const tile = (event.target as HTMLElement).closest<HTMLElement>(".km-tile");
    if (!tile) return;
    const index = Number(tile.dataset.index);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (step) {
      event.preventDefault();
      if (index + step < 0) $<HTMLInputElement>("#km-filter").focus();
      else this.#focusTile(index + step);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      tile.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.#focusCell();
    }
  }
}
