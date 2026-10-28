import type { KeymodeDraft, Keymodes, SlotImage } from "./keymodes";
import { UPLOADS } from "./uploads";

export interface MissingSource {
  key: string;
  name: string;
  slots: number;
  counts: number[];
  hash?: string;
}
const image = (slot: unknown): slot is SlotImage => !!slot && typeof slot === "object" && "files" in slot;
/** Include hidden geometry originals: the composed plan alone cannot reveal them. */
export function sourceSlots(draft: KeymodeDraft): Map<string, SlotImage[]> {
  const slots = new Map<string, SlotImage[]>();
  const add = (key: string, slot: unknown) => {
    if (image(slot)) slots.set(key, [...(slots.get(key) ?? []), slot]);
  };
  for (const [key, slot] of Object.entries(draft.images)) add(key, slot);
  for (const [key, original] of Object.entries(draft.hit?.originals ?? {})) {
    add(key, original.slot);
    add(key, original.prior);
  }
  return slots;
}
/** Unique source filenames, including files only the geometry history needs. */
export function sourceFileNames(drafts: Keymodes, source: string): Set<string> {
  const names = new Set<string>();
  for (const draft of Object.values(drafts))
    for (const refs of sourceSlots(draft).values())
      for (const slot of refs)
        if (slot.skin === source)
          for (const file of slot.files) names.add(file.from.replace(/\\/g, "/").toLowerCase());
  return names;
}

export function missingSources(drafts: Keymodes, available: ReadonlySet<string>): MissingSource[] {
  const found = new Map<string, MissingSource>();
  for (const [count, draft] of Object.entries(drafts)) {
    for (const refs of sourceSlots(draft).values()) {
      for (const key of new Set(refs.map((s) => s.skin))) {
        if (key === UPLOADS || available.has(key)) continue;
        const item = found.get(key) ?? { key, name: refs.find((s) => s.skin === key)?.sourceName ?? key, hash: refs.find((s) => s.skin === key)?.sourceHash, slots: 0, counts: [] };
        item.slots++;
        if (!item.counts.includes(Number(count))) item.counts.push(Number(count));
        found.set(key, item);
      }
    }
  }
  return [...found.values()];
}
export type Recovery = { kind: "remap"; key: string; name: string; hash?: string } | { kind: "keep" } | { kind: "remove" };
/** Mutates only a clone; callers commit the whole recovery as an undo step. */
export function recoverSource(draft: KeymodeDraft, missing: string, recovery: Recovery): void {
  for (const [key, refs] of sourceSlots(draft)) {
    if (!refs.some((s) => s.skin === missing)) continue;
    if (recovery.kind === "remap") {
      for (const slot of refs) if (slot.skin === missing) {
        slot.skin = recovery.key;
        slot.sourceName = recovery.name;
        slot.sourceHash = recovery.hash;
      }
    } else if (recovery.kind === "remove") {
      delete draft.images[key];
      if (draft.hit) delete draft.hit.originals[key];
    } else {
      const current = draft.images[key];
      if (!image(current) || current.skin !== UPLOADS)
        throw new Error(`${key} has no retained derived image. Remap or remove it instead.`);
      // Rebase geometry onto the retained image at the current dimensions. This
      // explicitly accepts previous resampling/cropping; lost pixels cannot return.
      if (draft.hit) delete draft.hit.originals[key];
    }
  }
  if (draft.hit && !Object.keys(draft.hit.originals).length) delete draft.hit;
}
