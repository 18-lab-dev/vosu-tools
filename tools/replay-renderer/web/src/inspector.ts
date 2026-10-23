import type { Rect } from "./layout";

/** One drawn layer, in paint order, with the time its draw took this frame. */
export interface InspectedLayer {
  name: string;
  kind: "background" | "playfield" | "hud" | "overlay";
  box: Rect;
  ms: number | null;
}

const COLOUR: Record<InspectedLayer["kind"], string> = {
  background: "#5ec8f2",
  playfield: "#ff5fd2",
  hud: "#6be37a",
  overlay: "#ffb347",
};

/**
 * Composition inspector (development aid, off by default; `?inspect` in the
 * studio URL or a debug export): draws cell bounds, the 5 % action-safe and
 * 10 % title-safe areas, every layer's box with its name and paint order, and
 * a legend with per-layer draw times and the frame's clock.
 */
export function drawInspector(
  context: CanvasRenderingContext2D,
  frame: { width: number; height: number },
  cells: readonly Rect[],
  layers: readonly InspectedLayer[],
  clock: { time: number; start: number; end: number; dim: number },
) {
  const unit = Math.max(1, Math.min(frame.width, frame.height) / 1080);
  context.save();
  context.lineWidth = Math.max(1, Math.round(unit));
  context.font = `600 ${Math.round(13 * unit)}px monospace`;
  context.textBaseline = "top";
  // Safe areas over the whole frame.
  context.strokeStyle = "rgba(255, 230, 90, 0.85)";
  context.setLineDash([8 * unit, 6 * unit]);
  for (const inset of [0.05, 0.1])
    context.strokeRect(frame.width * inset, frame.height * inset, frame.width * (1 - 2 * inset), frame.height * (1 - 2 * inset));
  context.setLineDash([]);
  context.strokeStyle = COLOUR.background;
  cells.forEach((cell) => context.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.width - 1, cell.height - 1));
  layers.forEach((layer, index) => {
    if (layer.kind === "background") return;
    const { box } = layer;
    context.strokeStyle = context.fillStyle = COLOUR[layer.kind];
    if (layer.kind === "playfield") context.setLineDash([6 * unit, 4 * unit]);
    context.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1);
    context.setLineDash([]);
    const tag = `${index + 1} ${layer.name}`;
    const width = context.measureText(tag).width + 8 * unit;
    context.fillStyle = "rgba(0, 0, 0, 0.7)";
    context.fillRect(box.x, box.y, width, 18 * unit);
    context.fillStyle = COLOUR[layer.kind];
    context.fillText(tag, box.x + 4 * unit, box.y + 2 * unit);
  });
  // Legend: clock, then paint order with draw times.
  const lines = [
    `t ${(clock.time / 1000).toFixed(3)} s  [${(clock.start / 1000).toFixed(2)} … ${(clock.end / 1000).toFixed(2)}]  dim ${clock.dim.toFixed(2)}`,
    ...layers.map((layer, index) => `${String(index + 1).padStart(2)} ${layer.kind.padEnd(10)} ${layer.name.padEnd(18).slice(0, 18)} ${layer.ms === null ? "" : `${layer.ms.toFixed(1)} ms`}`),
  ];
  const lineHeight = 16 * unit,
    width = Math.max(...lines.map((line) => context.measureText(line).width)) + 16 * unit;
  const x = frame.width - width - 8 * unit,
    y = frame.height - lines.length * lineHeight - 16 * unit;
  context.fillStyle = "rgba(0, 0, 0, 0.75)";
  context.fillRect(x, y, width, lines.length * lineHeight + 8 * unit);
  lines.forEach((line, index) => {
    context.fillStyle = index === 0 ? "#ffffff" : COLOUR[layers[index - 1].kind];
    context.fillText(line, x + 8 * unit, y + 4 * unit + index * lineHeight);
  });
  context.restore();
}
