// The Keymodes screen's "Hit position" group for the shown key count:
// HitPosition with a stepper that also moves the receptor graphics, and a
// calibration from the last completed play for receptors and hold tails.

import { parseOsu, type Beatmap } from "@vosu-tools/osu-parse";
import { maniaConfig, type ManiaImageResolution } from "@vosu-tools/render-core/mania";
import { readSkinIni } from "@vosu-tools/render-core/skin-ini";
import { judgeReplay, parseReplay, replayRate } from "@vosu-tools/replay";
import { maniaValue } from "@vosu-tools/skin-spec";
import {
  MIN_HITS,
  calibratedHitPosition,
  offsets,
  receptorShift,
  holdPlan,
  type Offsets,
  type Speed,
} from "./calibrate";
import { $, h } from "./dom";
import type { KeymodeDraft, Slot, SlotImage } from "./keymodes";
import { lookupFiles } from "./mania";
import { UPLOADS } from "./uploads";

/** One image operation of the service's `/v1/derive`. */
export type DeriveOp =
  | { shift: { up: number } }
  | { tail: { gap: number; at_top: boolean } }
  | { spacer: { rows: number } }
  | { percy: { height: number; cap_bottom: number } };
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
  /** vosu's live mania settings, when it reports them. */
  speed(): (Speed & { upscroll: boolean }) | null;
  canWrite(): boolean;
  state(text: string): void;
  error(text: string): void;
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
  release: Offsets;
}

export class HitPanel {
  #host: HitHost;
  #calibration: Calibration | null = null;
  #busy = false;
  /** Scroll speed typed in when vosu reports none. */
  #typedSpeed: number | null = null;

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
    const keys = this.#host.keys();
    if (!keys) {
      root.replaceChildren();
      return;
    }
    // Focus survives the re-render: the control with the same label.
    const focused = root.contains(document.activeElement)
      ? document.activeElement?.getAttribute("aria-label") ?? (document.activeElement as HTMLElement | null)?.id
      : null;
    queueMicrotask(() => {
      if (!focused) return;
      const again = [...root.querySelectorAll<HTMLElement>("input, button")].find(
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
    input.onchange = () => void this.setHitPosition(Number(input.value));
    const step = (by: number, label: string) =>
      h(
        "button",
        {
          type: "button",
          class: "v-btn v-btn--sm v-btn--icon",
          ariaLabel: `${label} (receptors move ${by < 0 ? "up" : "down"} 8 px, 16 px @2x)`,
          title: `${by > 0 ? "+" : ""}${by}: receptors move ${by < 0 ? "up" : "down"} ${Math.abs(by) * 1.6} px (${Math.abs(by) * 3.2} px @2x)`,
          disabled: this.#busy || !this.#host.canWrite(),
          onclick: () => void this.setHitPosition(this.#current() + by),
        },
        by > 0 ? "+5" : "−5",
      );
    const hit = this.#host.draft()?.hit;
    const moved = hit
      ? Object.values(hit.originals).map((o) => receptorShift(o.at, current, false))
      : [];
    const note = moved.length
      ? `Receptors moved ${moved[0].rows >= 0 ? "up" : "down"} ${Math.abs(moved[0].rows)} px (${Math.abs(receptorShift(Object.values(hit!.originals)[0].at, current, true).rows)} px @2x) from HitPosition ${Object.values(hit!.originals)[0].at}.`
      : "1 unit = 1.6 px (3.2 px @2x); a lower HitPosition moves the receptors up.";
    const speed = this.#speed(),
      live = this.#host.speed();
    const speedLine = live
      ? h("span", { class: "v-muted" }, `Scroll speed ${live.speed} (${live.client}${live.client === "stable" ? `, BPM scaling ${live.bpmScale === false ? "off" : "on"}` : ""}) from vosu`)
      : this.#speedInput();
    root.replaceChildren(
      h(
        "div",
        { class: "km-hit__row" },
        h("label", { class: "km-hit__label" }, "HitPosition", input),
        step(-5, "Raise the hit line"),
        step(5, "Lower the hit line"),
        h("span", { class: "v-muted km-hit__note" }, note),
      ),
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
            onclick: () => void this.#calibrate(),
          },
          this.#busy ? "Reading the last play…" : "Calibrate from last play",
        ),
        speedLine,
      ),
      ...this.#proposal(),
    );
  }

