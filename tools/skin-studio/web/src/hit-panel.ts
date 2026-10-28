// Keymodes hit-position controls and independent last-play calibrations:
// press timings move receptors; release timings adjust LN hold ends.

import { maniaColumns, parseOsu, type Beatmap } from "@vosu-tools/osu-parse";
import { maniaConfig, type ManiaImageResolution } from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { judgeReplay, parseReplay, replayRate } from "@vosu-tools/replay";
import { maniaValue, setManiaValue } from "@vosu-tools/skin-spec";
import {
  MIN_HITS,
  calibratedHitPosition,
  offsets,
  receptorShift,
  holdPlan,
  type Offsets,
  type Speed,
  type CalibrationOffsets,
} from "./calibrate";
import { $, h } from "./dom";
import { needsGeometryRebase, type KeymodeDraft, type Slot, type SlotImage } from "./keymodes";
import { lookupFiles } from "./mania";
import {
  type Dims,
  type FileOp,
  type Geometry,
  type Lost,
  columnOf,
  lostReport,
  pieceReport,
  refused,
  unchanged,
  rederives,
  hitPositionFor,
  pieceOf,
  pieceOps,
  referenceScale,
} from "./proportions";
import { UPLOADS } from "./uploads";
import { playDate } from "./play-date";

/** One image operation of the service's `/v1/derive`. */
export type DeriveOp =
  | { shift: { up: number; grow?: boolean } }
  | { tail: { gap: number; at_top: boolean } }
  | { spacer: { rows: number } }
  | { percy: { height: number; cap_bottom: number } }
  | { resize: { width: number; height: number; scale_y: number; up: number } }
  | { rows: { height: number } };
export interface LastPlay {
  client: "stable" | "lazer";
  source: string;
  date: number | string;
  md5: string;
  replay: string;
  osu: string;
}
export interface HitHost {
  keys(): number;
  mixText(): string;
  /** The mix's files: lower-cased output path → source. */
  mixFiles(): Map<string, { skin: string; from: string; to: string }>;
  mixIndex(): Map<string, string[]>;
  resolved(): ManiaImageResolution[];
  draft(): KeymodeDraft | undefined;
  /** One undoable change of the shown key count's draft. */
  change(label: string, mutate: (draft: KeymodeDraft) => void): void;
  derive(skin: string, files: { name: string; op: DeriveOp; cap?: string }[]): Promise<{ from: string; stored: string; lost: number }[]>;
  rows(skin: string, name: string): Promise<{ width: number; height: number; top: number; bottom: number }>;
  lastPlay(): Promise<LastPlay>;
  /** The scroll speed the previews draw at, unless that is only lazer's default. */
  speed(): (Speed & { upscroll: boolean; source?: string }) | null;
  /** Sets the speed for calibration and the previews alike (null: follow the client). */
  setSpeed(speed: number | null): void;
  canWrite(): boolean;
  beforeGeometry?(): Promise<boolean>;
  state(text: string): void;
  error(text: string): void;
}

/** Adds the failed geometry action without leaking source paths into the UI. */
export function geometryError(action: "Width change" | "HitPosition change", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const missing = "Not in the library: ";
  return `${action}: ${message.startsWith(missing) ? `couldn't read ${message.slice(missing.length)}` : message}`;
}

const DEFAULT_HIT_POSITION = 402;
const KEY = /^KeyImage\d+D?$/;
const hd = (file: string) => /@2x\.[^.]+$/i.test(file);

/** A judged play, summarised for the shown key count. */
interface Calibration {
  play: LastPlay;
  map: Beatmap;
  keys: number;
  speed: Speed;
  press: Offsets;
  release: CalibrationOffsets;
}

export class HitPanel {
  #host: HitHost;
  #calibrations: Partial<Record<"press" | "release", Calibration>> = {};
  #calibrationErrors: Partial<Record<"press" | "release", string>> = {};
  #newestPlay = 0;
  #busy = false;

  constructor(host: HitHost) {
    this.#host = host;
  }

