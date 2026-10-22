/**
 * The client's current skin as reported by vosu. `GET /files/skin/` on the
 * overlay origin returns `{client, name, files, builtin}`; when `files` is
 * true, `/files/skin/<path>` serves the skin by filename for both stable and
 * lazer. Lazer's built-in skins have no files, so the preview uses its own
 * default elements and says so.
 */
export interface HostSkinInfo {
  client: "stable" | "lazer" | null;
  name: string | null;
  files: boolean;
  builtin: string | null;
}

export type CurrentSkin =
  | { kind: "files"; info: HostSkinInfo; name: string }
  | { kind: "defaults"; info?: HostSkinInfo; message: string };

const builtinNames: Record<string, string> = {
  argon: "Argon",
  "argon-pro": "Argon Pro",
  triangles: "Triangles",
  legacy: "osu! (classic)",
  retro: "osu! “retro” (2007)",
};

const elsewhere = "Load an .osk file or a skin folder instead.";

/** Interprets the host's skin report as the action "Use current skin" takes. */
export async function readCurrentSkin(
  fetcher: typeof fetch = fetch,
): Promise<CurrentSkin> {
  let response: Response;
  try {
    response = await fetcher("/files/skin/", { cache: "no-store" });
  } catch {
    return {
      kind: "defaults",
      message: `Could not reach vosu to ask for the current skin. ${elsewhere}`,
    };
  }
  let info: HostSkinInfo | undefined;
  if (response.ok)
    try {
      const body = await response.json();
      if (body && typeof body === "object" && typeof body.files === "boolean")
        info = {
          client:
            body.client === "stable" || body.client === "lazer"
              ? body.client
              : null,
          name: typeof body.name === "string" && body.name ? body.name : null,
          files: body.files,
          builtin:
            typeof body.builtin === "string" && body.builtin
              ? body.builtin
              : null,
        };
    } catch {
      /* Older hosts answer this path with something other than the report. */
    }
  if (!info)
    return {
      kind: "defaults",
      message: `This vosu version does not report the current skin (update vosu to 1.2 or later). ${elsewhere}`,
    };
  if (!info.client)
    return {
      kind: "defaults",
      info,
      message: `No osu! client is connected, so there is no current skin. ${elsewhere}`,
    };
  if (info.builtin) {
    const name = info.name ?? builtinNames[info.builtin] ?? info.builtin;
    return {
      kind: "defaults",
      info,
      message: `lazer built-in skin “${name}”: using default elements. Built-in skins have no files to load.`,
    };
  }
  const name = info.name ?? "Current skin";
  if (!info.files)
    return {
      kind: "defaults",
      info,
      message: `vosu reports that the files of “${name}” are unavailable, so default elements are shown. ${elsewhere}`,
    };
  return { kind: "files", info, name };
}

/**
 * Resolves skin files by filename through `/files/skin/<path>`, keeping
 * subfolder separators, and counts what the host actually served.
 */
export function hostSkinFiles(fetcher: typeof fetch = fetch): {
  resolve(path: string): Promise<Blob | null>;
  readonly served: number;
  readonly failures: number;
} {
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
