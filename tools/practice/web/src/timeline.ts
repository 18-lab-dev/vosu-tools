// Trim strip: a difficulty graph over source time with draggable kept ranges.
// Drag on empty strip to add a range, drag a range to move it, drag its edges
// to resize it; a click without dragging seeks the preview.
import { clock, type Range, type Window } from './time';
export type TimelineData = {
  source: string;
  label: string;
  note?: string | null;
  duration_ms: number;
  points: [number, number][];
  objects: number[];
};

const SVG = 'http://www.w3.org/2000/svg';
const MIN_RANGE_MS = 250;

export class Timeline {
  private data: TimelineData | null = null;
  private ranges: Range[] = [];
  private windows: Window[] = [];
  private readonly graph: SVGSVGElement;
  private readonly layer: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly axis: HTMLElement;

  constructor(
    private readonly strip: HTMLElement,
    axis: HTMLElement,
    private readonly onChange: (ranges: Range[]) => void,
    private readonly onSeek: (sourceMs: number) => void,
  ) {
    this.graph = strip.querySelector('svg')!;
    this.layer = strip.querySelector('.ranges')!;
    this.playhead = strip.querySelector('.playhead')!;
    this.axis = axis;
    strip.addEventListener('pointerdown', (event) => this.pointerDown(event));
    new ResizeObserver(() => this.drawAxis()).observe(strip);
  }

  get duration(): number {
    return this.data?.duration_ms ?? 0;
  }

  /** Objects whose start lies in `range` (the ones a trim keeps). */
  objectsIn(range: Range): number {
    const objects = this.data?.objects ?? [];
    const lower = (t: number) => {
      let lo = 0, hi = objects.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (objects[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return lower(range.end_ms + 0.001) - lower(range.start_ms);
  }

  setData(data: TimelineData | null): void {
    this.data = data;
    this.drawGraph();
    this.drawAxis();
    this.drawRanges();
  }

  setRanges(ranges: Range[], windows: Window[] = this.windows): void {
    this.ranges = ranges.map((r) => ({ ...r })).sort((a, b) => a.start_ms - b.start_ms);
    this.windows = windows;
    this.drawRanges();
  }

  setWindows(windows: Window[]): void {
    this.windows = windows;
    this.drawRanges();
  }

  setPlayhead(sourceMs: number | null): void {
    if (sourceMs === null || !this.duration) {
      this.playhead.hidden = true;
      return;
    }
    this.playhead.hidden = false;
    this.playhead.style.left = `${(sourceMs / this.duration) * 100}%`;
  }

  private x(t: number): number {
    return (t / this.duration) * 100;
  }

  private drawGraph(): void {
    this.graph.replaceChildren();
    const data = this.data;
    if (!data || !data.points.length || !data.duration_ms) return;
    const peak = Math.max(...data.points.map((p) => p[1]), 1e-9);
    this.graph.setAttribute('viewBox', `0 0 1000 100`);
    const xy = data.points.map(([t, v]) => `${((t / data.duration_ms) * 1000).toFixed(2)},${(100 - (v / peak) * 92).toFixed(2)}`);
    const area = document.createElementNS(SVG, 'path');
    area.setAttribute('d', `M0,100 L${xy.join(' L')} L1000,100 Z`);
    area.setAttribute('class', 'graph-area');
    const line = document.createElementNS(SVG, 'path');
    line.setAttribute('d', `M${xy.join(' L')}`);
    line.setAttribute('class', 'graph-line');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    this.graph.append(area, line);
  }

  private drawAxis(): void {
    this.axis.replaceChildren();
    if (!this.duration) return;
    const width = this.strip.clientWidth || 1;
    // A label every ≥ 80 px, on a whole number of seconds from a friendly set.
    const steps = [5, 10, 15, 30, 60, 120, 300].map((s) => s * 1000);
    const step = steps.find((s) => (s / this.duration) * width >= 80) ?? steps[steps.length - 1];
    for (let t = 0; t <= this.duration; t += step) {
      const tick = document.createElement('span');
      tick.style.left = `${this.x(t)}%`;
      tick.textContent = clock(t);
      this.axis.append(tick);
    }
  }

  private drawRanges(): void {
    this.layer.replaceChildren();
    if (!this.duration) return;
    for (const w of this.windows) {
      const pad = document.createElement('div');
      pad.className = 'window';
      pad.style.left = `${this.x(w.source_start)}%`;
      pad.style.width = `${this.x(w.source_end - w.source_start)}%`;
      this.layer.append(pad);
    }
    this.ranges.forEach((r, index) => {
      const el = document.createElement('div');
      el.className = 'range';
      el.dataset.index = String(index);
      el.style.left = `${this.x(r.start_ms)}%`;
      el.style.width = `${this.x(r.end_ms - r.start_ms)}%`;
      el.title = `${clock(r.start_ms, true)}–${clock(r.end_ms, true)} · ${this.objectsIn(r)} objects`;
      for (const edge of ['start', 'end']) {
        const handle = document.createElement('span');
        handle.className = `handle handle-${edge}`;
        handle.dataset.edge = edge;
        el.append(handle);
      }
      this.layer.append(el);
    });
  }

  private time(clientX: number): number {
    const box = this.strip.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return Math.round(f * this.duration);
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.duration || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const rangeEl = target.closest<HTMLElement>('.range');
    const index = rangeEl ? Number(rangeEl.dataset.index) : -1;
    const edge = target.dataset.edge as 'start' | 'end' | undefined;
    const origin = this.time(event.clientX);
    const before = this.ranges.map((r) => ({ ...r }));
    let moved = false;
    this.strip.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const t = this.time(e.clientX);
      if (!moved && Math.abs(e.clientX - event.clientX) < 4) return;
      moved = true;
      const next = before.map((r) => ({ ...r }));
      if (index >= 0 && edge) {
        const r = next[index];
        if (edge === 'start') r.start_ms = Math.min(t, r.end_ms - MIN_RANGE_MS);
        else r.end_ms = Math.max(t, r.start_ms + MIN_RANGE_MS);
      } else if (index >= 0) {
        const r = next[index];
        const length = r.end_ms - r.start_ms;
        const start = Math.min(Math.max(0, r.start_ms + t - origin), this.duration - length);
        r.start_ms = start;
        r.end_ms = start + length;
      } else {
        next.push({ start_ms: Math.min(origin, t), end_ms: Math.max(origin, t, Math.min(origin, t) + MIN_RANGE_MS) });
      }
      this.ranges = next.sort((a, b) => a.start_ms - b.start_ms);
      this.drawRanges();
    };
    const up = (e: PointerEvent) => {
      this.strip.removeEventListener('pointermove', move);
      this.strip.removeEventListener('pointerup', up);
      this.strip.removeEventListener('pointercancel', up);
      if (moved) this.onChange(this.ranges.map((r) => ({ ...r })));
      else this.onSeek(this.time(e.clientX));
    };
    this.strip.addEventListener('pointermove', move);
    this.strip.addEventListener('pointerup', up);
    this.strip.addEventListener('pointercancel', up);
  }
}