  /** HitPosition of the shown key count (skin.ini, else lazer's default 402). */
  #current() {
    const raw = Number(maniaValue(this.#host.mixText(), this.#host.keys(), "HitPosition"));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HIT_POSITION;
  }

  render() {
    const root = $("#km-hit");
    const ln = $("#km-ln");
    const keys = this.#host.keys();
    if (!keys) {
      root.replaceChildren();
      ln.replaceChildren();
      return;
    }
    // Focus survives the re-render: the control with the same label.
    const focused = root.contains(document.activeElement) || ln.contains(document.activeElement)
      ? document.activeElement?.getAttribute("aria-label") ?? (document.activeElement as HTMLElement | null)?.id
      : null;
    queueMicrotask(() => {
      if (!focused) return;
      const again = [...root.querySelectorAll<HTMLElement>("input, button"), ...ln.querySelectorAll<HTMLElement>("input, button")].find(
        (el) => el.getAttribute("aria-label") === focused || el.id === focused,
      );
      again?.focus();
    });
    const current = this.#current();
    const input = h("input", {
      type: "number",
      min: "240",
      max: "480",
      step: "1",
      value: String(current),
      class: "v-input km-hit__value",
      ariaLabel: `${keys}K HitPosition`,
      disabled: this.#busy || !this.#host.canWrite(),
    });
    input.onblur = () => {
      if (!this.#busy && input.value !== String(current)) void this.setHitPosition(Number(input.value));
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    };
    // Hand moves only: a HitPosition a width change derived moves nothing
    // inside the receptor images (the scaling carries them).
    const hit = this.#host.draft()?.hit;
    const handMoved = hit?.moved ?? 0;
    const at = hit && Object.values(hit.originals).find((o) => o.slot)?.at;
    const note =
      at !== undefined && Math.round(handMoved * 1e6) !== 0
        ? `Receptors moved ${handMoved < 0 ? "up" : "down"} ${Math.abs(receptorShift(at, at + handMoved, false).rows)} px (${Math.abs(receptorShift(at, at + handMoved, true).rows)} px @2x) inside their images, from HitPosition ${at}.`
        : "1 unit = 1.6 px (3.2 px @2x); a lower HitPosition moves the receptors up.";
    const speed = this.#speed(),
      live = this.#host.speed();
    const speedLine = this.#speedInput(live);
    root.replaceChildren(
      h(
        "div",
        { class: "km-hit__row" },
        h("label", { class: "km-hit__label", title: note }, "HitPosition", input),
      ),
      this.#moveRow(),
      this.#keepRow(),
      h(
        "div",
        { class: "km-hit__row" },
        h(
          "button",
          {
            type: "button",
            class: "v-btn v-btn--sm",
            id: "km-calibrate",
            disabled: this.#busy || !speed,
            title: speed ? "Reads the newest completed local osu!mania play" : "Needs your scroll speed",
            onclick: () => void this.#calibrate("press"),
          },
          "Calibrate hit position",
        ),
        speedLine,
      ),
      ...this.#proposal("press"),
    );
    ln.replaceChildren(
      h("p", { class: "v-muted" }, "Release timings calibrate hold tails and LN length, independently of hit position. Uses the scroll speed above."),
      h("button", {
        type: "button", class: "v-btn v-btn--sm", id: "km-calibrate-ln",
        disabled: this.#busy || !speed,
        title: speed ? "Reads the newest completed local osu!mania play" : "Set your scroll speed in Hit position first",
        onclick: () => void this.#calibrate("release"),
      }, "Calibrate LN length"),
      ...this.#proposal("release"),
    );
  }

  /** Receptor movement is optional per key count; changing it is one undo step. */
  #moveRow() {
    const keys = this.#host.keys();
    const box = h("input", {
      type: "checkbox", id: "km-move-receptors",
      checked: this.#host.draft()?.moveReceptors !== false,
      disabled: this.#busy || !this.#host.canWrite(),
    });
    box.onchange = () => this.#host.change(`${box.checked ? "Move" : "Keep"} ${keys}K receptors with HitPosition`, (draft) => {
      if (box.checked) delete draft.moveReceptors;
      else draft.moveReceptors = false;
    });
    return h("div", { class: "km-hit__row" },
      h("label", { class: "km-hit__check", title: "Off: only the note landing line moves. Receptor images stay in place, including when calibrating. Width changes still rescale images." },
        box, " Move receptors with HitPosition"));
  }

  /** "Keep proportions when changing column width", per key count (on by default). */
  #keepRow() {
    const keys = this.#host.keys();
    const on = this.#host.draft()?.keepProportions !== false;
    const box = h("input", { type: "checkbox", id: "km-keep", checked: on });
    box.onchange = () =>
      this.#host.change(`${box.checked ? "Keep" : "Stretch"} ${keys}K proportions when changing column width`, (draft) => {
        if (box.checked) delete draft.keepProportions;
        else draft.keepProportions = false;
      });
    return h(
      "div",
      { class: "km-hit__row" },
      h("label", {
        class: "km-hit__check",
        title: "Rescale receptors, notes and hold pieces uniformly when changing width. HitPosition follows the shared scale. With receptor movement off, skip HitPosition-driven image shifts; image rescaling still happens.",
      }, box, " Keep proportions when changing column width"),
    );
  }

  /**
   * The scroll speed offsets are converted with: the one the previews draw
   * at (the client's, the Preview tab's Scroll field, or typed here, which
   * sets that field too), so calibration and previews always agree.
   */
  #speedInput(live: ReturnType<HitHost["speed"]>) {
    const input = h("input", {
      type: "number",
      min: "1",
      max: "40",
      step: "any",
      class: "v-input km-hit__value",
      ariaLabel: "Your osu!mania scroll speed",
      placeholder: "speed",
      value: live && live.source !== "client" ? String(live.speed) : "",
    });
    input.onchange = () => {
      const n = Number(input.value);
      this.#host.setSpeed(input.value !== "" && n >= 1 && n <= 40 ? n : null);
      this.render();
    };
    if (live?.source === "client")
      return h(
        "span",
        { class: "v-muted" },
        `Scroll speed ${live.speed} (${live.client}${live.client === "stable" ? `, BPM scaling ${live.bpmScale ? "on" : "off"}` : ""}) from vosu, as the previews; another: `,
        input,
      );
    return h(
      "span",
      { class: "v-muted" },
      live ? `Scroll speed ${live.speed}, as the previews: ` : "vosu reports no scroll speed (open osu!); enter yours: ",
      input,
    );
  }

  #speed(): Speed | null {
    return this.#host.speed();
  }

  // ---- receptors -------------------------------------------------------------

  /**
   * Sets HitPosition and moves every key image's receptor graphic with it,
   * from the images as they were before the first move (no shift of a shift)
   * on the same canvas, edge-clamped per pixel column. LightPosition moves by
   * the same amount: lazer places the column light from it, not from
   * HitPosition (`LegacyColumnBackground`), so the light keeps its place on
   * the receptors. StageHint, LightingN/L and judgements are already placed
   * from HitPosition by lazer (`LegacyHitTarget` and `LegacyHitExplosion` in
   * `HitTargetInsetContainer`, `LegacyManiaJudgementPiece`) and stay.
   */
  async setHitPosition(target: number) {
    target = Math.round(target);
    if (!(target >= 240 && target <= 480)) {
      this.#host.error("HitPosition is 240–480 (lazer clamps it there).");
      return;
    }
    const keys = this.#host.keys();
    await this.#serial("HitPosition", async () => {
      const current = this.#current();
      if (target === current) return;
      if (this.#host.draft()?.moveReceptors === false) {
        if (this.#host.beforeGeometry && !await this.#host.beforeGeometry()) return;
        this.#host.change(`Set ${keys}K HitPosition to ${target} (receptors fixed)`, (draft) => {
          draft.values.HitPosition = String(target);
          if (draft.hit) draft.hit.detached = (draft.hit.detached ?? 0) + target - current;
        });
      } else {
        await this.#regeometry(`Set ${keys}K HitPosition to ${target}`, { HitPosition: String(target) }, true);
      }
    });
  }

  /**
   * Sets column widths (comma list). With "Keep proportions" on (the
   * default), receptors, notes and hold pieces are rescaled as if each
   * column were scaled uniformly (proportions.ts), and HitPosition follows
   * the receptors: HitPosition' = 480 − (480 − HitPosition) × s, s being the
   * scale most columns share. One undo step.
   */
  async setWidths(columns: readonly number[], value: string, label: string) {
    this.lastRegeometry = null;
    await this.#serial(`ColumnWidth${columns.join(",")}`, () => {
      // The widths as the skin.ini has them now, these columns changed (one
      // change: one HitPosition, one undo step).
      const keys = this.#host.keys();
      const config = maniaConfig(readSkinIni(this.#host.mixText()), keys);
      const widths = config.columnWidth.map((w, i) => (columns.includes(i) ? value : String(Math.round((w / 1.6) * 1e4) / 1e4)));
      return this.#setWidths(widths, label);
    });
  }
  #needsRebase(draft: KeymodeDraft | undefined) {
    if (!draft?.hit) return false;
    const resolved = this.#host.resolved();
    return needsGeometryRebase(draft, (key) => {
      const image = resolved.find((r) => r.key === key);
      return image ? this.#mixImage(image) : null;
    });
  }

  async #setWidths(widths: string[], label: string) {
    const keys = this.#host.keys();
    const config = maniaConfig(readSkinIni(this.#host.mixText()), keys);
    const draft = this.#host.draft();
    const rebase = this.#needsRebase(draft);
    if (!rebase && widths.every((width, i) => Math.abs(Number(width) * 1.6 - config.columnWidth[i]) < 1e-9)) return;
    const values: Record<string, string | null> = { ColumnWidth: widths.join(",") };
    if (this.#host.draft()?.keepProportions === false) {
      if (this.#host.beforeGeometry && !await this.#host.beforeGeometry()) return;
      this.#host.change(label, (draft) => Object.assign(draft.values, values));
      return;
    }
    // Scales against the widths the pieces had when first captured (the
    // originals), so changing columns one by one ends where changing them
    // all at once would: HitPosition follows the scale most columns have.
    const originals = Object.entries(rebase ? {} : draft?.hit?.originals ?? {});
    const base = config.columnWidth.map((w, i) => originals.find(([k, o]) => pieceOf(k) && columnOf(k) === i && o.width)?.[1].width ?? w);
    const valid = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1);
    const was = referenceScale(config.columnWidth.map((w, i) => valid(w / base[i])));
    const scale = referenceScale(widths.map((w, i) => valid((Number(w) * 1.6) / base[i])));
    // The HitPosition the current one means at the original widths: the
    // captured one plus the hand moves (exact), else as the widths have it.
    const keyAt = originals.find(([k]) => pieceOf(k) === "key")?.[1].at;
    const unscaled = keyAt !== undefined ? keyAt + (this.#host.draft()?.hit?.moved ?? 0) + (this.#host.draft()?.hit?.detached ?? 0) / was : 480 - (480 - this.#current()) / was;
    const hitPosition = hitPositionFor(unscaled, scale);
    if (hitPosition < 240 || hitPosition > 480)
      return this.#host.error(`Keeping proportions would put HitPosition at ${hitPosition}, outside 240–480.`);
    values.HitPosition = String(hitPosition);
    const wfnhs = Number(maniaValue(this.#host.mixText(), keys, "WidthForNoteHeightScale"));
    if (wfnhs > 0) values.WidthForNoteHeightScale = String(Math.round(((wfnhs * scale) / was) * 100) / 100);
    await this.#regeometry(label, values);
  }

  #geometryTicket = 0;
  #queue: Promise<void> = Promise.resolve();
  #latest = new Map<string, number>();
  /**
   * Geometry changes run one after another, each from the skin.ini the one
   * before left (two quick edits of different columns both count); an edit
   * still waiting when a newer one of the same field arrives is skipped.
   */
  #serial(field: string, run: () => Promise<void>) {
    const ticket = (this.#latest.get(field) ?? 0) + 1;
    this.#latest.set(field, ticket);
    const job = this.#queue.then(() => (this.#latest.get(field) === ticket ? run() : undefined));
    this.#queue = job.catch(() => undefined);
    return job;
  }
  #sizes = new Map<string, Promise<Dims>>();
  #derived = new Map<string, Promise<{ stored: string; lost: number }>>();
  #pending = new Map<string, { source: string; op: DeriveOp; id: string; done: (r: { stored: string; lost: number }) => void; fail: (e: unknown) => void }[]>();
  /**
   * One derived file (cached by skin, source and operation). Requests made
   * in the same tick go to the service together, 64 per request per skin.
   */
  #derive(skin: string, source: string, op: DeriveOp): Promise<{ stored: string; lost: number }> {
    const id = JSON.stringify([skin, source, op]);
    const known = this.#derived.get(id);
    if (known) return known;
    const result = new Promise<{ stored: string; lost: number }>((done, fail) => {
      const queue = this.#pending.get(skin) ?? [];
      if (!queue.length) this.#pending.set(skin, queue);
      queue.push({ source, op, id, done, fail });
      if (queue.length === 1)
        queueMicrotask(() => {
          this.#pending.delete(skin);
          for (let i = 0; i < queue.length; i += 64) {
            const chunk = queue.slice(i, i + 64);
            this.#host.derive(skin, chunk.map((q) => ({ name: q.source, op: q.op }))).then(
              (r) => chunk.forEach((q, n) => q.done(r[n])),
              (error) => chunk.forEach((q) => q.fail(error)),
            );
          }
        });
    });
    result.catch(() => this.#derived.delete(id));
    this.#derived.set(id, result);
    return result;
  }
  /** Last re-derive: images made and time taken, for the screen and tests. */
  lastRegeometry: { images: number; ms: number; skipped: string } | null = null;

  #size(skin: string, name: string) {
    const id = `${skin}\n${name}`;
    let size = this.#sizes.get(id);
    if (!size) {
      size = this.#host.rows(skin, name).then((r) => ({ width: r.width, height: r.height, blank: r.top >= r.height }));
      size.catch(() => this.#sizes.delete(id));
      this.#sizes.set(id, size);
    }
    return size;
  }

  /**
   * Re-derives every captured piece for the geometry `values` give (they
   * win over the mix's skin.ini), from the images as they were before the
   * first change (no resampling of a resample, no shift of a shift), and
   * stores values and images as one undoable change. A newer call cancels
   * an older one still deriving.
   */
  /**
   * `byHand`: a HitPosition edit (field, calibration), recorded in
   * the draft as units moved at the captured widths (`hit.moved`) and done
   * as a move inside each key image's canvas. A width change records only
   * widths; the HitPosition it derives is reached by scaling, never replayed
   * as a move.
   */
  async #regeometry(label: string, values: Record<string, string | null>, byHand = false) {
    const ticket = ++this.#geometryTicket;
    const started = performance.now();
    this.#busy = true;
    this.render();
    try {
      if (this.#host.beforeGeometry && !await this.#host.beforeGeometry()) return;
      const keys = this.#host.keys();
      const text = this.#host.mixText();
      let next = text;
      for (const [key, value] of Object.entries(values)) next = setManiaValue(next, keys, key, value ?? undefined);
      const now = maniaConfig(readSkinIni(text), keys);
      const then = maniaConfig(readSkinIni(next), keys);
      const current = this.#current();
      const target = Number(values.HitPosition ?? current);
      const widthsChange = now.columnWidth.some((w, i) => w !== then.columnWidth[i]) || now.noteHeightWidth !== then.noteHeightWidth;
      const draft = this.#host.draft();
      const hit = this.#needsRebase(draft) ? { originals: {} } : structuredClone(draft?.hit) ?? { originals: {} };
      // Pieces not changed yet are captured as they are now, with the draft's
      // own slot so that going back restores exactly that. Keys always (the
      // hit line moves them); notes and hold pieces once widths change.
      for (const r of this.#host.resolved()) {
        const piece = pieceOf(r.key);
        if (!piece || hit.originals[r.key] || (piece !== "key" && !widthsChange)) continue;
        const image = this.#mixImage(r);
        const had = !!draft && r.key in draft.images;
        if (image)
          hit.originals[r.key] = {
            at: current - (hit.detached ?? 0),
            width: now.columnWidth[columnOf(r.key)],
            noteHeight: now.noteHeightWidth,
            slot: image,
            had,
            prior: had ? structuredClone(draft!.images[r.key]) : undefined,
          };
      }
      // Hand moves are kept in units at the captured widths: one made after
      // a width change counts at that change's scale.
      if (byHand) {
        const base = now.columnWidth.map((w, i) => Object.entries(hit.originals).find(([k, o]) => pieceOf(k) === "key" && columnOf(k) === i && o.width)?.[1].width ?? w);
        const scale = referenceScale(now.columnWidth.map((w, i) => (w > 0 && base[i] > 0 ? w / base[i] : 1)));
        hit.moved = (hit.moved ?? 0) + (target - current) / scale;
      }
      if (widthsChange && hit.detached) {
        const base = now.columnWidth.map((w, i) => Object.entries(hit.originals).find(([k, o]) => pieceOf(k) === "key" && columnOf(k) === i && o.width)?.[1].width ?? w);
        const was = referenceScale(now.columnWidth.map((w, i) => w / base[i]));
        const scale = referenceScale(then.columnWidth.map((w, i) => w / base[i]));
        hit.detached *= scale / was;
      }
      const geometry = (config: typeof now, hitPosition: number, column: number): Geometry => ({
        hitPosition,
        width: config.columnWidth[column],
        noteHeight: config.noteHeightWidth,
        repeat: config.noteBodyStyle !== 0,
      });
      const slots: Record<string, Slot | undefined> = {};
      const lost: Lost[] = [];
      const skipped: { key: string; what: string }[] = [];
      let images = 0;
      // 1. Each piece's operations (sizes read in parallel, cached).
      const planned = await Promise.all(
        Object.entries(hit.originals)
          .filter(([key]) => rederives(key, widthsChange))
          .map(async ([key, original]) => {
            const piece = pieceOf(key)!;
            const column = columnOf(key);
            const from: Geometry = {
              ...geometry(now, original.at, column),
              width: original.width ?? now.columnWidth[column],
              noteHeight: original.noteHeight ?? now.noteHeightWidth,
            };
            const files = original.slot.files;
            const dims = new Map<string, Dims>();
            await Promise.all(files.map(async (f) => dims.set(f.from, await this.#size(original.slot.skin, f.from))));
            // Left as it is, with the reason: nothing visible to scale, or an
            // operation the service would refuse (a guard).
            const blank = unchanged(files, dims);
            const ops = blank ? null : pieceOps(piece, from, geometry(then, target - (hit.detached ?? 0), column), files, dims, hit.moved ?? 0, draft?.moveReceptors !== false);
            const why = blank ?? ops?.flatMap((o) => [o.pre, o.op]).map((op) => (op ? refused(op) : null)).find(Boolean) ?? null;
            if (why) skipped.push({ key, what: why === blank ? why : `${why}, left as it is` });
            return { key, original, ops: why ? null : ops };
          }),
      );
      // 2. The files, derived in batches per skin (cached); a hand move
      // first, then the width change on its result.
      const make = async (skin: string, o: FileOp) => {
        const first = await this.#derive(skin, o.source, o.pre ?? o.op);
        // Only a hand move cuts (inside the canvas); scaling and the moves it
        // leaves grow the canvas, and a repeated body's rows scale.
        const handOp = o.pre ?? o.op;
        const hand = "shift" in handOp && !handOp.shift.grow ? first.lost : 0;
        if (!o.pre) return { stored: first.stored, lost: hand };
        const second = await this.#derive(UPLOADS, first.stored, o.op);
        return { stored: second.stored, lost: hand };
      };
      const made = await Promise.all(planned.map(({ original, ops }) => Promise.all((ops ?? []).map((o) => make(original.slot.skin, o)))));
      // 3. The new slots.
      for (const [n, { key, original, ops }] of planned.entries()) {
        if (!ops) {
          slots[key] = original.had ? original.prior : undefined;
          continue;
        }
        const derived = made[n];
        images += derived.length;
        const files = original.slot.files;
        slots[key] = {
          skin: UPLOADS,
          name: original.slot.name.split("/").pop()!,
          files: files.map((f, i) => ({ from: derived[i].stored, suffix: f.suffix })),
        };
        // Reported when this change makes the image, not again on every
        // later change that keeps it.
        if (JSON.stringify(draft?.images[key]) !== JSON.stringify(slots[key]))
          for (const [i, d] of derived.entries()) if (d.lost) lost.push({ key, file: files[i].from, rows: d.lost, op: "shift" });
      }
      // A newer change superseded this one.
      if (ticket !== this.#geometryTicket) return;
      const light = Number(maniaValue(text, keys, "LightPosition"));
      if (draft?.moveReceptors !== false && values.HitPosition !== undefined && Number.isFinite(light) && light > 0 && target !== current)
        values = { ...values, LightPosition: String(Math.round(light + target - current)) };
      this.#host.change(label, (d) => {
        for (const [key, slot] of Object.entries(slots))
          if (slot === undefined) delete d.images[key];
          else d.images[key] = slot;
        Object.assign(d.values, values);
        // Back where every image was made: nothing is changed any more.
        const shown = (key: string) => (key in slots ? slots[key] : d.images[key]);
        if (!hit.detached && Object.entries(hit.originals).every(([key, o]) => JSON.stringify(shown(key)) === JSON.stringify(o.had ? o.prior : undefined)))
          delete d.hit;
        else d.hit = hit;
      });
      const notes = skipped.length ? pieceReport(keys, skipped) : "";
      this.lastRegeometry = { images, ms: Math.round(performance.now() - started), skipped: notes };
      if (notes) this.#host.state(`${label}. ${notes}`);
      this.#host.error(lost.length ? lostReport(keys, lost) : "");
    } catch (error) {
      if (ticket === this.#geometryTicket)
        this.#host.error(geometryError(byHand ? "HitPosition change" : "Width change", error));
    } finally {
      if (ticket === this.#geometryTicket) {
        this.#busy = false;
        this.render();
      }
    }
  }

  /** The files the mix draws for a lookup, as an image to copy (one source skin). */
  /**
   * Reads the image sizes a width change resamples with, ahead of it: the
   * first change otherwise waits for a decode of every file it touches (the
   * resampler itself runs in the service and needs no start-up). Cached, so
   * calling it on every refresh costs nothing.
   */
  warm() {
    if (this.#host.draft()?.keepProportions === false) return;
    for (const r of this.#host.resolved()) {
      if (!pieceOf(r.key)) continue;
      const image = this.#mixImage(r);
      for (const f of image?.files ?? []) this.#size(image!.skin, f.from).catch(() => undefined);
    }
  }

  #mixImage(r: ManiaImageResolution): SlotImage | null {
    if (!r.drawn || r.drawn.builtin) return null;
    const files = this.#host.mixFiles();
    const paths = lookupFiles(this.#host.mixIndex(), r.drawn.name, r.animated);
    const sources = paths.map((p) => files.get(p.toLowerCase())).filter((f) => !!f);
    if (!sources.length) return null;
    const skin = sources[0].skin;
    const name = r.drawn.name;
    return {
      skin,
      name,
      files: sources
        .filter((f) => f.skin === skin)
        .map((f) => ({ from: f.from, suffix: f.to.replace(/\\/g, "/").slice(name.length) })),
    };
  }

  // ---- calibration ------------------------------------------------------------

  async #calibrate(kind: "press" | "release") {
    const speed = this.#speed();
    if (!speed) return;
    this.#busy = true;
    delete this.#calibrations[kind];
    delete this.#calibrationErrors[kind];
    this.render();
    try {
      const play = await this.#host.lastPlay();
      const bytes = Uint8Array.from(atob(play.replay), (c) => c.charCodeAt(0));
      const replay = await parseReplay(bytes);
      const { map, simulation } = judgeReplay(replay, parseOsu(play.osu));
      const rate = replayRate(replay);
      this.#calibrations[kind] = {
        play,
        map,
        keys: maniaColumns(map),
        speed,
        press: offsets(simulation, map, "press", speed, rate),
        release: offsets(simulation, map, "release", speed, rate),
      };
      this.#host.error("");
    } catch (error) {
      this.#calibrationErrors[kind] = `Calibration: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  #proposal(kind: "press" | "release"): Node[] {
    const c = this.#calibrations[kind];
    if (!c) return this.#calibrationErrors[kind] ? [h("p", { class: "km-hit__warn", role: "alert" }, this.#calibrationErrors[kind]!)] : [];
    const meta = c.map.metadata;
    const title = `${meta.Artist ?? "?"} - ${meta.Title ?? "?"} [${meta.Version ?? "?"}]`;
    const keys = this.#host.keys();
    const head = h("p", { class: "km-hit__play" }, `Last play: ${title}, ${c.keys}K, osu!${c.play.client} (${c.play.source}), speed ${c.speed.speed}`);
    const date = playDate(c.play.date, this.#newestPlay);
    this.#newestPlay = Math.max(this.#newestPlay, date.timestamp || 0);
    const out: Node[] = [head, h("p", { class: date.stale ? "km-hit__warn" : "v-muted" }, date.text)];
    if (c.keys !== keys)
      return [...out, h("p", { class: "km-hit__warn" }, `It was played on ${c.keys}K: calibrations apply only to that key count. Select ${c.keys}K.`)];
    const fmt = (o: Offsets, what: string) =>
      `mean ${o.mean >= 0 ? "+" : ""}${o.mean.toFixed(1)} ms ± ${o.spread.toFixed(1)} over ${o.count.toLocaleString("en")} ${what}`;
    // Receptors.
    const current = this.#current();
    if (kind === "press" && c.press.count < MIN_HITS)
      out.push(h("p", { class: "km-hit__warn" }, `Receptors: ${c.press.count} presses; at least ${MIN_HITS} are needed.`));
    else if (kind === "press") {
      const target = calibratedHitPosition(current, c.press);
      const px = receptorShift(current, target, false).rows;
      out.push(
        h(
          "div",
          { class: "km-hit__row" },
          h(
            "span",
            { title: "Calibration corrects your timing rather than matching it." },
            `You pressed ${Math.abs(c.press.mean).toFixed(1)} ms ${c.press.mean >= 0 ? "late" : "early"} on average (${fmt(c.press, "hits")}) → ${target === current ? "no HitPosition change needed" : `${this.#host.draft()?.moveReceptors === false ? "landing line" : "receptors"} ${px > 0 ? "up" : "down"} ${Math.abs(px)} px so you press ${c.press.mean >= 0 ? "earlier" : "later"} (HitPosition ${current} → ${target})${this.#host.draft()?.moveReceptors === false ? "; receptor images stay fixed" : ""}`}`,
          ),
          target !== current
            ? h("button", { type: "button", class: "v-btn v-btn--sm v-btn--primary", disabled: this.#busy || !this.#host.canWrite(), onclick: () => void this.setHitPosition(target) }, this.#host.draft()?.moveReceptors === false ? "Apply HitPosition" : "Apply to receptors")
            : null,
        ),
      );
    }
    if (kind === "press") return out;
    // Hold tails.
    out.push(h("p", { class: "v-muted" }, `${c.release.count} of ${c.release.total} hold releases used; ${c.release.excluded} excluded (${c.release.excludedEarly} early, ${c.release.excludedLate} late): the client missed or broke combo on these releases. Re-grabbing a dropped hold can produce more than one release.`));
    if (c.release.veryLate)
      out.push(h("p", { class: "km-hit__warn" }, `${c.release.veryLate} very late releases included, as stable judges them.`));
    if (!c.release.total) out.push(h("p", { class: "v-muted" }, "Hold tails: the play has no released holds."));
    else if (c.release.count < MIN_HITS)
      out.push(h("p", { class: "km-hit__warn" }, `Hold tails: ${c.release.count} releases; at least ${MIN_HITS} are needed.`));
    else {
      const units = c.release.distance;
      const text =
        Math.abs(units) < 0.5
          ? "no LN length change needed"
          : `LNs ${Math.abs(units).toFixed(1)} px ${units > 0 ? "shorter" : "longer"} so you release ${units > 0 ? "earlier" : "later"}`;
      out.push(
        h(
          "div",
          { class: "km-hit__row" },
          h("span", { title: "Calibration corrects your timing rather than matching it." }, `You released ${Math.abs(c.release.mean).toFixed(1)} ms ${units >= 0 ? "late" : "early"} on average (${fmt(c.release, "holds")}) → ${text}`),
          Math.abs(units) >= 0.5 ? h("button", { type: "button", class: "v-btn v-btn--sm v-btn--primary", disabled: this.#busy || !this.#host.canWrite(), onclick: () => void this.#applyTails() }, "Apply to hold tails") : null,
        ),
      );
    }
    return out;
  }

  /**
   * Hold ends for the release calibration, per distinct tail and body image.
   * See `tailPlan` and `percyPlan` (calibrate.ts) for the geometry.
   */
  async #applyTails() {
    const c = this.#calibrations.release;
    if (!c || c.keys !== this.#host.keys() || c.release.count < MIN_HITS) return;
    this.#busy = true;
    this.render();
    try {
      if (this.#host.beforeGeometry && !await this.#host.beforeGeometry()) return;
      const keys = this.#host.keys();
      const config = maniaConfig(readSkinIni(this.#host.mixText()), keys);
      const atTop = !(this.#host.speed()?.upscroll ?? false);
      const resolved = this.#host.resolved();
      const by = new Map(resolved.map((r) => [r.key, r]));
      const images: Record<string, SlotImage> = {};
      const report: string[] = [];
      let style = false;
      const done = new Map<string, Record<string, SlotImage>>();
      for (let column = 0; column < keys; column++) {
        const tailLookup = by.get(`NoteImage${column}T`)!;
        const tail = tailLookup.drawn ? this.#mixImage(by.get(tailLookup.drawn.key)!) : null;
        const bodyLookup = by.get(`NoteImage${column}L`);
        const body = bodyLookup?.drawn ? this.#mixImage(bodyLookup) : null;
        if (!tail || !body) {
          report.push(`column ${column + 1}: built-in hold images, left as is`);
          continue;
        }
        const id = `${tail.skin}\n${tail.name}\n${body.skin}\n${body.name}`;
        let result = done.get(id);
        if (!result) {
          result = await this.#holdEnd(c.release, tail, body, config.noteHeightWidth, config.noteBodyStyle, atTop, report);
          done.set(id, result);
        }
        for (const [suffix, slot] of Object.entries(result)) images[`NoteImage${column}${suffix}`] = slot;
        if (result.L && config.noteBodyStyle === 0) style = true;
      }
      this.#host.change(`Calibrate ${keys}K hold ends`, (draft) => {
        Object.assign(draft.images, images);
        // The calibrated pieces are the new originals for later width changes
        // (captured then, at that geometry): the calibration is kept.
        if (draft.hit) for (const key of Object.keys(images)) delete draft.hit.originals[key];
        // A percy body is drawn from the tail end only by repeating styles.
        if (style) draft.values.NoteBodyStyle = "1";
      });
      this.#host.state(`Hold ends: ${[...new Set(report)].join("; ") || "changed"}`);
    } catch (error) {
      this.#host.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  /** New tail (`T`) and body (`L`) images for one pair; empty when nothing changes. */
  async #holdEnd(
    release: Offsets,
    tail: SlotImage,
    body: SlotImage,
    noteWidth: number,
    bodyStyle: number,
    atTop: boolean,
    report: string[],
  ): Promise<Record<string, SlotImage>> {
    const sd = (image: SlotImage) => image.files.find((f) => !hd(f.from)) ?? image.files[0];
    const tailFile = sd(tail).from,
      bodyFile = sd(body).from;
    const [t, b] = await Promise.all([this.#host.rows(tail.skin, tailFile), this.#host.rows(body.skin, bodyFile)]);
    const slot = (image: SlotImage, stored: string, from: string): SlotImage => ({
      skin: UPLOADS,
      name: image.name.split("/").pop()!,
      files: [{ from: stored, suffix: from.slice(from.lastIndexOf(".")) }],
    });
    const capRows = t.height - t.top - t.bottom;
    const plan = holdPlan(release, { capRows, tailWidth: t.width, bodyHeight: b.height, bodyTop: b.top, noteWidth, percy: capRows === 0 && bodyStyle !== 0 });
    report.push(plan.note);
    if (plan.kind === "none") return {};
    if (plan.kind === "shift-body") {
      const [d] = await this.#host.derive(body.skin, [{ name: bodyFile, op: { shift: { up: plan.up } } }]);
      return { L: slot(body, d.stored, bodyFile) };
    }
    if (plan.kind === "gap") {
      const [d] = await this.#host.derive(tail.skin, [{ name: tailFile, op: { tail: { gap: plan.gap, at_top: atTop } } }]);
      return { T: slot(tail, d.stored, tailFile) };
    }
    // Percy: a spacer tail and a body carrying the cap (both new, 1x).
    const [spacer] = await this.#host.derive(tail.skin, [{ name: tailFile, op: { spacer: { rows: plan.spacer } } }]);
    if (tail.skin !== body.skin) throw new Error("The tail and body come from different skins; take both from one skin first.");
    const [percy] = await this.#host.derive(body.skin, [
      { name: bodyFile, cap: tailFile, op: { percy: { height: plan.height, cap_bottom: plan.capBottom } } },
    ]);
    return { T: slot(tail, spacer.stored, tailFile), L: slot(body, percy.stored, bodyFile) };
  }
}
