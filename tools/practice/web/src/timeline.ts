// Timeline: a difficulty graph over source time with the playhead and the kept
// (trim) sections. Gestures are in gesture.ts: drag scrubs the playhead, a
// click seeks, Shift+drag adds or moves a section, section edges resize. With
// the strip focused, Left/Right (Shift: 5 s) nudge the playhead.
import { Gesture, nudge, type Target } from './gesture';
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

export class Timeline {
  private data: TimelineData | null = null;
  private ranges: Range[] = [];
  private windows: Window[] = [];
  private readonly graph: SVGSVGElement;
  private readonly layer: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly axis: HTMLElement;

  private playheadTime = 0;

  constructor(
    private readonly strip: HTMLElement,
    axis: HTMLElement,
    private readonly onChange: (ranges: Range[]) => void,
    /** A click, the end of a scrub, or a key nudge: move the preview here. */
    private readonly onSeek: (sourceMs: number) => void,
    /** Live while the playhead is dragged. */
    private readonly onScrub: (sourceMs: number) => void,
  ) {
    this.graph = strip.querySelector('svg')!;
    this.layer = strip.querySelector('.ranges')!;
    this.playhead = strip.querySelector('.playhead')!;
    this.axis = axis;
    strip.addEventListener('pointerdown', (event) => this.pointerDown(event));
    // The cursor tells which gesture a press starts: Shift switches to trim.
    const shift = (on: boolean) => strip.classList.toggle('trim-mode', on);
    strip.addEventListener('pointermove', (event) => shift(event.shiftKey));
    strip.addEventListener('pointerleave', () => shift(false));
    addEventListener('keydown', (event) => { if (event.key === 'Shift' && strip.matches(':hover')) shift(true); });
    addEventListener('keyup', (event) => { if (event.key === 'Shift') shift(false); });
    strip.addEventListener('keydown', (event) => {
      const time = nudge(event.key, event.shiftKey, this.playheadTime, this.duration);
      if (time === null || !this.duration) return;
      event.preventDefault();
      this.setPlayhead(time);
      this.onSeek(time);
    });
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
      this.strip.removeAttribute('aria-valuenow');
      return;
    }
    this.playheadTime = sourceMs;
    this.playhead.hidden = false;
    this.playhead.style.left = `${(sourceMs / this.duration) * 100}%`;
    this.strip.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    this.strip.setAttribute('aria-valuenow', String(Math.round(sourceMs)));
    this.strip.setAttribute('aria-valuetext', clock(sourceMs, true));
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
    const element = event.target as HTMLElement;
    const rangeEl = element.closest<HTMLElement>('.range');
    const edge = element.dataset.edge;
    const target: Target = rangeEl && (edge === 'start' || edge === 'end')
      ? { kind: 'edge', index: Number(rangeEl.dataset.index), edge }
      : rangeEl ? { kind: 'range', index: Number(rangeEl.dataset.index) } : { kind: 'empty' };
    const gesture = new Gesture(target, event.shiftKey, event.clientX, this.time(event.clientX), this.ranges, this.duration);
    this.strip.setPointerCapture(event.pointerId);
    this.strip.dataset.gesture = gesture.mode;
    // Scrubbing jumps to the press at once, so grabbing anywhere works.
    if (gesture.mode === 'scrub') this.scrubTo(this.time(event.clientX));
    const move = (e: PointerEvent) => {
      const effect = gesture.move(e.clientX, this.time(e.clientX));
      if (effect.kind === 'scrub') this.scrubTo(effect.time);
      else if (effect.kind === 'ranges') {
        this.ranges = effect.ranges;
        this.drawRanges();
      }
    };
    const up = (e: PointerEvent) => {
      this.strip.removeEventListener('pointermove', move);
      this.strip.removeEventListener('pointerup', up);
      this.strip.removeEventListener('pointercancel', up);
      delete this.strip.dataset.gesture;
      const effect = gesture.end(this.time(e.clientX));
      if (effect.kind === 'seek') {
        this.setPlayhead(effect.time);
        this.onSeek(effect.time);
      } else if (effect.kind === 'commit') this.onChange(effect.ranges);
    };
    this.strip.addEventListener('pointermove', move);
    this.strip.addEventListener('pointerup', up);
    this.strip.addEventListener('pointercancel', up);
  }

  private scrubTo(time: number): void {
    this.setPlayhead(time);
    this.onScrub(time);
  }
}
