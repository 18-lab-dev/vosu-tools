/** Legacy skin.ini image fields resolve PNG textures, not arbitrary image files. */
export type ImageLookupKind = "texture" | "animation" | "prefix";

/** GetTexture versus GetAnimation in lazer's legacy mania pieces. */
export function imageLookupKind(section: string, key: string): ImageLookupKind {
  if (/Prefix$/.test(key)) return "prefix";
  return section === "Mania" && /^(NoteImage\d*[HLT]?|StageBottom|StageLight|Lighting[NL]|Hit(?:0|50|100|200|300g?))$/.test(key)
    ? "animation" : "texture";
}

/** PNG extension and HD suffix are optional in the ini. Preserve literal dots. */
export function legacyImageName(value: string): string | undefined {
  const name = value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\.png$/i, "").replace(/@2x$/i, "");
  return !name || /^(\/|[A-Za-z]:)/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..") ? undefined : name;
}

/** Ordered concrete files requested by the renderer for one texture/frame. */
export function legacyTexturePaths(value: string, hd = true): string[] {
  const name = legacyImageName(value);
  return name ? [...(hd ? [`${name}@2x.png`] : []), `${name}.png`] : [];
}

function pngNames(files: readonly string[]) {
  const names = new Map<string, string>();
  for (const file of files) {
    if (!/\.png$/i.test(file)) continue;
    const name = legacyImageName(file);
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return names;
}

export function hasAsset(value: string, files: readonly string[], kind: ImageLookupKind = "animation"): boolean {
  const base = legacyImageName(value)?.toLowerCase();
  if (!base) return false;
  const names = pngNames(files);
  if (kind === "prefix") return Array.from({ length: 10 }, (_, i) => `${base}-${i}`).every((name) => names.has(name));
  return names.has(base) || (kind === "animation" && names.has(`${base}-0`));
}

/** Actual file spelling for completion, with HD and playable frames grouped. */
export function pathCandidates(files: readonly string[], kind: ImageLookupKind = "animation"): string[] {
  const names = pngNames(files), candidates = new Map<string, string>();
  for (const [lower, name] of names) {
    if (kind === "prefix") {
      if (!/-\d$/.test(lower)) continue;
      const base = lower.replace(/-\d$/, "");
      if (Array.from({ length: 10 }, (_, i) => `${base}-${i}`).every((digit) => names.has(digit))) candidates.set(base, name.replace(/-\d$/, ""));
    } else if (kind === "animation" && /-\d+$/.test(lower) && names.has(`${lower.replace(/-\d+$/, "")}-0`)) {
      const base = lower.replace(/-\d+$/, "");
      candidates.set(base, names.get(base) ?? names.get(`${base}-0`)!.replace(/-0$/, ""));
    } else candidates.set(lower, name);
  }
  return [...candidates.values()].sort();
}