  #speedInput() {
    const input = h("input", {
      type: "number",
      min: "1",
      max: "40",
      step: "1",
      class: "v-input km-hit__value",
      ariaLabel: "Your osu!mania scroll speed",
      placeholder: "speed",
      value: this.#typedSpeed ? String(this.#typedSpeed) : "",
    });
    input.onchange = () => {
      const n = Number(input.value);
      this.#typedSpeed = n >= 1 && n <= 40 ? n : null;
      this.render();
    };
    return h("span", { class: "v-muted" }, "vosu reports no scroll speed (open osu!); enter yours: ", input);
  }

  #speed(): Speed | null {
    const live = this.#host.speed();
    if (live) return live;
    // A typed speed is read on lazer's scale with BPM scaling (stable's default).
    return this.#typedSpeed ? { client: "lazer", speed: this.#typedSpeed } : null;
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
    const current = this.#current();
    if (target === current) return;
    this.#busy = true;
    this.render();
    try {
      const draft = this.#host.draft();
      const hit = structuredClone(draft?.hit) ?? { originals: {} };
      // Images not moved yet are captured as they are now, with the draft's
      // own slot so that going back restores exactly that.
      for (const r of this.#host.resolved())
        if (KEY.test(r.key) && !hit.originals[r.key]) {
          const image = this.#mixImage(r);
          const had = !!draft && r.key in draft.images;
          if (image) hit.originals[r.key] = { at: current, slot: image, had, prior: had ? structuredClone(draft!.images[r.key]) : undefined };
        }
      const slots: Record<string, Slot | undefined> = {};
      const lost: string[] = [];
      for (const [key, original] of Object.entries(hit.originals)) {
        if (original.at === target) {
          slots[key] = original.had ? original.prior : undefined;
          continue;
        }
        const derived = await this.#host.derive(
          original.slot.skin,
          original.slot.files.map((f) => ({
            name: f.from,
            op: { shift: { up: receptorShift(original.at, target, hd(f.from)).rows } },
          })),
        );
        for (const d of derived) if (d.lost) lost.push(`${d.from}: ${d.lost} rows past the edge`);
        slots[key] = {
          skin: UPLOADS,
          name: original.slot.name.split("/").pop()!,
          files: original.slot.files.map((f, i) => ({ from: derived[i].stored, suffix: f.suffix })),
        };
      }
      const keys = this.#host.keys();
      const light = Number(maniaValue(this.#host.mixText(), keys, "LightPosition"));
      this.#host.change(`Set ${keys}K HitPosition to ${target}`, (draft) => {
        for (const [key, slot] of Object.entries(slots))
          if (slot === undefined) delete draft.images[key];
          else draft.images[key] = slot;
        draft.values.HitPosition = String(target);
        if (Number.isFinite(light) && light > 0) draft.values.LightPosition = String(Math.round(light + target - current));
        // Back where every image was made: nothing is moved any more.
        if (Object.values(hit.originals).every((o) => o.at === target)) delete draft.hit;
        else draft.hit = hit;
      });
      this.#host.error(lost.length ? `Moved past the image edge: ${lost.join("; ")}` : "");
    } catch (error) {
      this.#host.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  /** The files the mix draws for a lookup, as an image to copy (one source skin). */
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

  async #calibrate() {
    const speed = this.#speed();
    if (!speed) return;
    this.#busy = true;
    this.#calibration = null;
    this.render();
    try {
      const play = await this.#host.lastPlay();
      const bytes = Uint8Array.from(atob(play.replay), (c) => c.charCodeAt(0));
      const replay = await parseReplay(bytes);
      const { map, simulation } = judgeReplay(replay, parseOsu(play.osu));
      const rate = replayRate(replay);
      this.#calibration = {
        play,
        map,
        keys: Math.max(1, Math.round(map.difficulty.cs)),
        speed,
        press: offsets(simulation, map, "press", speed, rate),
        release: offsets(simulation, map, "release", speed, rate),
      };
      this.#host.error("");
    } catch (error) {
      this.#host.error(`Calibration: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  #proposal(): Node[] {
    const c = this.#calibration;
    if (!c) return [];
    const meta = c.map.metadata;
    const title = `${meta.Artist ?? "?"} - ${meta.Title ?? "?"} [${meta.Version ?? "?"}]`;
    const keys = this.#host.keys();
    const head = h("p", { class: "km-hit__play" }, `Last play: ${title}, ${c.keys}K, osu!${c.play.client} (${c.play.source}), speed ${c.speed.speed}`);
    if (c.keys !== keys)
      return [head, h("p", { class: "km-hit__warn" }, `It was played on ${c.keys}K: calibrations apply only to that key count. Select ${c.keys}K.`)];
    const out: Node[] = [head];
    const fmt = (o: Offsets, what: string) =>
      `mean ${o.mean >= 0 ? "+" : ""}${o.mean.toFixed(1)} ms ± ${o.spread.toFixed(1)} over ${o.count.toLocaleString("en")} ${what}`;
    // Receptors.
    const current = this.#current();
    if (c.press.count < MIN_HITS)
      out.push(h("p", { class: "km-hit__warn" }, `Receptors: ${c.press.count} presses; at least ${MIN_HITS} are needed.`));
    else {
      const target = calibratedHitPosition(current, c.press);
      const px = receptorShift(current, target, false).rows;
      out.push(
        h(
          "div",
          { class: "km-hit__row" },
          h(
            "span",
            {},
            `Presses: ${fmt(c.press, "hits")} → ${target === current ? "receptors already sit where you hit" : `move receptors ${px > 0 ? "up" : "down"} ${Math.abs(px)} px (HitPosition ${current} → ${target})`}`,
          ),
          target !== current
            ? h("button", { type: "button", class: "v-btn v-btn--sm v-btn--primary", onclick: () => void this.setHitPosition(target) }, "Apply to receptors")
            : null,
        ),
      );
    }
    // Hold tails.
    if (!c.release.count) out.push(h("p", { class: "v-muted" }, "Hold tails: the play has no released holds."));
    else if (c.release.count < MIN_HITS)
      out.push(h("p", { class: "km-hit__warn" }, `Hold tails: ${c.release.count} releases; at least ${MIN_HITS} are needed.`));
    else {
      const units = c.release.distance;
      const text =
        Math.abs(units) < 0.5
          ? "hold ends already sit where you release"
          : units > 0
            ? `you release late: hold ends move up ${units.toFixed(1)} units (cap's bottom edge on your release point, body reaching it)`
            : `you release early: hold ends move down ${(-units).toFixed(1)} units, as percy holds (normal holds are converted: blank tail, cap drawn into the body)`;
      out.push(
        h(
          "div",
          { class: "km-hit__row" },
          h("span", {}, `Releases: ${fmt(c.release, "holds")} → ${text}`),
          h("button", { type: "button", class: "v-btn v-btn--sm v-btn--primary", onclick: () => void this.#applyTails() }, "Apply to hold tails"),
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
    const c = this.#calibration;
    if (!c) return;
    this.#busy = true;
    this.render();
    try {
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
