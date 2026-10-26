import { parseSkinIni } from "@vosu-tools/osu-parse";
import { resolve as resolveCommand } from "@vosu-tools/skin-spec";
import type { Skin } from "./skin";

/**
 * A skin's skin.ini as the loader reads it (null: the skin has none):
 * sections, the format version (`latest` and no skin.ini are the newest,
 * no `Version` is 1) and the frame rate; commands newer than the version
 * are dropped as the clients ignore them.
 */
export function readSkinIni(
  text: string | null,
): Pick<Skin, "sections" | "version" | "frameRate"> {
  const sections: Skin["sections"] =
    text === null ? new Map() : parseSkinIni(text);
  const general = sections.get("General")?.[0] ?? {};
  const version =
    text === null || general.Version?.toLowerCase() === "latest"
      ? Infinity
      : Number(general.Version ?? 1);
  for (const [section, blocks] of sections)
    for (const block of blocks)
      for (const key of Object.keys(block)) {
        const rule = resolveCommand(section, key);
        if (rule?.since && version < rule.since) delete block[key];
      }
  return {
    sections,
    version,
    frameRate:
      Number(general.AnimationFramerate) > 0
        ? Number(general.AnimationFramerate)
        : -1,
  };
}
