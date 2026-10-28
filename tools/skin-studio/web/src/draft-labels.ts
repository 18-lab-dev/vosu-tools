import { type AssetRef, assetId, fontPrefixes, groupOf, unitFiles } from "./assets";
import { parseIni } from "./ini";
import type { Pick, Plan, Recipe } from "./plan";

export function pickLabel(pick: Pick | undefined, recipe: Recipe, skinName: (key: string) => string) {
  if (!pick) return recipe.base ? `base · ${skinName(recipe.base)}` : "built-in";
  if (pick.kind === "skin") return skinName(pick.key);
  return pick.kind === "default" ? "built-in" : "blank";
}

/** Toggle a group choice off to inherit the base; Built-in is an explicit default. */
export function groupChoice(pressed: boolean, next: Pick): Pick | null {
  return pressed ? null : next;
}

export function provenance(ref: AssetRef, recipe: Recipe, plan: Plan | null, skinName: (key: string) => string): { label: string; included: boolean } {
  const override = recipe.overrides?.[assetId(ref)];
  if (override) return { label: `Override · ${skinName(override.skin)}`, included: true };
  const output = new Map<string, string>();
  for (const source of plan?.sources ?? [])
    for (const file of source.files) output.set((typeof file === "string" ? file : file[1]).toLowerCase(), source.skin);
  const ini = parseIni(plan?.ini ?? "");
  const hit = unitFiles(ref, [...output.keys()], fontPrefixes(ini))[0];
  if (!hit) return { label: "Not included", included: false };
  const from = output.get(hit.toLowerCase())!;
  if (recipe.picks[groupOf(ref, ini)]?.kind === "skin") return { label: `Group · ${skinName(from)}`, included: true };
  return { label: from === recipe.base ? `Base · ${skinName(from)}` : skinName(from), included: true };
}

export function useButtonLabel(units: number, files: number, inMix: boolean, included: boolean): string {
  const count = `${files} ${files === 1 ? "file" : "files"}`;
  if (inMix) return "Remove from mix";
  if (included) return `Override with this · ${count}`;
  return `Use ${units > 1 ? `${units} assets` : "asset"} · ${count}`;
}
