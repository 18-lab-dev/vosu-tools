import type { BuiltinSkinName } from "@vosu-tools/render-core";

/** Effective values of tools/map-preview/settings.json. */
export interface PreviewSettings {
  skin: "client" | BuiltinSkinName;
  maniaScrollSpeed: number;
  noteSpeed: number;
  showBar: boolean;
  showProgress: boolean;
  controlsOpen: boolean;
}
export const defaultSettings: PreviewSettings = {
  skin: "client",
  maniaScrollSpeed: 0,
  noteSpeed: 1,
  showBar: true,
  showProgress: true,
  controlsOpen: false,
};

const skins = ["client", "argon", "argon-pro", "triangles", "legacy"];

/** Normalises raw `{uniqueID: value}` settings; anything invalid keeps its default. */
export function parseSettings(
  values: Record<string, unknown>,
): PreviewSettings {
  const number = (key: string, min: number, max: number, fallback: number) => {
    const v = Number(values[key]);
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
  };
  const flag = (key: string, fallback: boolean) =>
    typeof values[key] === "boolean" ? (values[key] as boolean) : fallback;
  return {
    skin: skins.includes(String(values.skin))
      ? (values.skin as PreviewSettings["skin"])
      : defaultSettings.skin,
    maniaScrollSpeed: number("mania_scroll_speed", 0, 40, 0),
    noteSpeed: number("note_speed", 0.1, 5, 1),
    showBar: flag("show_bar", true),
    showProgress: flag("show_progress", true),
    controlsOpen: flag("controls_open", false),
  };
}

/**
 * Reads the tool's settings: the bridge helper when present, else the
 * read-only `/tools/<id>/_settings` route, else defaults (older vosu).
 */
export async function readSettings(
  bridge: {
    settings?: () => Promise<Record<string, unknown>>;
    tool: { id: string };
  },
  fetcher: typeof fetch = fetch,
): Promise<{ settings: PreviewSettings; source: "vosu" | "defaults" }> {
  try {
    if (bridge.settings)
      return {
        settings: parseSettings(await bridge.settings()),
        source: "vosu",
      };
    const response = await fetcher(
      `/tools/${encodeURIComponent(bridge.tool.id)}/_settings`,
      { cache: "no-store" },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        values?: Record<string, unknown>;
      };
      if (body && typeof body.values === "object" && body.values)
        return { settings: parseSettings(body.values), source: "vosu" };
    }
  } catch {
    /* Older hosts have no settings route; defaults apply. */
  }
  return { settings: { ...defaultSettings }, source: "defaults" };
}
