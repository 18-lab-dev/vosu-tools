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
  applyToAll,
  assignSlots,
  assignImageSlots,
  applyStageCopy,
  columnKey,
  copyStage,
  defaultPattern,
  imageUnit,
  mirror,
  patternOf,
  remapColumns,
  resetStageGeometry,
  stageImages,
  stageStatus,
  type KeymodeDraft,
  type Keymodes,
  type Slot,
  type SlotImage,
} from "./keymodes";
import { frameNames, imageIndex, lookupFiles } from "./mania";
import { UPLOADS, checkDrop, type DroppedImage } from "./uploads";
import { HitPanel, type HitHost } from "./hit-panel";
import { nameParts, roleOrder } from "./picker";
import { missingSources, recoverSource, sourceFileNames, sourceSlots, type Recovery } from "./missing-sources";
import { MANIA_COLUMNS, MANIA_FIELDS, columnKey as formKey, setListEntry, type ColumnField, type Field } from "./mania-form";
import type { Preview, PreviewSource } from "./preview";
import {
  NONE,
  all as allRow,
  columnsText,
  extend as extendRow,
  isSelected,
  range as rangeRow,
  single as singleRow,
  toggle as toggleRow,
  targets as rowTargets,
  type RowSelection,
} from "./value-selection";
import {
  EMPTY,
  all,
  extend,
  range,
  single,
  toggle,
  type Cell,
  type Selection,
  type Shape,
} from "./selection";

/** Key counts render-core draws (dual stages above 10K are not previewed). */
const DRAWN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DUAL = [12, 14, 16, 18];
const MIX = "mix:";
/** The `data-row` of stage-wide image slots (after the column roles and 4 value rows). */
const SHARED_ROW = COLUMN_ROLES.length + 4;
const DRAG_TYPE = "application/x-skin-studio-image";
/**
 * An image as the user knows it: its file name (`drop-note.png`), without
 * the folder (dropped files sit in a folder per drop) or a frame number.
 */
export const shownName = (name: string, files: readonly { from: string }[]) =>
  `${name.split("/").pop()}${/\.[^./]+$/.exec(files[0]?.from ?? "")?.[0] ?? ""}`;

export interface PickerSource {
  key: string;
  name: string;
  contentHash?: string;
  creator?: string;
  fileCount?: number;
  group: string;
}
export interface KeymodesHost {
  /** The recipe's drafts (live object). */
  drafts(): Keymodes;
  generation(keys: number): number;
  /** The mix draft's skin.ini as the editor holds it. */
  mixText(): string;
  /** The mix's files: lower-cased output path → where it is copied from. */
  mixFiles(): Map<string, { skin: string; from: string; to: string }>;
  sources(): PickerSource[];
  refreshSources?(): Promise<unknown>;
  load(key: string): Promise<{ text: string; files: string[] }>;
  /** Source chosen for this stage group, otherwise the mix base. */
  originalStage(keys: number): string | null;
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
  derive: HitHost["derive"];
  rows: HitHost["rows"];
  lastPlay: HitHost["lastPlay"];
  speed: HitHost["speed"];
  setSpeed: HitHost["setSpeed"];
  /** Commits these key counts as one whole-recipe undo step. */
  edit(label: string, changes: Record<string, KeymodeDraft | undefined>): void;
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

interface EditingInput {
  input: HTMLInputElement;
  label: string;
  value: string;
  dirty: boolean;
}

export class KeymodesView {
  #host: KeymodesHost;
  #keys = 0;
  #preservedInputs = new WeakSet<HTMLInputElement>();
  /** The slot the picker assigns to (an image key of the shown key count). */
  #armed: string | null = null;
  /** Selected slots (the armed one included); actions apply to all of them. */
  #selection: Selection = EMPTY;
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
  #hit: HitPanel;
  /** Selected columns of one value row (widths, colours, the form's per-column fields). */
  #rows: RowSelection = NONE;
  /** The value cell focused last; Apply to all columns copies it while it is the last focus. */
  #valueFocus: { row: string; col: number } | null = null;
  #lastFocus: "slot" | "value" = "slot";
  /** Per value row: its name, length, an edit of some columns, a copy of one column to all. */
  #valueSpecs = new Map<
    string,
    { label: string; length: number; apply(cols: number[], value: string | null): void; copy(from: number): void }
  >();

