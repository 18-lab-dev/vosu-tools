/**
 * The client's current skin as reported by vosu. `GET /files/skin/` on the
 * overlay origin returns `{client, name, files, builtin, base}`; when `files`
 * is true, `/files/skin/<path>` serves the skin by filename for both stable
 * and lazer. `builtin` names a lazer built-in skin (no files); `base` is the
 * skin family a lazer user skin derives from.
 */
import type { BuiltinSkinName } from "@vosu-tools/render-core";

export interface HostSkinInfo {
  client: "stable" | "lazer" | null;
  name: string | null;
  files: boolean;
  builtin: string | null;
  base: string | null;
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

const elsewhere = "Load an .osk file or a skin folder for a specific skin.";

/** Interprets the host's skin report. */
export async function readCurrentSkin(
  fetcher: typeof fetch = fetch,
): Promise<CurrentSkin> {
  let response: Response;
  try {
    response = await fetcher("/files/skin/", { cache: "no-store" });
  } catch {
    return {
      kind: "unavailable",
      message: `Could not reach vosu to ask for the current skin; showing the classic look. ${elsewhere}`,
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
        };
      }
    } catch {
      /* Older hosts answer this path with something other than the report. */
    }
  if (!info)
    return {
      kind: "unavailable",
      message: `This vosu version does not report the current skin (update vosu to 1.2 or later); showing the classic look. ${elsewhere}`,
    };
  if (!info.client)
    return {
      kind: "unavailable",
      info,
      message: `No osu! client is connected; showing the classic look. ${elsewhere}`,
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
          ? `lazer built-in skin “${name}” is shown with the classic look.`
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
      message: `vosu reports that the files of “${name}” are unavailable; showing the classic look. ${elsewhere}`,
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
 * subfolder separators, and counts what the host actually served.
 */
export function hostSkinFiles(fetcher: typeof fetch = fetch): HostSkinFiles {
  let served = 0,
    failures = 0;
  return {
    async resolve(path) {
      const url =
        "/files/skin/" +
        path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
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
