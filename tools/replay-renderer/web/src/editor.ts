import settingSchema from "../../render-settings.json";
import {
  DEFAULT_TRANSFORM,
  HUD_KEYS,
  freeSpot,
  guidesFor,
  hudBox,
  hudUnit,
  hudTransformFor,
  layoutCells,
  place,
  resizeBox,
  snapMove,
  transformFor,
  type Corner,
  type HudKey,
  type Layout,
  type Rect,
} from "./layout";
import { PAGE_LIMITS, type Layer } from "./overlay-layout";
import { hudShown, hudTransform, transformOf, type Track } from "./studio";

/** A selectable thing in the frame: a track's playfield, one of its HUD
 *  layers, or an overlay layer. */
export type Item =
  | { kind: "playfield"; track: Track }
  | { kind: "hud"; track: Track; key: HudKey }
  /** An overlay as shown in one track's cell; moving it moves it in every cell. */
  | { kind: "overlay"; layer: Layer; track: Track };
const HUD_LABEL: Record<HudKey, string> = {
  score: "score",
  accuracy: "accuracy",
  combo: "combo",
  health: "health",
};
const DEFAULTS = Object.fromEntries(settingSchema.map((rule) => [rule.key, rule.default]));

const limit = (key: string) => {
  const rule = settingSchema.find((r) => r.key === key)!;
  return { min: rule.min, max: rule.max };
};
const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, value));
/** Snap distance in screen pixels. */
const SNAP = 8;

/**
 * Direct manipulation over the preview: select a playfield or overlay box,
 * drag to move, drag a corner to resize, arrows to nudge. Everything is in
 * output pixels; playfields keep their aspect ratio. The inspector fields
 * mirror the selection and edit it numerically.
 */