  constructor(host: KeymodesHost) {
    this.#host = host;
    this.#hit = new HitPanel({
      keys: () => this.#keys,
      mixText: () => host.mixText(),
      mixFiles: () => host.mixFiles(),
      mixIndex: () => this.#mixIndex,
      resolved: () => this.#resolved,
      draft: (keys) => this.#draft(keys),
      generation: (keys) => host.generation(keys),
      change: (label, mutate, keys) => this.#change(label, mutate, keys),
      beforeGeometry: async () => {
        await host.refreshSources?.();
        const missing = missingSources(host.drafts(), new Set(host.sources().map((s) => s.key)));
        this.#renderMissing();
        if (missing.length) {
          this.#error("Resolve the missing source above before changing geometry.");
          return false;
        }
        if (this.#hit.needsOriginalStageReset) {
          this.#error("Stale originals replaced this stage's images. Reset geometry from original stage before changing geometry.");
          return false;
        }
        return true;
      },
      derive: host.derive,
      rows: host.rows,
      lastPlay: host.lastPlay,
      speed: host.speed,
      setSpeed: host.setSpeed,
      canWrite: () => host.canWrite(),
      state: (text) => this.#state(text),
      error: (text) => this.#error(text),
    });
    $("#km-all").onclick = () => this.#applyToAll();
    $("#km-mirror").onclick = () =>
      this.#change("Mirror", (draft) =>
        assignImageSlots(draft, mirror(this.#keys, this.#current)),
      );
    $("#km-pattern").onclick = () =>
      this.#change("osu! column pattern", (draft) =>
        assignImageSlots(draft, defaultPattern(this.#keys, this.#current)),
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
    new ResizeObserver(() => this.#renderColumns()).observe($("#km-stage"));
    // Column tools closes when the user acts anywhere else.
    document.addEventListener("click", (event) => {
      const menu = document.querySelector<HTMLDetailsElement>("#keymodes-view details.km-copy-menu[open]");
      if (menu && !menu.contains(event.target as Node)) menu.open = false;
    });
  }

  // ---- state --------------------------------------------------------------

  /** Key counts shown: the mix's `[Mania]` blocks plus added ones. */
  #counts(): number[] {
    const counts = new Set(maniaKeyCounts(parse(this.#host.mixText())));
    for (const key of Object.keys(this.#host.drafts())) counts.add(Number(key));
    return [...counts].filter((k) => k > 0).sort((a, b) => a - b);
  }
  #draft(keys = this.#keys): KeymodeDraft | undefined {
    return this.#host.drafts()[String(keys)];
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
    this.#renderMissing();
    const before = clone(this.#host.drafts()[String(keys)]);
    const remember = (draft: KeymodeDraft) => {
      for (const refs of sourceSlots(draft).values())
        for (const slot of refs) {
          slot.sourceName ??= this.#host.skinName(slot.skin);
          slot.sourceHash ??= this.#host.sources().find((s) => s.key === slot.skin)?.contentHash;
        }
    };
    const after = clone(before) ?? emptyDraft();
    mutate(after);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    remember(after);
    this.#host.edit(label, { [String(keys)]: after });
    this.#error("");
    this.#state(label);
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
    this.#change(label, (draft) => assignSlots(draft, [key], slot));
  }
  #clear(key: string) {
    this.#assign(key, null, `Clear ${this.#keyLabel(key)}`);
  }
  /** One image for several slots, as one undo step. */
  #assignMany(keys: string[], slot: Slot, what: string) {
    if (keys.length === 1) return this.#assign(keys[0], slot, `Set ${this.#keyLabel(keys[0])} to ${what}`);
    const label = `Set ${keys.length} slots to ${what}`;
    this.#change(label, (draft) => assignSlots(draft, keys, slot));
    const roles = [...new Set(keys.map((k) => this.#roleOf(k)))];
    if (roles.length > 1) this.#state(`${label}: one image for different roles (${roles.join(", ")})`);
  }
  #clearMany(keys: string[]) {
    if (keys.length === 1) return this.#clear(keys[0]);
    this.#change(`Clear ${keys.length} slots`, (draft) => assignSlots(draft, keys, null));
  }
  #roleOf(key: string) {
    return /^(KeyImage|NoteImage)\d/.test(key) ? roleLabel(patternOf(key)).toLowerCase() : key;
  }
  /** The slots an action applies to: the selection. */
  #targets(): string[] {
    return this.#selection.keys.length ? [...this.#selection.keys] : this.#armed ? [this.#armed] : [];
  }
  /** The slots a drop on `key` applies to: the selection when `key` is in it. */
  #dropTargets(key: string): string[] {
    return this.#selection.keys.includes(key) ? this.#targets() : [key];
  }
  #shape(): Shape {
    const slot = (r: number, c: number) =>
      document.querySelector<HTMLElement>(`#keymodes-view .km-slot[data-row="${r}"][data-col="${c}"]`);
    return {
      keyAt: (r, c) => slot(r, c)?.dataset.key,
      region: (row) => (row < COLUMN_ROLES.length ? 0 : row === SHARED_ROW ? 1 : -1),
      cells: (region) =>
        region < 0
          ? []
          : [...document.querySelectorAll<HTMLElement>(region === 0 ? "#km-grid .km-slot" : "#km-shared-grid .km-slot")].map(
              (el) => [Number(el.dataset.row), Number(el.dataset.col)] as const,
            ),
    };
  }
  #cellOf(key: string): Cell | null {
    const el = document.querySelector<HTMLElement>(`#keymodes-view .km-slot[data-key="${key}"]`);
    return el ? [Number(el.dataset.row), Number(el.dataset.col)] : null;
  }
  #setSelection(selection: Selection) {
    this.#selection = selection;
    if (selection.keys.length) {
      this.#lastFocus = "slot";
      if (this.#rows.cols.length) this.#setRows(NONE);
    }
    const focus = selection.focus && this.#shape().keyAt(...selection.focus);
    this.#armed = focus && selection.keys.includes(focus) ? focus : (selection.keys.at(-1) ?? null);
    this.#renderSelection();
  }
  /**
   * The selected slots for other screens: the Explorer button's label
   * (`Use as 7K column 3 note`, `Use for 7 slots`) and what they are.
   */
  target(): { label: string; slots: string } | null {
    const keys = this.#targets();
    if (!keys.length || !this.#keys) return null;
    const slots =
      keys.length === 1 ? `${this.#keys}K ${this.#keyLabel(keys[0])}` : `${keys.length} ${this.#keys}K slots`;
    return { label: keys.length === 1 ? `Use as ${slots}` : `Use for ${keys.length} slots`, slots };
  }
  /** Sets the selected slots to image `name` of library skin `skin` (from the Explorer). */
  async assign(skin: string, name: string) {
    const keys = this.#targets();
    if (keys.length) await this.#assignImage(keys, skin, name);
  }

  // ---- keyboard shortcuts of the screen (dispatched by the studio) ---------

  /** Shows the previous (-1) or next (1) key count that has a stage. */
  stepCount(step: -1 | 1) {
    const counts = this.#counts().filter((k) => DRAWN.includes(k));
    const next = counts[counts.indexOf(this.#keys) + step];
    if (next === undefined) return;
    this.#select(next);
    this.#state(`${next}K`);
  }
  /** Clears the selected slots (one undo step); false when none is selected. */
  clearSelected(): boolean {
    const keys = this.#targets();
    if (!keys.length || !this.#keys) return false;
    this.#clearMany(keys);
    return true;
  }
  /** Drops the slot or value selection; false when there was none. */
  clearSelection(): boolean {
    if (this.#rows.cols.length) {
      this.#setRows(NONE);
      return true;
    }
    if (!this.#selection.keys.length && !this.#armed) return false;
    this.#arm(null);
    return true;
  }
  focusFilter() {
    const filter = $<HTMLInputElement>("#km-filter");
    filter.focus();
    filter.select();
  }
  /** Starts a drag of image `name` of `skin` that slots and stage columns accept. */
  drag(data: DataTransfer, skin: string, name: string) {
    this.#dragged = null;
    data.setData(DRAG_TYPE, JSON.stringify({ skin, name }));
    data.setData("text/plain", name);
    data.effectAllowed = "copy";
  }
  async #assignImage(keys: string[], skin: string, name: string) {
    try {
      const { files } = await this.#host.load(skin);
      const unit = imageUnit(files, name);
      if (!unit.length) throw new Error(`${name} is not an image of ${this.#host.skinName(skin)}`);
      const exact = unit[0].from.replace(/\\/g, "/").slice(0, name.length);
      this.#assignMany(
        keys,
        { skin, name: exact, files: unit },
        `${shownName(exact, unit)} from ${this.#host.skinName(skin)}`,
      );
    } catch (error) {
      this.#error(error instanceof Error ? error.message : String(error));
    }
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
    this.#renderMissing();
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
    this.#renderSettings();
    this.#hit.render();
    this.#hit.warm();
    this.#renderColumns();
    this.#renderCopy();
    this.#syncPreview();
    if (this.#source === MIX) void this.#openSource(MIX);
    else this.#renderSources();
  }

  #select(keys: number) {
    if (keys === this.#keys) return;
    this.#keys = keys;
    this.#rows = NONE;
    this.#valueFocus = null;
    this.#armed = null;
    this.#selection = EMPTY;
    this.#cell = [0, 0];
    this.refresh();
    $(".km-sheet").scrollTop = 0;
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
      h("option", { value: "" }, "+ Key count"),
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
    document.getElementById("km-reset-geometry")?.remove();
    if (this.#hit.needsOriginalStageReset && this.#host.originalStage(this.#keys))
      $(".km-copy-menu").insertAdjacentElement("beforebegin", h("button", {
        id: "km-reset-geometry", type: "button", class: "v-btn v-btn--sm", disabled: !write,
        title: "Restore the original stage's images, column widths and HitPosition for this key count. Other key counts stay unchanged. Undo restores this draft.",
        onclick: () => void this.#resetGeometry(),
      }, "Reset geometry from original stage"));
    const all = $<HTMLButtonElement>("#km-all");
    const value = this.#lastFocus === "value" && this.#valueFocus ? this.#valueSpecs.get(this.#valueFocus.row) : undefined;
    const armed = this.#armed && /\d/.test(this.#armed) && /^(Key|Note)Image/.test(this.#armed);
    all.disabled = !write || !(value || armed);
    all.textContent = value
      ? `Apply ${value.label} to all columns`
      : armed
        ? `Apply ${roleLabel(patternOf(this.#armed!)).toLowerCase()} to all columns`
        : "Apply to all columns";
    all.title = value
      ? `Copies column ${this.#valueFocus!.col + 1}'s ${value.label} to every column`
      : armed
        ? ""
        : "Select a column slot or value first";
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
    const armed = this.#selection.keys.includes(r.key);
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
    cell.onclick = (event: MouseEvent) => {
      const at: Cell = [row, col];
      this.#cell = [row, col];
      const shape = this.#shape();
      this.#setSelection(
        event.shiftKey
          ? range(this.#selection, shape, at)
          : event.ctrlKey || event.metaKey
            ? toggle(this.#selection, shape, at)
            : single(shape, at),
      );
      for (const el of document.querySelectorAll<HTMLElement>("#keymodes-view [data-row]"))
        el.tabIndex = el === cell ? 0 : -1;
      cell.focus({ preventScroll: true });
    };
    this.#acceptDrop(cell, r.key);
    return cell;
  }

  /** Selects one slot (null: none). */
  #arm(key: string | null) {
    const cell = key ? this.#cellOf(key) : null;
    this.#setSelection(key ? { keys: [key], anchor: cell, focus: cell } : EMPTY);
  }
  #renderSelection() {
    const selected = new Set(this.#selection.keys);
    const key = this.#armed;
    for (const cell of document.querySelectorAll<HTMLElement>(".km-slot"))
      cell.setAttribute("aria-selected", String(selected.has(cell.dataset.key ?? "")));
    const columns = new Set(
      [...selected].filter((k) => /^(Key|Note)Image\d/.test(k)).map((k) => /\d+/.exec(k)![0]),
    );
    for (const column of document.querySelectorAll<HTMLElement>(".km-column"))
      column.classList.toggle("km-column--on", columns.has(column.dataset.col ?? ""));
    const roles = [...new Set([...selected].map((k) => this.#roleOf(k)))];
    $("#km-for").textContent =
      selected.size > 1
        ? `For ${selected.size} slots${roles.length > 1 ? ` (${roles.join(", ")})` : ""}`
        : key
          ? `For ${this.#keyLabel(key)}`
          : "Select a slot, then an image";
    this.#renderToolbar();
    this.#renderImages();
  }

  /** Keep the real focused control: number-input selection cannot be restored. */
  #editing(root: HTMLElement): EditingInput | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !root.contains(active) || root.dataset.keymode !== String(this.#keys)) return null;
    const label = active.getAttribute("aria-label");
    return label ? { input: active, label, value: active.value, dirty: active.value !== active.defaultValue } : null;
  }
  #keepEditing(root: HTMLElement, editing: EditingInput | null) {
    if (!editing || root.contains(editing.input) || !editing.dirty) return;
    const input = root.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(editing.label)}"]`);
    if (!input) return;
    input.focus({ preventScroll: true });
    input.value = editing.value;
    // A value set from code may not count as the user's for the browser's
    // own change event: commit it on blur or Enter unless that event came.
    let fired = false;
    input.addEventListener("change", () => (fired = true), { once: true });
    const commit = () => {
      if (!fired && input.isConnected && input.value !== input.defaultValue) {
        fired = true;
        input.dispatchEvent(new Event("change"));
      }
    };
    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") setTimeout(commit);
    });
  }

  /**
   * Repaint siblings around the focused input and its ancestor chain, never
   * disconnecting that chain. Replacing then refocusing loses native selection
   * (and can commit a partial value on blur), even if its text is put back.
   */
  #replaceChildren(root: HTMLElement, children: HTMLElement[], editing: EditingInput | null) {
    const input = editing?.input;
    if (!editing || !input || (input.type !== "number" && input.type !== "text" && input.type !== "search")) {
      root.replaceChildren(...children);
      return;
    }
    const fresh = h("div", {}, ...children);
    let current: HTMLElement | null = input;
    const replacement = fresh.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(editing.label)}"]`);
    let next: HTMLElement | null = replacement;
    const path: { current: HTMLElement; next: HTMLElement }[] = [];
    while (current && next) {
      path.push({ current, next });
      if (current === root || next === fresh) break;
      current = current.parentElement;
      next = next.parentElement;
    }
    const last = path.at(-1);
    if (replacement?.type !== input.type || last?.current !== root || last.next !== fresh || path.some((pair) => pair.current.tagName !== pair.next.tagName)) {
      root.replaceChildren(...children);
      return;
    }
    // Change handlers use event.currentTarget, so the retained control can use
    // the fresh model-bound handler without reading a detached replacement.
    input.onchange = replacement.onchange;
    for (const pair of path.slice(0, -1)) {
      for (const attr of Array.from(pair.current.attributes))
        if (!(pair.current === input && attr.name === "value") && !pair.next.hasAttribute(attr.name))
          pair.current.removeAttribute(attr.name);
      for (const attr of Array.from(pair.next.attributes))
        if (!(pair.current === input && attr.name === "value") && pair.current.getAttribute(attr.name) !== attr.value)
          pair.current.setAttribute(attr.name, attr.value);
    }
    for (let i = 1; i < path.length; i++) {
      const parent = path[i].current, kept = path[i - 1].current;
      const siblings = Array.from(path[i].next.childNodes);
      const at = siblings.indexOf(path[i - 1].next);
      for (const child of Array.from(parent.childNodes)) if (child !== kept) child.remove();
      for (const [index, child] of siblings.entries())
        if (index < at) parent.insertBefore(child, kept);
        else if (index > at) parent.appendChild(child);
    }
    // A focused field can intentionally show unfinished text rather than an
    // incoming model update. Once focus leaves, show the current model again.
    if (!this.#preservedInputs.has(input)) {
      this.#preservedInputs.add(input);
      input.addEventListener("blur", () => {
        this.#preservedInputs.delete(input);
        setTimeout(() => { if (this.#visible) this.refresh(); });
      }, { once: true });
    }
  }

  #renderGrid() {
    const grid = $("#km-grid");
    const hadFocus = grid.contains(document.activeElement);
    const editing = this.#editing(grid);
    const keys = this.#keys;
    grid.style.setProperty("--km-cols", String(keys || 1));
    if (!keys) {
      grid.replaceChildren(h("p", { class: "v-empty" }, "No key counts yet: add one with + Key count."));
      grid.dataset.keymode = String(keys);
      return;
    }
    const by = new Map(this.#resolved.map((r) => [r.key, r]));
    const rows: HTMLElement[] = [];
    const legendTip =
      "Under each image, where the client finds it: ini, named in skin.ini; default, found under osu!'s default name; built-in, osu!'s own look; missing, nothing is drawn; → note, a hold head or tail draws another piece. 2x: an @2x image exists; ×N: animation frames; dot: set on this screen. Small letters under column numbers: the column's default image kind (1, 2 or S).";
    const legend = h("span", { class: "v-help", tabIndex: 0, role: "img", ariaLabel: legendTip });
    legend.dataset.tip = legendTip;
    legend.dataset.tipPos = "right";
    const header = h(
      "div",
      { class: "km-row km-row--head", role: "row" },
      h("span", { class: "km-rowhead", role: "columnheader" }, "Column", legend),
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
    this.#replaceChildren(grid, [...rows, h("p", { class: "v-label km-divider" }, "Column values"), ...valueRows], editing);
    grid.dataset.keymode = String(keys);
    if (hadFocus) this.#focusCell(grid);
    this.#keepEditing(grid, editing);
  }

  #candidateFiles = new Map<string, Promise<string[]>>();

  /** Four bounded file-list reads; overlap is relevance, never a claim of identity or age. */
  async #describeCandidates(select: HTMLSelectElement, candidates: PickerSource[], wanted: Set<string>) {
    let next = 0;
    const matches: { source: PickerSource; overlap: number; count?: number }[] = [];
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (next < candidates.length && select.isConnected) {
        const source = candidates[next++];
        const cacheKey = JSON.stringify([source.key, source.contentHash]);
        let files = this.#candidateFiles.get(cacheKey);
        if (!files) {
          files = this.#host.load(source.key).then((data) => data.files);
          this.#candidateFiles.set(cacheKey, files);
          files.catch(() => this.#candidateFiles.delete(cacheKey));
        }
        try {
          const names = await files;
          const available = new Set(names.map((name) => name.replace(/\\/g, "/").toLowerCase()));
          matches.push({ source, count: names.length, overlap: [...wanted].filter((name) => available.has(name)).length });
        } catch {
          matches.push({ source, count: source.fileCount, overlap: -1 });
        }
      }
    }));
    if (!select.isConnected) return;
    const chosen = select.value;
    matches.sort((a, b) => b.overlap - a.overlap || a.source.key.localeCompare(b.source.key));
    select.replaceChildren(
      h("option", { value: "" }, "Choose a replacement…"),
      ...matches.map(({ source, count, overlap }) => h("option", { value: source.key },
        `${source.name} · ${source.creator || "creator unknown"} · ${count ?? "?"} files · ${overlap < 0 ? "file list unavailable" : `${overlap}/${wanted.size} referenced filenames`} · ${source.key}`)),
    );
    select.value = chosen;
  }

  /** One persistent, explicit recovery notice for missing visible or captured sources. */
  #renderMissing() {
    let root = document.querySelector<HTMLElement>("#missing-sources");
    if (!root) {
      root = h("section", { id: "missing-sources", class: "missing-sources", role: "alert", ariaLabel: "Missing source skins" });
      $("#keymodes-view").before(root);
    }
    const missing = missingSources(this.#host.drafts(), new Set(this.#host.sources().map((s) => s.key)));
    root.hidden = !missing.length;
    root.replaceChildren();
    for (const source of missing) {
      if (source.name === source.key) source.name = this.#host.skinName(source.key);
      const unknown = source.name === source.key;
      const display = unknown ? `Unknown source skin (${source.key})` : source.name;
      const candidates = this.#host.sources().filter((s) => unknown || s.name === source.name);
      const select = h("select", { class: "v-input", ariaLabel: `Replacement for ${display}` },
        h("option", { value: "" }, "Choose a replacement…"),
        ...candidates.map((s) => h("option", { value: s.key }, `${s.name} · ${s.creator || "creator unknown"} · ${s.fileCount ?? "?"} files · checking filenames… · ${s.key}`)));
      const exact = candidates.find((s) => !!source.hash && s.contentHash === source.hash);
      if (exact) select.value = exact.key;
      const pickerTip = "Lazer stores no skin import date, so same-name copies cannot be ranked by age. Filename overlap is only a relevance hint; only an exact full-content hash is preselected.";
      const pickerHelp = h("span", { class: "v-help", tabIndex: 0, role: "img", ariaLabel: pickerTip });
      pickerHelp.dataset.tip = pickerTip;
      pickerHelp.dataset.tipPos = "left";
      const keepTip = "Keep uses retained uploads at their current geometry; future resizing may resample them and cannot restore cropped pixels. Without a retained image, remap or remove is required. Recovery of all affected key counts is one undo step.";
      const keepHelp = h("span", { class: "v-help", tabIndex: 0, role: "img", ariaLabel: keepTip });
      keepHelp.dataset.tip = keepTip;
      keepHelp.dataset.tipPos = "left";
      const recoveryError = h("p", { class: "missing-sources__error", role: "status" });
      const run = async (recovery: Recovery) => {
        try {
          // Validate every affected count before committing any of them.
          const changes = source.counts.map((keys) => {
            const draft = clone(this.#host.drafts()[String(keys)]);
            recoverSource(draft, source.key, recovery);
            return { keys, draft, generation: this.#host.generation(keys) };
          });
          if (recovery.kind === "remap") {
            const { files } = await this.#host.load(recovery.key);
            const names = new Set(files.map((f) => f.toLowerCase()));
            for (const { draft } of changes)
              for (const refs of sourceSlots(draft).values())
                for (const slot of refs)
                  if (slot.skin === recovery.key && slot.files.some((f) => !names.has(f.from.toLowerCase())))
                    throw new Error("The replacement does not contain every referenced file. Choose another skin.");
          } else if (recovery.kind === "keep") {
            const { files } = await this.#host.load(UPLOADS);
            const retained = new Set(files.map((f) => f.toLowerCase()));
            for (const { draft } of changes)
              for (const slot of Object.values(draft.images))
                if (slot && "files" in slot && slot.skin === UPLOADS && slot.files.some((f) => !retained.has(f.from.toLowerCase())))
                  throw new Error("A retained derived file has been removed. Remap or remove the slots instead.");
          }
          if (changes.some(({ keys, generation }) => this.#host.generation(keys) !== generation))
            throw new Error("The draft changed while recovery was loading; recovery was not applied.");
          this.#host.edit(`${recovery.kind} missing source ${source.name}`, Object.fromEntries(changes.map(({ keys, draft }) => [String(keys), draft])));
          this.#renderMissing();
        } catch (error) {
          recoveryError.textContent = error instanceof Error ? error.message : String(error);
          this.#error(error instanceof Error ? error.message : String(error));
        }
      };
      const summary = `Missing source: ${display}. ${source.slots} ${source.slots === 1 ? "slot" : "slots"}; ${source.counts.map((k) => `${k}K`).join(", ")}. Nothing is changed automatically.`;
      root.append(h("div", { class: "missing-sources__row" },
        h("p", { class: "missing-sources__summary", title: summary },
          h("span", { class: "missing-sources__identity", ariaLabel: `Missing source: ${display}` }, `${display}.`),
          h("span", { class: "missing-sources__details" }, ` ${source.slots} ${source.slots === 1 ? "slot" : "slots"}; ${source.counts.map((k) => `${k}K`).join(", ")}. Nothing is changed automatically.`)),
        h("span", { class: "missing-sources__choice" }, select, pickerHelp),
        h("button", { class: "v-btn v-btn--sm v-btn--primary", onclick: () => {
          const replacement = candidates.find((s) => s.key === select.value);
          if (replacement) void run({ kind: "remap", key: replacement.key, name: replacement.name, hash: replacement.contentHash });
          else recoveryError.textContent = "Choose a replacement skin first.";
        } }, "Remap"),
        h("span", { class: "missing-sources__choice" },
          h("button", { class: "v-btn v-btn--sm", onclick: () => void run({ kind: "keep" }) }, "Keep derived images"), keepHelp),
        h("button", { class: "v-btn v-btn--sm", onclick: () => void run({ kind: "remove" }) }, "Remove slots")),
        recoveryError);
      void this.#describeCandidates(select, candidates, sourceFileNames(this.#host.drafts(), source.key));
    }
  }

  /** Width edits keep proportions and report the first use inline. */
  async #setWidths(columns: number[], value: string, label: string) {
    if (missingSources(this.#host.drafts(), new Set(this.#host.sources().map((s) => s.key))).length) {
      this.#renderMissing();
      this.#error("Resolve the missing source above before changing width.");
      return;
    }
    // The widths as they are when this edit runs (after any edit before it).
    await this.#hit.setWidths(columns, value, label);
    const done = this.#hit.lastRegeometry;
    if (this.#draft()?.keepProportions === false || !done) return;
    const first = localStorage.getItem("skin-studio:proportions-seen") === null;
    localStorage.setItem("skin-studio:proportions-seen", "1");
    this.#state(
      `${label}: kept proportions (${done.images} images in ${done.ms} ms)${done.skipped ? `. ${done.skipped}` : ""}${first ? '. Turn "Keep proportions when changing column width" off under Hit position to stretch like osu!.' : ""}`,
    );
  }

  /**
   * Every other [Mania] key of the shown key count (mania-form.ts): per-column
   * settings aligned under the columns, then typed fields by group. Values
   * are read from the draft's skin.ini (hand edits show here) and set through
   * the draft (one undo step each).
   */
  #renderSettings() {
    const root = $("#km-settings");
    const keys = this.#keys;
    if (!keys) return root.replaceChildren();
    const hadFocus = root.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
    const editing = this.#editing(root);
    const text = this.#host.mixText();
    // The draft's own value first: the skin.ini text catches up a moment
    // later (the mix recomposes), and the form must not show the old value.
    const draft = this.#draft()?.values ?? {};
    const value = (key: string) => (key in draft ? (draft[key] ?? undefined) : maniaValue(text, keys, key));
    const set = (key: string, v: string | null, label: string) =>
      this.#change(label, (draft) => {
        draft.values[key] = v;
        if (key === "WidthForNoteHeightScale") delete draft.autoNoteHeight;
      });
    const help = (tip: string) => {
      const el = h("span", { class: "v-help", tabIndex: 0, role: "img", ariaLabel: tip });
      el.dataset.tip = tip;
      el.dataset.tipPos = "right";
      return el;
    };
    const optionLabel = (f: { options?: { value: string; label: string }[] }, value: string) =>
      f.options?.find((o) => o.value === value)?.label ?? value;
    const reset = (label: string, onclick: () => void, shown: boolean) =>
      h("button", { type: "button", class: "km-clear km-reset", ariaLabel: `Reset ${label} to its default`, title: "Reset to default (leave the key out)", hidden: !shown, onclick }, "×");
    const control = (
      f: { control: string; options?: { value: string; label: string }[]; min?: number; max?: number },
      label: string,
      current: string | undefined,
      fallback: string | undefined,
      onSet: (v: string | null) => void,
      alpha = false,
    ): HTMLElement => {
      if (f.control === "switch") {
        const box = h("input", { type: "checkbox", role: "switch", ariaLabel: label, checked: (current ?? fallback) === "1" });
        box.indeterminate = current === undefined && fallback === undefined;
        box.onchange = () => onSet(box.checked ? "1" : "0");
        return box;
      }
      if (f.control === "select") {
        const select = h(
          "select",
          { class: "v-select km-settings__select", ariaLabel: label },
          // Unset reads "Default"; the open list marks which value that is.
          h("option", { value: "", title: fallback !== undefined ? `Default: ${optionLabel(f, fallback)}` : "Default" }, "Default"),
          ...(f.options ?? []).map((o) => h("option", { value: o.value }, o.value === fallback ? `${o.label} (default)` : o.label)),
          // A value the list does not name (another spelling) stays selectable.
          ...(current !== undefined && !f.options?.some((o) => o.value === current) ? [h("option", { value: current }, current)] : []),
        );
        select.value = current ?? "";
        select.onchange = () => onSet(select.value === "" ? null : select.value);
        return select;
      }
      if (f.control === "colour") {
        const shown = current ?? fallback ?? "0,0,0";
        const [r, g, b, a = "255"] = shown.split(",").map((v) => v.trim());
        const picker = h("input", { type: "color", class: "km-colour", value: toHex(shown, "0,0,0"), ariaLabel: label });
        picker.onchange = () => onSet(fromHex(picker.value, current ?? shown, alpha));
        const swatch = h("span", { class: "km-swatch", title: `${shown}${current === undefined ? " (default)" : ""}` }, picker);
        swatch.style.setProperty("--c", `rgb(${r} ${g} ${b} / ${alpha ? Number(a) / 255 : 1})`);
        if (!alpha) return swatch;
        const opacity = h("input", { type: "number", min: "0", max: "255", step: "1", class: "v-input km-num km-settings__alpha", value: a, ariaLabel: `${label} alpha` });
        opacity.onchange = (event) => {
          const n = Math.round(Number((event.currentTarget as HTMLInputElement).value));
          if (n >= 0 && n <= 255) onSet([r, g, b, String(n)].join(","));
        };
        return h("span", { class: "km-settings__colour" }, swatch, opacity);
      }
      const input = h("input", {
        type: "number",
        step: f.control === "integer" ? "1" : "any",
        class: "v-input km-num",
        value: current ?? "",
        placeholder: fallback ?? "",
        ariaLabel: label,
        ...(f.min !== undefined ? { min: String(f.min) } : {}),
        ...(f.max !== undefined ? { max: String(f.max) } : {}),
      });
      input.onchange = (event) => {
        const changed = event.currentTarget as HTMLInputElement;
        if (changed.value === "") return onSet(null);
        const n = Number(changed.value);
        const bad = !Number.isFinite(n) || (f.control === "integer" && !Number.isInteger(n)) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max);
        if (bad) {
          this.#error(`${label}: ${f.control === "integer" ? "a whole number" : "a number"}${f.min !== undefined ? ` from ${f.min}` : ""}${f.max !== undefined ? ` to ${f.max}` : ""}`);
          changed.value = current ?? "";
          return;
        }
        this.#error("");
        onSet(String(n));
      };
      return input;
    };
    // Per-column settings, under the columns of the grid above.
    const widths = (value("ColumnWidth") ?? "").split(",");
    const columnRow = (f: ColumnField) => {
      const length = f.length(keys);
      const raw = f.list ? value(f.key)?.split(",").map((v) => v.trim()) : undefined;
      const global = f.list ? undefined : value(f.key.replace(/#.*$/, ""));
      const fill = (i: number) =>
        f.key.startsWith("Lighting") ? (widths[i]?.trim() || "30") : (f.fallback ?? "0");
      const name = f.label.toLowerCase();
      // An edit of some columns (the row's selection), one undo step.
      const apply = (cols: number[], v: string | null, label: string) =>
        f.list
          ? set(f.key, cols.reduce<string | undefined>((list, c) => setListEntry(list, length, c, v, fill), value(f.key))!, label)
          : this.#change(label, (draft) => {
              for (const c of cols) draft.values[formKey(f, c)] = v;
            });
      this.#valueSpecs.set(f.key, {
        label: name,
        length,
        apply: (cols, v) => apply(cols, v, `Set ${name} of ${columnsText(cols)}`),
        copy: (from) => {
          const v = f.list ? (value(f.key)?.split(",")[from]?.trim() || fill(from)) : (value(formKey(f, from)) ?? null);
          apply(Array.from({ length }, (_, c) => c), v, `Apply ${name} to all columns`);
        },
      });
      const cells = Array.from({ length }, (_, i) => {
        const key = f.list ? f.key : formKey(f, i);
        const current = f.list ? raw?.[i] || undefined : value(key);
        const label = f.list && length < keys ? `${f.label} column ${i + 1}` : `Column ${i + 1} ${name}`;
        const fallback = f.list ? (f.key.startsWith("Lighting") ? fill(i) : f.fallback) : (global ?? MANIA_FIELDS.find((g) => g.key === f.key.replace(/#.*$/, ""))?.fallback);
        const el = control(f, label, current, fallback, (v) => {
          const cols = rowTargets(this.#rows, f.key, i);
          apply(cols, v, cols.length === 1 ? `Set ${label.toLowerCase()}` : `Set ${name} of ${columnsText(cols)}`);
        });
        const cell = h("div", { class: `km-value${f.list && length < keys ? " km-value--gap" : ""}`, role: "gridcell" }, el);
        return this.#bindValue(cell, el.matches("input, select") ? el : (el.querySelector<HTMLElement>("input, select") ?? el), f.key, i, length);
      });
      const set_ = f.list ? value(f.key) !== undefined : cells.some((_, i) => value(formKey(f, i)) !== undefined);
      return h(
        "div",
        { class: "km-row", role: "row" },
        h(
          "span",
          { class: "km-rowhead", role: "rowheader", title: f.key },
          f.label,
          f.help ? help(f.help) : null,
          reset(f.label, () =>
            this.#change(`Reset ${f.label.toLowerCase()}`, (draft) => {
              if (f.list) draft.values[f.key] = null;
              else for (let i = 0; i < length; i++) draft.values[formKey(f, i)] = null;
            }), set_),
        ),
        ...cells,
        // Gap rows have one entry fewer: pad, so the next row starts in place.
        ...Array.from({ length: Math.max(0, keys - length) }, () => h("span", { class: "km-value", ariaHidden: "true" })),
      );
    };
    const columns = h("div", { class: "km-grid km-settings__columns", role: "grid", ariaLabel: "Per-column settings", ariaMultiSelectable: "true" }, ...MANIA_COLUMNS.map(columnRow));
    columns.style.setProperty("--km-cols", String(keys));
    // Typed fields by group.
    const groups = new Map<string, Field[]>();
    for (const f of MANIA_FIELDS) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
    const fieldsets = [...groups].map(([group, fields]) =>
      h(
        "fieldset",
        { class: "km-settings__group" },
        h("legend", { class: "v-label" }, group),
        ...fields.map((f) => {
          const current = value(f.key);
          return h(
            "div",
            { class: "km-settings__field" },
            h("span", { class: "km-settings__label", title: f.key }, f.label, f.help ? help(f.help) : null),
            control(f, f.label, current, f.fallback, (v) => set(f.key, v, `Set ${f.label.toLowerCase()}`), f.alpha),
            reset(f.label, () => set(f.key, null, `Reset ${f.label.toLowerCase()}`), current !== undefined),
          );
        }),
      ),
    );
    this.#replaceChildren(root, [columns, h("div", { class: "km-settings__groups" }, ...fieldsets)], editing);
    root.dataset.keymode = String(keys);
    if (hadFocus) root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(hadFocus)}"]`)?.focus();
    this.#keepEditing(root, editing);
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
    const label = (row: string, cols: number[], single: string) =>
      cols.length === 1 ? single : `Set ${row} of ${columnsText(cols)}`;
    // Each row: how an edit of some columns lands (one undo step), and the
    // copy Apply to all columns makes.
    this.#valueSpecs.set("ColumnWidth", {
      label: "width",
      length: keys,
      apply: (cols, v) => void this.#setWidths(cols, v ?? widths[cols[0]], label("width", cols, `Set column ${cols[0] + 1} width`)),
      copy: (from) => void this.#setWidths(Array.from({ length: keys }, (_, i) => i), widths[from], "Apply width to all columns"),
    });
    const setLines = (cols: number[], v: string, l: string) =>
      this.#change(l, (draft) => {
        draft.values.ColumnLineWidth = lines.map((w, i) => (cols.includes(i) ? v : w)).join(",");
      });
    this.#valueSpecs.set("ColumnLineWidth", {
      label: "line width",
      length: keys,
      apply: (cols, v) => setLines(cols, v ?? lines[cols[0]], label("line width", cols, `Set column ${cols[0] + 1} line`)),
      copy: (from) => setLines(Array.from({ length: keys }, (_, i) => i), lines[from], "Apply line width to all columns"),
    });
    for (const [prefix, name, alpha] of [["Colour", "colour", true], ["ColourLight", "light colour", false]] as const) {
      const current = (c: number) => maniaValue(text, keys, `${prefix}${c + 1}`);
      const fallback = (c: number) => specOf("Mania", `${prefix}${c + 1}`)?.default ?? "0,0,0";
      this.#valueSpecs.set(prefix, {
        label: name,
        length: keys,
        // A picked colour keeps each column's own alpha.
        apply: (cols, hex) =>
          this.#change(label(name, cols, `Set column ${cols[0] + 1} ${name}`), (draft) => {
            for (const c of cols) draft.values[`${prefix}${c + 1}`] = hex === null ? null : fromHex(hex, current(c), alpha);
          }),
        copy: (from) =>
          this.#change(`Apply ${name} to all columns`, (draft) => {
            const v = current(from) ?? fallback(from);
            for (let c = 0; c < keys; c++) draft.values[`${prefix}${c + 1}`] = v;
          }),
      });
    }
    const number = (value: string, label: string, row: number, col: number, id: string) => {
      const input = h("input", {
        type: "number",
        min: "0",
        step: "1",
        value,
        class: "v-input km-num",
        ariaLabel: label,
        tabIndex: this.#cell[0] === row && this.#cell[1] === col ? 0 : -1,
      });
      input.onchange = (event) => {
        const changed = event.currentTarget as HTMLInputElement;
        const n = Number(changed.value);
        if (changed.value === "" || !Number.isFinite(n) || n < 0) {
          this.#error(`${label}: a number of 0 or more`);
          changed.value = value;
          return;
        }
        this.#valueSpecs.get(id)!.apply(rowTargets(this.#rows, id, col), String(n));
      };
      return this.#bindValue(this.#valueCell(input, row, col), input, id, col, keys);
    };
    const colour = (prefix: "Colour" | "ColourLight", label: string, row: number, col: number) => {
      const key = `${prefix}${col + 1}`;
      const current = maniaValue(text, keys, key);
      const fallback = specOf("Mania", key)?.default ?? "0,0,0";
      const shown = current ?? fallback;
      const input = h("input", {
        type: "color",
        value: toHex(current, fallback),
        class: "km-colour",
        ariaLabel: `${label}: ${current ?? `default ${fallback}`}`,
        tabIndex: this.#cell[0] === row && this.#cell[1] === col ? 0 : -1,
      });
      input.onchange = () => this.#valueSpecs.get(prefix)!.apply(rowTargets(this.#rows, prefix, col), input.value);
      // The colour itself over a checkerboard (alpha shows), the value on hover or focus.
      const swatch = h(
        "label",
        { class: "km-swatch", title: `${key}: ${current ?? `default ${fallback}`}` },
        input,
        h("span", { class: "km-swatch__value" }, shown),
      );
      const [r, g, b, a = 255] = shown.split(",").map((v) => Number(v.trim()) || 0);
      swatch.style.setProperty("--c", `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(3)})`);
      return this.#bindValue(this.#valueCell(input, row, col, swatch), input, prefix, col, keys);
    };
    const row = (label: string, cell: (c: number) => HTMLElement) =>
      h(
        "div",
        { class: "km-row km-row--values", role: "row" },
        h("span", { class: "km-rowhead", role: "rowheader" }, label),
        ...Array.from({ length: keys }, (_, c) => cell(c)),
      );
    return [
      row("Width", (c) => number(widths[c], `Column ${c + 1} width`, first, c, "ColumnWidth")),
      row("Line width", (c) => number(lines[c], `Line left of column ${c + 1}`, first + 1, c, "ColumnLineWidth")),
      row("Colour", (c) => colour("Colour", `Column ${c + 1} colour`, first + 2, c)),
      row("Light colour", (c) => colour("ColourLight", `Column ${c + 1} light colour`, first + 3, c)),
    ];
  }

  /**
   * Makes a value cell part of its row's selection: Ctrl/Cmd+click toggles
   * it, Shift+click selects the run from the anchor (neither opens a colour
   * picker or flips a switch), a plain click on a cell outside the
   * selection selects it alone; Shift+arrows grow the run, Ctrl+A takes the
   * row, Escape clears.
   */
  #bindValue(cell: HTMLElement, input: HTMLElement, row: string, col: number, length: number) {
    cell.dataset.vrow = row;
    cell.dataset.vcol = String(col);
    cell.setAttribute("aria-selected", String(isSelected(this.#rows, row, col)));
    cell.addEventListener(
      "click",
      (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          this.#setRows(event.shiftKey ? rangeRow(this.#rows, row, col) : toggleRow(this.#rows, row, col));
          input.focus({ preventScroll: true });
        } else if (!isSelected(this.#rows, row, col)) this.#setRows(singleRow(row, col));
      },
      true,
    );
    input.addEventListener("focus", () => {
      this.#valueFocus = { row, col };
      this.#lastFocus = "value";
      this.#renderToolbar();
    });
    input.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        this.#setRows(extendRow(this.#rows, row, col, delta, length));
        const next = Math.max(0, Math.min(length - 1, col + delta));
        document
          .querySelector<HTMLElement>(`[data-vrow="${CSS.escape(row)}"][data-vcol="${next}"]`)
          ?.querySelector<HTMLElement>("input, select")
          ?.focus({ preventScroll: true });
      } else if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        event.stopPropagation();
        this.#setRows(allRow(row, length));
      } else if (event.key === "Escape" && this.#rows.cols.length) {
        event.stopPropagation();
        this.#setRows(NONE);
      }
    });
    return cell;
  }

  /** Selects columns of one value row (slots are deselected). */
  #setRows(selection: RowSelection) {
    this.#rows = selection;
    if (selection.cols.length) {
      this.#lastFocus = "value";
      if (this.#selection.keys.length) this.#setSelection(EMPTY);
    }
    for (const cell of document.querySelectorAll<HTMLElement>("#keymodes-view [data-vrow]"))
      cell.setAttribute("aria-selected", String(isSelected(selection, cell.dataset.vrow!, Number(cell.dataset.vcol))));
    const n = selection.cols.length;
    if (n > 1) this.#state(`${n} columns selected: an edit sets every one (Escape clears)`);
    this.#renderToolbar();
  }
  #valueCell(input: HTMLElement, row: number, col: number, content: HTMLElement = input) {
    const cell = h("div", { class: "km-value", role: "gridcell" }, content);
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
    const base = SHARED_ROW;
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
    const shared = row >= SHARED_ROW;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    // Shift+arrows grow the selection from its anchor.
    if (move && event.shiftKey && target.dataset.key) {
      event.preventDefault();
      const next = extend(
        this.#selection.keys.includes(target.dataset.key) ? this.#selection : single(this.#shape(), [row, col]),
        this.#shape(),
        move,
      );
      this.#setSelection(next);
      if (next.focus) {
        this.#cell = [next.focus[0], next.focus[1]];
        for (const el of document.querySelectorAll<HTMLElement>("#keymodes-view [data-row]"))
          el.tabIndex = el.dataset.row === String(next.focus[0]) && el.dataset.col === String(next.focus[1]) ? 0 : -1;
        this.#focusCell();
      }
      return;
    }
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
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.#setSelection(all(this.#shape(), [row, col]));
    } else if (mod && event.key === " ") {
      event.preventDefault();
      this.#setSelection(toggle(this.#selection, this.#shape(), [row, col]));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // A multi-selection the slot is part of stays; otherwise this slot alone.
      if (!this.#selection.keys.includes(key) || this.#selection.keys.length < 2) this.#arm(key);
      this.#focusTile(0) || $<HTMLInputElement>("#km-filter").focus();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.#clearMany(this.#dropTargets(key));
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
      if (data.types.includes(DRAG_TYPE)) {
        const dragged = this.#dragged;
        this.#dragged = null;
        if (dragged) {
          const slot = this.#slotFor(dragged.unit, dragged.source);
          this.#assignMany(this.#dropTargets(k), slot, shownName(dragged.unit.name, dragged.unit.files));
          return;
        }
        // From the Explorer: `{skin, name}` of an image.
        try {
          const { skin, name } = JSON.parse(data.getData(DRAG_TYPE));
          if (typeof skin === "string" && typeof name === "string")
            void this.#assignImage(this.#dropTargets(k), skin, name);
        } catch {
          this.#error("That drag carried no image.");
        }
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
      this.#error("Adding files needs a write session: open Skin studio from the dashboard (Tools → Skin studio → Open). Your draft is kept.");
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
    // The files that failed stay reported after the valid one is assigned.
    const rejected = $("#km-error").textContent ?? "";
    const [slot] = await this.#uploadImages(images, files);
    if (slot) this.#assignMany(this.#dropTargets(key), slot, shownName(slot.name, slot.files));
    if (rejected) this.#error(rejected);
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
      this.#state(`Added ${slots.map((s) => shownName(s.name, s.files)).join(", ")} to dropped files`);
      return slots;
    } catch (error) {
      this.#error(`Not added: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ---- bulk -------------------------------------------------------------------

  #applyToAll() {
    const focus = this.#valueFocus;
    const value = this.#lastFocus === "value" && focus ? this.#valueSpecs.get(focus.row) : undefined;
    if (value) return value.copy(focus!.col);
    const key = this.#armed;
    if (!key || !/^(Key|Note)Image\d/.test(key)) return;
    const pattern = patternOf(key);
    const from = Number(/\d+/.exec(key)![0]);
    this.#change(`Apply ${roleLabel(pattern).toLowerCase()} to all columns`, (draft) =>
      assignImageSlots(draft, applyToAll(this.#keys, pattern, from, this.#current)),
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
  async #stageCopy(skin: string, from: number, keys: number) {
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
    return copyStage(keys, from, image, value);
  }
  async #copy() {
    const skin = $<HTMLSelectElement>("#km-copy-skin").value || MIX;
    const from = Number($<HTMLSelectElement>("#km-copy-keys").value);
    if (!from || !this.#keys) return;
    const keys = this.#keys;
    const generation = this.#host.generation(keys);
    const copied = await this.#stageCopy(skin, from, keys);
    if (this.#host.generation(keys) !== generation) return this.#error("The draft changed while copying; the stale copy was not applied.");
    const map = remapColumns(keys, from).map((c) => c + 1);
    const name = skin === MIX ? "this mix" : this.#host.skinName(skin);
    this.#change(`Copy ${from}K from ${name}`, (draft) => applyStageCopy(draft, copied), keys);
    if (from !== keys)
      this.#state(
        `Copied ${from}K from ${name} into ${keys}K: columns take ${map.join(", ")} (same column kind 1/2/S, nearest position)`,
      );
  }

  async #resetGeometry() {
    const keys = this.#keys;
    const generation = this.#host.generation(keys);
    const source = this.#host.originalStage(keys);
    if (!source) {
      this.#error("The original stage has no file-backed source to reset from.");
      return;
    }
    try {
      const copied = await this.#stageCopy(source, keys, keys);
      if (this.#host.generation(keys) !== generation) return this.#error("The draft changed while resetting geometry; the reset was not applied.");
      this.#change(`Reset ${keys}K geometry from ${this.#host.skinName(source)}`, (draft) => resetStageGeometry(draft, copied), keys);
    } catch (error) {
      this.#error(`Reset geometry: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // Within a section, osu!mania's own names first (name order otherwise).
    const section = (n: number) =>
      shown.filter((u) => rank(u) === n).sort((a, b) => roleOrder(pattern!, a.name) - roleOrder(pattern!, b.name));
    const sections: [string, Unit[]][] = pattern
      ? [
          [`Used as ${roleLabel(pattern).toLowerCase()} in this skin`, section(0)],
          ["Names that match", section(1)],
          ["Other images", section(2)],
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
              ? `No image matches “${this.#filter}”.`
              : "No images in this source: choose another in Images from.",
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
      // Cut in the middle: the end tells `mania-note1H` from `mania-note2T`.
      h("span", { class: "km-tile__name" }, ...nameParts(this.#source === UPLOADS ? shownName(unit.name, unit.files) : unit.name).map((part, i) =>
        h("span", { class: i ? "km-tile__tail" : "km-tile__head" }, part))),
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
    this.#assignMany(this.#targets(), this.#slotFor(unit, this.#source), shownName(unit.name, unit.files));
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
