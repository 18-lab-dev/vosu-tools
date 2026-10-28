import type { Offsets } from "./calibrate";
import type { SlotImage } from "./keymodes";

/** Everything that can change hold-end pixels or their output image units. */
export function holdPairKey(release: Offsets, tail: SlotImage, body: SlotImage, noteWidth: number, bodyStyle: number, atTop: boolean): string {
  return JSON.stringify([
    [tail.skin, tail.name, tail.files.map((file) => [file.from, file.suffix])],
    [body.skin, body.name, body.files.map((file) => [file.from, file.suffix])],
    release.distance, noteWidth, bodyStyle, atTop,
  ]);
}
