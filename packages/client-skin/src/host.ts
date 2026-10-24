/**
 * The client's current skin as reported by vosu. `GET /files/skin/` on the
 * overlay origin returns `{client, name, files, builtin, base}`; when `files`
 * is true, `/files/skin/<path>` serves the skin by filename for both stable
 * and lazer. `builtin` names a lazer built-in skin (no files); `base` is the
 * skin family a lazer user skin derives from.
 */
import type { BuiltinSkinName } from "@vosu-tools/render-core";

/** `fetch` on the overlay origin (the global one, or a stand-in in tests). */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostSkinEntry {
  /** Relative path with `/` separators, as vosu serves it. */
  path: string;
  size: number;
  /** Stable: modification time (ms). */
  modified?: number;
  /** lazer: the file store hash. */
  hash?: string;
}

export interface HostSkinInfo {
  client: "stable" | "lazer" | null;
  name: string | null;
  files: boolean;
  builtin: string | null;
  base: string | null;
  /**
   * Every file of the skin, when vosu lists them (and the list is complete):
   * only these are requested. Older vosu (or a truncated list): undefined,
   * and files are probed by name.
   */
  entries?: HostSkinEntry[];
}

/** What the preview should show for the client's current skin. */
export type CurrentSkin =
  /** Load the files; missing elements fall back to `fallback`'s look. */
  | {
      kind: "files";
      info: HostSkinInfo;
      name: string;
      fallback: BuiltinSkinName;
    }
  /** Draw a client built-in skin (optionally with the user skin's colours from files). */
  | {
      kind: "builtin";
      info: HostSkinInfo;
      name: string;
      look: BuiltinSkinName;
      coloursFromFiles: boolean;
      message?: string;
    }
  /** The current skin cannot be shown; the classic look is used. */
  | { kind: "unavailable"; info?: HostSkinInfo; message: string };

const builtinNames: Record<string, string> = {
  argon: "Argon",
  "argon-pro": "Argon Pro",
  triangles: "Triangles",
  legacy: "osu! (classic)",
  retro: "osu! “retro” (2007)",
};
/** Families drawn by the preview; "retro" uses the classic look. */
function look(family: string | null): BuiltinSkinName {
  return family === "argon" || family === "argon-pro" || family === "triangles"
    ? family
    : "legacy";
}

/** Interprets the host's skin report. */
export async function readCurrentSkin(
  fetcher: Fetcher = fetch,
): Promise<CurrentSkin> {
  let response: Response;
  try {
    response = await fetcher("/files/skin/", { cache: "no-store" });
  } catch {
    return {
      kind: "unavailable",
      message: "Could not reach vosu; showing the classic look.",
    };
  }
  let info: HostSkinInfo | undefined;
  if (response.ok)
    try {
      const body = await response.json();
      if (body && typeof body === "object" && typeof body.files === "boolean") {
        const text = (v: unknown) => (typeof v === "string" && v ? v : null);
        info = {
          client:
            body.client === "stable" || body.client === "lazer"
              ? body.client
              : null,
          name: text(body.name),
          files: body.files,
          builtin: text(body.builtin),
          base: text(body.base),
          entries:
            Array.isArray(body.entries) && body.truncated !== true
              ? body.entries.filter(
                  (e: unknown): e is HostSkinEntry =>
                    !!e && typeof (e as HostSkinEntry).path === "string",
                )
              : undefined,
        };
      }
    } catch {
      /* Older hosts answer this path with something other than the report. */
    }
  if (!info)
    return {
      kind: "unavailable",
      message:
        "This vosu does not report the current skin; showing the classic look.",
    };
  if (!info.client)
    return {
      kind: "unavailable",
      info,
      message: "No osu! client is connected; showing the classic look.",
    };
  if (info.builtin) {
    const name = info.name ?? builtinNames[info.builtin] ?? info.builtin;
    return {
      kind: "builtin",
      info,
      name,
      look: look(info.builtin),
      coloursFromFiles: false,
      message:
        info.builtin === "retro"
          ? `“${name}” is shown with the classic look.`
          : undefined,
    };
  }
  const name = info.name ?? "Current skin";
  if (info.base && info.base !== "legacy" && info.base !== "retro")
    // lazer user skins based on Argon or Triangles draw gameplay with that
    // family's code; their files only add configuration such as colours.
    return {
      kind: "builtin",
      info,
      name,
      look: look(info.base),
      coloursFromFiles: info.files,
    };
  if (!info.files)
    return {
      kind: "unavailable",
      info,
      message: `Files of “${name}” are unavailable; showing the classic look.`,
    };
  return { kind: "files", info, name, fallback: "legacy" };
}

export interface HostSkinFiles {
  resolve(path: string): Promise<Blob | null>;
  readonly served: number;
  readonly failures: number;
}
/**
 * Resolves skin files by filename through `/files/skin/<path>`, keeping
 * subfolder separators, and counts what the host actually served. With the
 * host's file list, names it does not list in any letter case are answered
 * without a request (most of a skin loader's lookups are for files a skin
 * lacks: @2x variants, animation frames). A listed name is requested exactly
 * as asked: the host matches the exact path first and only then folds case,
 * so picking a listed spelling here would turn `Note1.png` and `note1.png`
 * on a case-sensitive disk into one asset.
 */
export function hostSkinFiles(
  fetcher: Fetcher = fetch,
  entries?: readonly HostSkinEntry[],
): HostSkinFiles {
  let served = 0,
    failures = 0;
  const folded = entries && new Set(entries.map((e) => e.path.toLowerCase()));
  return {
    async resolve(path) {
      const name = path.replace(/\\/g, "/");
      if (folded && !folded.has(name.toLowerCase())) return null;
      const url =
        "/files/skin/" + name.split("/").map(encodeURIComponent).join("/");
      const response = await fetcher(url);
      if (response.ok) {
        served++;
        return response.blob();
      }
      if (response.status !== 404) failures++;
      return null;
    },
    get served() {
      return served;
    },
    get failures() {
      return failures;
    },
  };
}
