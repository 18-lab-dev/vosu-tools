import { maniaBlock, parseIni, type Ini } from "./ini";
import type { Recipe } from "./plan";

/** Persist observes every mutation, so even edit -> undo (an ABA) invalidates work. */
export class KeymodeGenerations {
  #states = new Map<number, { signature: string; generation: number }>();

  #signature(keys: number, recipe: Recipe, scope: string, sections: Ini) {
    return JSON.stringify([
      scope, recipe.base, recipe.overrides,
      Object.entries(recipe.picks).filter(([id]) => !id.startsWith("mania-keys-") || id === `mania-keys-${keys}`),
      recipe.keymodes?.[String(keys)], maniaBlock(sections, keys),
      sections.filter((section) => section.name.toLowerCase() === "general"),
    ]);
  }

  #observe(keys: number, recipe: Recipe, scope: string, sections: Ini) {
    const signature = this.#signature(keys, recipe, scope, sections);
    const before = this.#states.get(keys);
    if (!before || before.signature !== signature)
      this.#states.set(keys, { signature, generation: before ? before.generation + 1 : 0 });
    return this.#states.get(keys)!.generation;
  }

  /** Called synchronously after accepted edits, undo, redo, clear, reset and recovery. */
  observe(recipe: Recipe, scope: string, text: string) {
    const sections = parseIni(text);
    for (const keys of this.#states.keys()) this.#observe(keys, recipe, scope, sections);
  }

  capture(keys: number, recipe: Recipe, scope: string, text: string): number {
    return this.#observe(keys, recipe, scope, parseIni(text));
  }
}
