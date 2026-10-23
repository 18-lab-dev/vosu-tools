import { layoutRects, type Layout } from "@vosu-tools/render-export";
import settingSchema from "../../render-settings.json";
import {
  DEFAULT_TRANSFORM,
  guidesFor,
  place,
  resizeBox,
  snapMove,
  transformFor,
  type Corner,
  type Rect,
} from "./layout";
import { PAGE_LIMITS, type Layer } from "./overlay-layout";
import { transformOf, type Track } from "./studio";

/** A selectable thing in the frame: a track's playfield or an overlay layer. */
export type Item = { kind: "playfield"; track: Track } | { kind: "overlay"; layer: Layer };

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
      /** `commit` false while dragging: redraw only; true when an edit ends. */
      changed(item: Item, commit: boolean): void;
      selected(item: Item | null): void;
    },
  ) {
    this.layer.className = "editor";
    this.guides.x.className = "guide guide--x";
    this.guides.y.className = "guide guide--y";
    gate.append(this.layer);
    this.fields = inspector.fields;
    for (const [key, input] of Object.entries(this.fields))
      input.onchange = () => this.fromField(key as keyof typeof this.fields, Number(input.value));
    inspector.reset.onclick = () => this.reset();
    new ResizeObserver(() => this.render()).observe(gate);
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
    return layoutRects(tracks.length, width, height, this.host.layout());
  }
  private boxOf(item: Item): Rect {
    if (item.kind === "overlay") {
      const l = item.layer;
      return { x: l.x, y: l.y, width: l.width * l.scale, height: l.height * l.scale };
    }
    const index = this.host.tracks().indexOf(item.track);
    return place(this.cells()[index], item.track.content, transformOf(item.track)).box;
  }
  private items(): Item[] {
    return [
      ...this.host.tracks().map((track) => ({ kind: "playfield", track }) as Item),
      ...this.host.layers().map((layer) => ({ kind: "overlay", layer }) as Item),
    ];
  }
  private same(a: Item | null, b: Item) {
    return (
      !!a &&
      ((a.kind === "playfield" && b.kind === "playfield" && a.track === b.track) ||
        (a.kind === "overlay" && b.kind === "overlay" && a.layer === b.layer))
    );
  }
  private label(item: Item) {
    if (item.kind === "overlay") return item.layer.name;
    const index = this.host.tracks().indexOf(item.track);
    return `V${index + 1} ${item.track.replay.player}`;
  }
  /** Screen pixels per output pixel. */
  private zoom() {
    return this.layer.clientWidth / this.host.output().width || 1;
  }
  /** Writes `box` (output px) into the item, within the stored ranges. */
  private apply(item: Item, box: Rect, resized: boolean) {
    if (item.kind === "overlay") {
      const l = item.layer;
      l.x = Math.round(box.x);
      l.y = Math.round(box.y);
      if (resized) {
        l.width = Math.round(clamp(box.width / l.scale, { min: PAGE_LIMITS.min, max: PAGE_LIMITS.max }));
        l.height = Math.round(clamp(box.height / l.scale, { min: PAGE_LIMITS.min, max: PAGE_LIMITS.max }));
      }
      return;
    }
    const index = this.host.tracks().indexOf(item.track);
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
    } else Object.assign(item.layer, { x: 0, y: 0, scale: 1, opacity: 1 });
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
      } else if (key === "scale")
        item.track.settings["playfield.scale"] = round(clamp(value, limit("playfield.scale")));
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
    set(f.x, box.x);
    set(f.y, box.y);
    if (item.kind === "overlay") {
      set(f.w, item.layer.width);
      set(f.h, item.layer.height);
      set(f.scale, item.layer.scale, 2);
      set(f.opacity, item.layer.opacity, 2);
    } else {
      set(f.w, box.width);
      set(f.h, box.height);
      set(f.scale, transformOf(item.track).scale, 2);
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
        const lock = item.kind === "playfield" || e.shiftKey;
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