export class LayoutEditor {
  private layer = document.createElement("div");
  private guides = { x: document.createElement("div"), y: document.createElement("div") };
  private selection: Item | null = null;
  private fields: Record<"x" | "y" | "w" | "h" | "scale" | "opacity", HTMLInputElement>;
  constructor(
    gate: HTMLElement,
    private inspector: {
      root: HTMLElement;
      title: HTMLElement;
      reset: HTMLButtonElement;
      fields: Record<"x" | "y" | "w" | "h" | "scale" | "opacity", HTMLInputElement>;
    },
    private host: {
      output(): { width: number; height: number };
      layout(): Layout;
      tracks(): readonly Track[];
      layers(): readonly Layer[];
      /** Overlap's focus track (whose playfield placement and overlays the
       *  overlap shows), or null in the other layouts. */
      overlapFocus(): Track | null;
      /** `commit` false while dragging: redraw only; true when an edit ends. */
      changed(item: Item, commit: boolean): void;
      selected(item: Item | null): void;
      /** After every render: each overlay page's box (output px) and the zoom. */
      rendered(placements: { overlay: number; track: number; box: Rect }[], zoom: number): void;
    },
  ) {
    this.layer.className = "editor";
    this.guides.x.className = "guide guide--x";
    this.guides.y.className = "guide guide--y";
    // Guides show only while a drag snaps to them.
    this.guides.x.hidden = this.guides.y.hidden = true;
    gate.append(this.layer);
    this.fields = inspector.fields;
    for (const [key, input] of Object.entries(this.fields))
      input.onchange = () => this.fromField(key as keyof typeof this.fields, Number(input.value));
    inspector.reset.onclick = () => this.reset();
    new ResizeObserver(() => this.render()).observe(gate);
  }
  /**
   * Where a new overlay page of `width`×`height` (output px) goes, as an offset
   * from the cell's corner: the first spot clear of every shown track's
   * playfield, HUD layers and other overlays; failing that, one that only
   * overlaps a playfield (a mania stage can leave no room beside it); failing
   * that, under the health bar of the first cell.
   */
  spotFor(width: number, height: number, except?: Layer): { x: number; y: number } {
    const tracks = this.host.tracks(),
      cells = this.cells();
    if (!tracks.length) return { x: 0, y: 0 };
    const items = this.items().filter((item) => !(item.kind === "overlay" && item.layer === except));
    const unit = hudUnit(cells[0]);
    const options = { margin: Math.max(4, Math.round(20 * unit)), step: Math.max(4, Math.round(8 * unit)) };
    const scene = (avoidPlayfields: boolean) =>
      tracks.map((track, i) => ({
        cell: cells[i],
        obstacles: items
          .filter((item) => item.track === track && (avoidPlayfields || item.kind !== "playfield"))
          .map((item) => this.boxOf(item)),
      }));
    const spot = freeSpot(scene(true), width, height, options) ?? freeSpot(scene(false), width, height, options);
    if (spot) return spot;
    const health = hudBox(cells[0], "health", hudTransform(tracks[0], "health"));
    return { x: Math.round(health.x - cells[0].x), y: Math.round(health.y + health.height - cells[0].y + 20 * unit) };
  }
  /** Overlay boxes in the frame, for the composition inspector. */
  overlayBoxes() {
    return this.items()
      .filter((item) => item.kind === "overlay")
      .map((item) => ({
        name: `V${this.host.tracks().indexOf(item.track) + 1} ${this.label(item)}`,
        kind: "overlay" as const,
        box: this.boxOf(item),
        ms: null,
      }));
  }
  get selected() {
    return this.selection;
  }
  select(item: Item | null) {
    this.selection = item;
    this.host.selected(item);
    this.render();
  }
  /** Output-pixel cells of the current layout. */
  private cells(): Rect[] {
    const tracks = this.host.tracks();
    if (!tracks.length) return [];
    const { width, height } = this.host.output();
    return layoutCells(tracks.length, width, height, this.host.layout(), tracks.map((track) => track.content));
  }
  private boxOf(item: Item): Rect {
    const cell = this.cells()[this.host.tracks().indexOf(item.track)];
    if (item.kind === "overlay") {
      const l = item.layer;
      return { x: cell.x + l.x, y: cell.y + l.y, width: l.width * l.scale, height: l.height * l.scale };
    }
    if (item.kind === "hud") return hudBox(cell, item.key, hudTransform(item.track, item.key));
    return place(cell, item.track.content, transformOf(item.track)).box;
  }
  private items(): Item[] {
    const focus = this.host.overlapFocus();
    // Overlap: one playfield (the focus track's placement), the legend instead
    // of HUD layers, and overlays as the focus player's.
    if (focus)
      return [
        { kind: "playfield", track: focus },
        ...this.host
          .layers()
          .filter((layer) => !layer.hidden.has(focus.id))
          .map((layer) => ({ kind: "overlay", layer, track: focus }) as Item),
      ];
    const tracks = this.host.tracks();
    return [
      ...tracks.map((track) => ({ kind: "playfield", track }) as Item),
      ...tracks.flatMap((track) =>
        HUD_KEYS.filter((key) => hudShown(track, key)).map((key) => ({ kind: "hud", track, key }) as Item),
      ),
      ...this.host.layers().flatMap((layer) =>
        tracks
          .filter((track) => !layer.hidden.has(track.id))
          .map((track) => ({ kind: "overlay", layer, track }) as Item),
      ),
    ];
  }
  private same(a: Item | null, b: Item) {
    if (!a || a.kind !== b.kind) return false;
    if (a.kind === "overlay") return a.layer === (b as typeof a).layer && a.track === (b as typeof a).track;
    if (a.kind === "hud") return a.track === (b as typeof a).track && a.key === (b as typeof a).key;
    return a.track === (b as typeof a).track;
  }
  private label(item: Item) {
    if (item.kind === "overlay") return item.layer.name;
    const index = this.host.tracks().indexOf(item.track);
    return item.kind === "hud"
      ? `V${index + 1} ${HUD_LABEL[item.key]}`
      : `V${index + 1} ${item.track.replay.player}`;
  }
  /** Screen pixels per output pixel. */
  private zoom() {
    return this.layer.clientWidth / this.host.output().width || 1;
  }
  /** Writes `box` (output px) into the item, within the stored ranges. */
  private apply(item: Item, box: Rect, resized: boolean) {
    if (item.kind === "overlay") {
      const l = item.layer,
        cell = this.cells()[this.host.tracks().indexOf(item.track)];
      l.x = Math.round(box.x - cell.x);
      l.y = Math.round(box.y - cell.y);
      if (resized) {
        l.width = Math.round(clamp(box.width / l.scale, { min: PAGE_LIMITS.min, max: PAGE_LIMITS.max }));
        l.height = Math.round(clamp(box.height / l.scale, { min: PAGE_LIMITS.min, max: PAGE_LIMITS.max }));
      }
      return;
    }
    const index = this.host.tracks().indexOf(item.track);
    if (item.kind === "hud") {
      const t = hudTransformFor(this.cells()[index], item.key, box);
      const s = item.track.settings,
        prefix = `hud.${item.key}`;
      s[`${prefix}.dx`] = round(clamp(t.x, limit(`${prefix}.dx`)));
      s[`${prefix}.dy`] = round(clamp(t.y, limit(`${prefix}.dy`)));
      if (resized) s[`${prefix}.scale`] = round(clamp(t.scale, limit(`${prefix}.scale`)));
      return;
    }
    const t = transformFor(this.cells()[index], item.track.content, box);
    const s = item.track.settings;
    s["playfield.x"] = round(clamp(t.x, limit("playfield.x")));
    s["playfield.y"] = round(clamp(t.y, limit("playfield.y")));
    if (resized) s["playfield.scale"] = round(clamp(t.scale, limit("playfield.scale")));
  }
  private reset() {
    const item = this.selection;
    if (!item) return;
    if (item.kind === "playfield") {
      item.track.settings["playfield.x"] = DEFAULT_TRANSFORM.x;
      item.track.settings["playfield.y"] = DEFAULT_TRANSFORM.y;
      item.track.settings["playfield.scale"] = DEFAULT_TRANSFORM.scale;
    } else if (item.kind === "hud") {
      for (const axis of ["dx", "dy", "scale"]) {
        const key = `hud.${item.key}.${axis}`;
        item.track.settings[key] = DEFAULTS[key];
      }
    } else {
      const l = item.layer;
      Object.assign(l, { scale: 1, opacity: 1 }, this.spotFor(l.width, l.height, l));
    }
    this.host.changed(item, true);
    this.render();
  }
  private fromField(key: keyof typeof this.fields, value: number) {
    const item = this.selection;
    if (!item || !Number.isFinite(value)) return this.render();
    const box = this.boxOf(item);
    if (item.kind === "overlay") {
      const l = item.layer;
      if (key === "x") l.x = Math.round(value);
      if (key === "y") l.y = Math.round(value);
      if (key === "w") l.width = Math.round(clamp(value, PAGE_LIMITS));
      if (key === "h") l.height = Math.round(clamp(value, PAGE_LIMITS));
      if (key === "scale") l.scale = clamp(value, { min: 0.05, max: 8 });
      if (key === "opacity") l.opacity = clamp(value, { min: 0, max: 1 });
    } else {
      const aspect = box.width / box.height;
      const next =
        key === "x"
          ? { ...box, x: value }
          : key === "y"
            ? { ...box, y: value }
            : key === "w"
              ? { ...box, width: value, height: value / aspect }
              : key === "h"
                ? { ...box, width: value * aspect, height: value }
                : null;
      if (next) {
        // Width and height edits keep the box centred.
        if (key === "w" || key === "h") {
          next.x = box.x + (box.width - next.width) / 2;
          next.y = box.y + (box.height - next.height) / 2;
        }
        this.apply(item, next, key === "w" || key === "h");
      } else if (key === "scale") {
        const setting = item.kind === "hud" ? `hud.${item.key}.scale` : "playfield.scale";
        item.track.settings[setting] = round(clamp(value, limit(setting)));
      }
    }
    this.host.changed(item, true);
    this.render();
  }
  render() {
    const zoom = this.zoom();
    const cells = this.cells();
    const items = this.items();
    if (this.selection && !items.some((item) => this.same(this.selection, item)))
      this.selection = null;
    this.layer.replaceChildren(
      this.guides.x,
      this.guides.y,
      ...items.map((item) => {
        const box = this.boxOf(item);
        const node = document.createElement("div");
        node.className = `lay-box lay-box--${item.kind}`;
        node.tabIndex = 0;
        node.setAttribute("role", "button");
        node.setAttribute("aria-label", `${this.label(item)}: drag to move, arrow keys to nudge`);
        node.setAttribute("aria-pressed", String(this.same(this.selection, item)));
        Object.assign(node.style, {
          left: `${box.x * zoom}px`,
          top: `${box.y * zoom}px`,
          width: `${box.width * zoom}px`,
          height: `${box.height * zoom}px`,
        });
        const tag = document.createElement("span");
        tag.className = "lay-tag";
        tag.textContent = this.label(item);
        node.append(tag);
        if (this.same(this.selection, item))
          for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
            const handle = document.createElement("span");
            handle.className = `lay-handle lay-handle--${corner}`;
            handle.onpointerdown = (event) => this.drag(event, item, corner, cells);
            node.append(handle);
          }
        node.onpointerdown = (event) => {
          if ((event.target as HTMLElement).classList.contains("lay-handle")) return;
          this.drag(event, item, null, cells);
        };
        node.onkeydown = (event) => this.nudge(event, item);
        return node;
      }),
    );
    this.renderInspector();
    const layers = this.host.layers(),
      tracks = this.host.tracks();
    this.host.rendered(
      items
        .filter((item) => item.kind === "overlay")
        .map((item) => ({
          overlay: layers.indexOf(item.layer),
          track: tracks.indexOf(item.track),
          box: this.boxOf(item),
        })),
      zoom,
    );
  }
  private renderInspector() {
    const item = this.selection;
    this.inspector.root.hidden = !item;
    if (!item) return;
    const box = this.boxOf(item);
    this.inspector.title.textContent = this.label(item);
    const f = this.fields;
    const set = (input: HTMLInputElement, value: number, digits = 0) => {
      if (document.activeElement !== input) input.value = value.toFixed(digits);
    };
    // Overlays repeat in every player's cell: their X/Y are from the cell's corner.
    set(f.x, item.kind === "overlay" ? item.layer.x : box.x);
    set(f.y, item.kind === "overlay" ? item.layer.y : box.y);
    if (item.kind === "overlay") {
      set(f.w, item.layer.width);
      set(f.h, item.layer.height);
      set(f.scale, item.layer.scale, 2);
      set(f.opacity, item.layer.opacity, 2);
    } else {
      set(f.w, box.width);
      set(f.h, box.height);
      set(f.scale, (item.kind === "hud" ? hudTransform(item.track, item.key) : transformOf(item.track)).scale, 2);
    }
    f.opacity.closest("label")!.hidden = item.kind !== "overlay";
    f.w.closest("label")!.querySelector("span")!.textContent = item.kind === "overlay" ? "Page W" : "W";
    f.h.closest("label")!.querySelector("span")!.textContent = item.kind === "overlay" ? "Page H" : "H";
  }
  private showGuides(lines: { x: number | null; y: number | null }) {
    const zoom = this.zoom();
    this.guides.x.hidden = lines.x === null;
    this.guides.y.hidden = lines.y === null;
    if (lines.x !== null) this.guides.x.style.left = `${lines.x * zoom}px`;
    if (lines.y !== null) this.guides.y.style.top = `${lines.y * zoom}px`;
  }
  private drag(event: PointerEvent, item: Item, corner: Corner | null, cells: Rect[]) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.same(this.selection, item)) this.select(item);
    // Boxes are rebuilt on every render, so the persistent layer owns the gesture.
    const target = this.layer;
    target.setPointerCapture(event.pointerId);
    const zoom = this.zoom();
    const start = this.boxOf(item);
    const origin = { x: event.clientX, y: event.clientY };
    const { width, height } = this.host.output();
    const guides = guidesFor({ x: 0, y: 0, width, height }, cells);
    const threshold = SNAP / zoom;
    const rect = this.layer.getBoundingClientRect();
    let moved = false;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - origin.x) / zoom,
        dy = (e.clientY - origin.y) / zoom;
      if (!moved && Math.hypot(dx, dy) * zoom < 2) return;
      moved = true;
      let result;
      if (corner) {
        const point = { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
        const lock = item.kind !== "overlay" || e.shiftKey;
        result = resizeBox(start, corner, point, {
          aspect: lock ? start.width / start.height : undefined,
          guides: e.altKey ? undefined : guides,
          threshold,
        });
      } else {
        const box = { ...start, x: start.x + dx, y: start.y + dy };
        result = e.altKey ? { box, lines: { x: null, y: null } } : snapMove(box, guides, threshold);
      }
      this.apply(item, result.box, !!corner);
      this.showGuides(result.lines);
      this.host.changed(item, false);
      this.render();
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      this.showGuides({ x: null, y: null });
      if (moved) this.host.changed(item, true);
      this.render();
      (this.layer.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
  private nudge(event: KeyboardEvent, item: Item) {
    const step = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[
      event.key
    ];
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.select(item);
      return;
    }
    if (!delta) return;
    event.preventDefault();
    if (!this.same(this.selection, item)) this.select(item);
    const box = this.boxOf(item);
    this.apply(item, { ...box, x: box.x + delta[0], y: box.y + delta[1] }, false);
    this.host.changed(item, true);
    this.render();
    (this.layer.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus();
  }
}
/** Settings keep four decimals: enough for sub-pixel placement at 8K. */
const round = (value: number) => Math.round(value * 1e4) / 1e4;
