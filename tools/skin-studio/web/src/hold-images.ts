import { holdPlan, type Offsets } from "./calibrate";
import type { SlotImage } from "./keymodes";
import type { HitHost, DeriveOp } from "./hit-panel";
import { UPLOADS } from "./uploads";

/** Everything that can change hold-end pixels or their output image units. */
export function holdPairKey(release: Offsets, tail: SlotImage, body: SlotImage, noteWidth: number, bodyStyle: number, atTop: boolean): string {
  return JSON.stringify([
    [tail.skin, tail.name, tail.files.map((file) => [file.from, file.suffix])],
    [body.skin, body.name, body.files.map((file) => [file.from, file.suffix])],
    release.distance, noteWidth, bodyStyle, atTop,
  ]);
}

type ImageFile = SlotImage["files"][number];
interface ImageRows { width: number; height: number; top: number; bottom: number }
const densityOf = (file: ImageFile) => /@2x\.[^.]+$/i.test(file.suffix) ? 2 : 1;
const frameOf = (file: ImageFile) => /^-(\d+)/.exec(file.suffix)?.[1];

/** Transform complete image units; frame loops are combined, never flattened. */
export async function calibrateHoldImages(
  host: Pick<HitHost, "rows" | "derive">,
  release: Offsets, tail: SlotImage, body: SlotImage,
  noteWidth: number, bodyStyle: number, atTop: boolean, report: string[],
): Promise<Record<string, SlotImage>> {
  const dimensions = new Map<string, Promise<ImageRows>>();
  const rows = (image: SlotImage, file: ImageFile) => {
    const key = JSON.stringify([image.skin, file.from]);
    let found = dimensions.get(key);
    if (!found) {
      found = host.rows(image.skin, file.from);
      dimensions.set(key, found);
    }
    return found;
  };
  const derive = async (skin: string, name: string, op: DeriveOp, cap?: string) => {
    const [made] = await host.derive(skin, [{ name, op, ...(cap === undefined ? {} : { cap }) }]);
    return made.stored;
  };
  const output: Record<string, SlotImage> = {};
  const add = (role: string, image: SlotImage, from: string, suffix: string) => {
    const slot = output[role] ??= { skin: UPLOADS, name: image.name.split("/").pop()!, files: [] };
    slot.files.push({ from, suffix });
  };
  const tailFrames = Math.max(0, ...tail.files.map((file) => Number(frameOf(file) ?? -1) + 1));
  const bodyFrames = Math.max(0, ...body.files.map((file) => Number(frameOf(file) ?? -1) + 1));
  const select = (image: SlotImage, count: number, frame: number | null, density: number): ImageFile => {
    const chosen = frame === null && image.files.some((file) => frameOf(file) === undefined) ? undefined : count ? String((frame ?? 0) % count) : undefined;
    const candidates = image.files.filter((file) => frameOf(file) === chosen);
    return candidates.find((file) => densityOf(file) === density) ?? candidates[0];
  };
  const sampleBody = select(body, bodyFrames, 0, 1);
  const [tailDims, b] = await Promise.all([Promise.all(tail.files.map((file) => rows(tail, file))), rows(body, sampleBody)]);
  const t = tailDims.find((dim) => dim.height > dim.top + dim.bottom) ?? tailDims[0];
  const blank = tailDims.every((dim) => dim.height === dim.top + dim.bottom);
  const plan = holdPlan(release, { capRows: t.height - t.top - t.bottom, tailWidth: t.width, bodyHeight: b.height, bodyTop: b.top, noteWidth, percy: blank && bodyStyle !== 0 });
  if (plan.kind === "none") {
    report.push(plan.note);
    return output;
  }
  if (plan.kind === "shift-body" || plan.kind === "gap") {
    const image = plan.kind === "gap" ? tail : body;
    for (const file of image.files) {
      const dim = await rows(image, file);
      const filePlan = plan.kind === "gap"
        ? holdPlan(release, { capRows: dim.height - dim.top - dim.bottom, tailWidth: dim.width, bodyHeight: b.height, bodyTop: b.top, noteWidth, percy: false })
        : holdPlan(release, { capRows: 0, tailWidth: t.width, bodyHeight: dim.height, bodyTop: dim.top, noteWidth, percy: true });
      report.push(filePlan.note);
      if (filePlan.kind === "gap")
        add("T", tail, await derive(tail.skin, file.from, { tail: { gap: filePlan.gap, at_top: atTop } }), file.suffix);
      else if (filePlan.kind === "shift-body")
        add("L", body, await derive(body.skin, file.from, { shift: { up: filePlan.up } }), file.suffix);
    }
    return output;
  }

  // A converted body's cap and texture may have different animation loop
  // lengths. Their least common multiple preserves both at the skin's FPS.
  let a = tailFrames || 1, bFrames = bodyFrames || 1;
  while (bFrames) [a, bFrames] = [bFrames, a % bFrames];
  const count = tailFrames || bodyFrames ? (tailFrames || 1) * (bodyFrames || 1) / a : 0;
  const frames: (number | null)[] = count ? Array.from({ length: count }, (_, i) => i) : [null];
  if (count && tail.files.some((file) => frameOf(file) === undefined) && body.files.some((file) => frameOf(file) === undefined)) frames.unshift(null);
  const densities = new Set([...tail.files, ...body.files].map(densityOf));
  for (const density of densities) for (const frame of frames) {
    const capFile = select(tail, tailFrames, frame, density);
    const bodyFile = select(body, bodyFrames, frame, density);
    const capDim = await rows(tail, capFile);
    const ratio = density / densityOf(capFile);
    const height = Math.max(1, Math.round(capDim.height * ratio));
    const width = Math.max(1, Math.round(capDim.width * ratio));
    const filePlan = holdPlan(release, {
      capRows: Math.round((capDim.height - capDim.top - capDim.bottom) * ratio),
      tailWidth: width, bodyHeight: b.height, bodyTop: b.top, noteWidth, percy: false,
    });
    if (filePlan.kind !== "percy") throw new Error("The hold conversion plan changed unexpectedly.");
    report.push(filePlan.note);
    let capSkin = tail.skin, capName = capFile.from;
    if (ratio !== 1) {
      capName = await derive(capSkin, capName, { resize: { width, height, scale_y: ratio, up: 0 } });
      capSkin = UPLOADS;
    }
    let bodySkin = body.skin, bodyName = bodyFile.from;
    if (capSkin !== bodySkin) {
      if (capSkin !== UPLOADS) capName = await derive(capSkin, capName, { shift: { up: 0 } });
      if (bodySkin !== UPLOADS) bodyName = await derive(bodySkin, bodyName, { shift: { up: 0 } });
      capSkin = bodySkin = UPLOADS;
    }
    const suffix = `${frame === null ? "" : `-${frame}`}${density === 2 ? "@2x" : ""}`;
    add("T", tail, await derive(capSkin, capName, { spacer: { rows: filePlan.spacer } }), `${suffix}${/\.[^.]+$/.exec(capFile.suffix)![0]}`);
    add("L", body, await derive(bodySkin, bodyName, { percy: { height: filePlan.height, cap_bottom: filePlan.capBottom } }, capName), `${suffix}${/\.[^.]+$/.exec(bodyFile.suffix)![0]}`);
  }
  return output;
}
