/**
 * The osu! client's current skin for tool previews, shared by every tool that
 * draws gameplay with `@vosu-tools/render-core`.
 *
 * `ClientSkin` asks vosu which skin the client uses (`GET /files/skin/`),
 * loads stable or lazer skin files by filename, draws lazer's built-in skins
 * (and lazer skins based on them) with render-core's reimplementations, and
 * falls back to the classic look with a one-line reason when the skin cannot
 * be shown. It can also load an `.osk` file or a skin folder, or switch to a
 * built-in look. Every change is reported through `onChange`; the tool hands
 * `state.skin` to its renderer there.
 */
import { parseSkinIni } from "@vosu-tools/osu-parse";
import {
  builtinSkin,
  loadManiaKeys,
  loadSkin,
  withFallback,
  type BuiltinSkinName,
  type Skin,
} from "@vosu-tools/render-core";
import { hostSkinFiles, readCurrentSkin, type Fetcher } from "./host";
import { openOsk } from "./osk";

export { hostSkinFiles, readCurrentSkin } from "./host";
export type { CurrentSkin, Fetcher, HostSkinFiles, HostSkinInfo } from "./host";
export { openOsk } from "./osk";
export type { SkinArchive } from "./osk";

/** What is shown: the client's skin, a user-chosen file/folder, or a built-in look. */
export type SkinChoice = "client" | "user" | BuiltinSkinName;
export type SkinTone = "info" | "notice" | "error";

export interface SkinState {
  /** The skin to draw. Missing elements are already filled from a built-in look. */
  skin: Skin;
  choice: SkinChoice;
  /** Skin name for display, e.g. "Ralsei" or "Classic". */
  label: string;
  /** Where it came from, e.g. "lazer · current skin · 131 files". */
  source: string;
  /** One short line, empty when there is nothing to say. */
  message: string;
  tone: SkinTone;
  /** A load is in progress (the previous skin stays drawn meanwhile). */
  busy: boolean;
}

export interface ClientSkinOptions {
  /** Called synchronously after every change, before replaced bitmaps are released. */
  onChange(state: SkinState): void;
  /** Fetch on the overlay origin; defaults to the global `fetch`. */
  fetch?: Fetcher;
  /**
   * Mania key counts to decode skin images for until `useManiaKeys` says
   * otherwise; every key count when omitted. Tools that follow maps pass
   * `[]` and call `useManiaKeys` per scene: mania images (hold bodies can be
   * tens of megabytes) are then only decoded for the stage on screen.
   */
  maniaKeys?: readonly number[];
}

/**
 * `/websocket/v2/subscribe` pointers whose change means the client's skin may
 * have changed; pass their values to `ClientSkin.gameChanged`.
 */
export const SKIN_POINTERS = ["/client", "/folders/skin"] as const;

export const builtinLabels: Record<BuiltinSkinName, string> = {
  argon: "Argon",
  "argon-pro": "Argon Pro",
  triangles: "Triangles",
  legacy: "Classic",
};

const sameKeys = (
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]));
const keySet = (keys: readonly number[]) =>
  [...new Set(keys)].sort((a, b) => a - b);

const fileCount = (count: number) =>
  `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;

export class ClientSkin {
  #state: SkinState;
  #owned: ImageBitmap[] = [];
  #builtins = new Map<BuiltinSkinName, Skin>();
  #sequence = 0;
  #clientKey = "";
  #game: [string | null, string | null] = [null, null];
  /** Key counts mania images are decoded for; undefined: all of them. */
  #keys: readonly number[] | undefined;
  /** The shown skin loaded from files, before built-in fallbacks fill it. */
  #files:
    | {
        skin: Skin;
        fallback: BuiltinSkinName;
        keys: readonly number[] | undefined;
      }
    | undefined;
  #maniaSequence = 0;
  #maniaPending: { keys: readonly number[]; done: Promise<void> } | undefined;
  readonly #onChange: (state: SkinState) => void;
  readonly #fetch: Fetcher;

  constructor(options: ClientSkinOptions) {
    this.#onChange = options.onChange;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#keys = options.maniaKeys && keySet(options.maniaKeys);
    this.#state = {
      skin: this.#builtin("legacy"),
      choice: "client",
      label: builtinLabels.legacy,
      source: "fallback look",
      message: "",
      tone: "info",
      busy: false,
    };
  }

  get state(): SkinState {
    return this.#state;
  }

  /** A built-in look; each is drawn once and reused. */
  #builtin(name: BuiltinSkinName): Skin {
    let skin = this.#builtins.get(name);
    if (!skin) this.#builtins.set(name, (skin = builtinSkin(name)));
    return skin;
  }

  #emit(next: Partial<SkinState>, owned?: ImageBitmap[]): void {
    this.#state = { ...this.#state, ...next };
    this.#onChange(this.#state);
    if (owned) {
      // Bitmaps the new skin still uses (other key counts) stay open.
      const kept = new Set(owned);
      for (const bitmap of this.#owned) if (!kept.has(bitmap)) bitmap.close();
      this.#owned = owned;
    }
  }

  #install(
    skin: Skin,
    choice: SkinChoice,
    label: string,
    source: string,
    message = "",
    tone: SkinTone = "info",
    owned: ImageBitmap[] = [],
  ): void {
    // Only an installed client skin counts as "already shown" for reloads.
    if (choice !== "client") this.#clientKey = "";
    if (!owned.length) this.#files = undefined;
    this.#emit({ skin, choice, label, source, message, tone }, owned);
  }

  /** Runs one load; a later load always wins over one still in progress. */
  async #load(
    pending: string,
    load: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const seq = ++this.#sequence,
      isCurrent = () => seq === this.#sequence;
    this.#emit({ busy: true, message: pending, tone: "info" });
    try {
      await load(isCurrent);
    } catch (error) {
      if (isCurrent())
        this.#emit({
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
    } finally {
      if (isCurrent()) this.#emit({ busy: false });
    }
  }

  /** Shows a short line in the skin status without changing the skin. */
  say(message: string, tone: SkinTone = "info"): void {
    this.#emit({ message, tone });
  }

  /** Draws a built-in look. */
  useBuiltin(name: BuiltinSkinName, source = "chosen in this tab"): void {
    this.#sequence++;
    this.#install(this.#builtin(name), name, builtinLabels[name], source);
    this.#emit({ busy: false });
  }

  /**
   * Shows the client's current skin. With `force: false` nothing is reloaded
   * when vosu reports the same skin as last time.
   */
  useClient({ force = true }: { force?: boolean } = {}): Promise<void> {
    this.#state = { ...this.#state, choice: "client" };
    return this.#load(
      "Asking vosu for the current skin…",
      async (isCurrent) => {
        const current = await readCurrentSkin(this.#fetch);
        if (!isCurrent()) return;
        const key = JSON.stringify(current);
        if (!force && key === this.#clientKey) {
          this.#emit({ message: "", tone: "info" });
          return;
        }
        const client = current.info?.client ?? "client";
        if (current.kind === "unavailable") {
          this.#clientKey = key;
          this.#install(
            this.#builtin("legacy"),
            "client",
            builtinLabels.legacy,
            "fallback look",
            current.message,
            "notice",
          );
          return;
        }
        if (current.kind === "builtin") {
          let skin = this.#builtin(current.look);
          if (current.coloursFromFiles) {
            // lazer skins based on Argon or Triangles only add configuration.
            const ini = await hostSkinFiles(this.#fetch).resolve("skin.ini");
            const colours = ini
              ? parseSkinIni(await ini.text()).get("Colours")
              : undefined;
            if (!isCurrent()) return;
            if (colours?.length)
              skin = {
                ...skin,
                sections: new Map(skin.sections).set("Colours", colours),
              };
          }
          this.#clientKey = key;
          this.#install(
            skin,
            "client",
            current.name,
            `${client} · ${current.info.builtin ? "built-in skin" : `${builtinLabels[current.look]}-based skin`}`,
            current.message ?? "",
            current.message ? "notice" : "info",
          );
          return;
        }
        this.#emit({ message: `Loading “${current.name}” from ${client}…` });
        const host = hostSkinFiles(this.#fetch),
          asked = this.#keys,
          first = await loadSkin(host.resolve, current.name, {
            maniaKeys: asked,
          }),
          { skin: loaded, keys } = await this.#currentKeys(first, asked);
        if (!isCurrent()) {
          for (const bitmap of loaded.assets.values()) bitmap.close();
          return;
        }
        if (!host.served) {
          this.#clientKey = key;
          this.#install(
            this.#builtin("legacy"),
            "client",
            builtinLabels.legacy,
            "fallback look",
            host.failures
              ? `vosu could not serve “${current.name}”; showing the classic look.`
              : `“${current.name}” has nothing to draw; showing the classic look.`,
            "notice",
          );
          return;
        }
        this.#clientKey = key;
        this.#files = { skin: loaded, fallback: current.fallback, keys };
        this.#install(
          withFallback(loaded, this.#builtin(current.fallback)),
          "client",
          current.name,
          `${client} · current skin · ${fileCount(host.served)}`,
          "",
          "info",
          [...loaded.assets.values()],
        );
      },
    );
  }

  /**
   * Feed the values of `SKIN_POINTERS` from the game subscription: while the
   * client's skin is shown, a change of client or skin folder reloads it.
   * Call `useClient({ force: false })` after a reconnect as well. Resolves
   * when any reload has finished.
   */
  gameChanged(client: string | null, skinFolder: string | null): Promise<void> {
    const previous = this.#game;
    this.#game = [client, skinFolder];
    return this.#state.choice === "client" &&
      (previous[0] !== client || previous[1] !== skinFolder)
      ? this.useClient({ force: false })
      : Promise.resolve();
  }

  async #userSkin(
    name: string,
    source: string,
    resolve: (path: string) => Promise<Blob | null>,
    isCurrent: () => boolean,
  ): Promise<void> {
    let used = 0;
    const asked = this.#keys;
    const { skin: loaded, keys } = await this.#currentKeys(
      await loadSkin(
        async (path) => {
          const blob = await resolve(path);
          if (blob) used++;
          return blob;
        },
        name,
        { maniaKeys: asked },
      ),
      asked,
    );
    if (!isCurrent()) {
      for (const bitmap of loaded.assets.values()) bitmap.close();
      return;
    }
    if (!used) {
      this.#emit({ message: `“${name}” has nothing to draw.`, tone: "notice" });
      return;
    }
    this.#files = { skin: loaded, fallback: "legacy", keys };
    this.#install(
      withFallback(loaded, this.#builtin("legacy")),
      "user",
      name,
      `${source} · ${fileCount(used)} used`,
      `Loaded “${name}”.`,
      "info",
      [...loaded.assets.values()],
    );
  }

  /** Whether the shown skin has its mania images for exactly these key counts. */
  hasManiaKeys(keys: readonly number[]): boolean {
    const wanted = keySet(keys);
    return (
      sameKeys(this.#keys, wanted) &&
      (!this.#files || sameKeys(this.#files.keys, wanted))
    );
  }

  /** A freshly loaded skin with the key counts asked for while it loaded. */
  async #currentKeys(
    loaded: Skin,
    keys: readonly number[] | undefined,
  ): Promise<{ skin: Skin; keys: readonly number[] | undefined }> {
    const now = this.#keys;
    if (!now || sameKeys(keys, now)) return { skin: loaded, keys };
    const next = await loadManiaKeys(loaded, now);
    const kept = new Set(next.assets.values());
    for (const bitmap of loaded.assets.values())
      if (!kept.has(bitmap)) bitmap.close();
    return { skin: next, keys: now };
  }

  /**
   * Decodes the shown skin's mania images for exactly these key counts (the
   * scene's stage; none for other rulesets) and releases the others. The
   * current skin stays drawn until the new set is ready; then `onChange`
   * reports it. Later skin loads use these key counts too.
   */
  useManiaKeys(keys: readonly number[]): Promise<void> {
    const wanted = keySet(keys);
    // Asking again while the same set loads (e.g. every frame) waits for it.
    const pending = this.#maniaPending;
    if (pending && sameKeys(pending.keys, wanted)) return pending.done;
    const done = this.#loadManiaKeys(wanted).finally(() => {
      if (this.#maniaPending?.done === done) this.#maniaPending = undefined;
    });
    this.#maniaPending = { keys: wanted, done };
    return done;
  }

  async #loadManiaKeys(wanted: readonly number[]): Promise<void> {
    const maniaSequence = ++this.#maniaSequence;
    this.#keys = wanted;
    const files = this.#files;
    if (!files || sameKeys(files.keys, wanted)) return;
    const sequence = this.#sequence;
    const next = await loadManiaKeys(files.skin, wanted);
    if (
      sequence !== this.#sequence ||
      maniaSequence !== this.#maniaSequence ||
      this.#files !== files
    ) {
      // Superseded: release only what this call decoded.
      const old = new Set(files.skin.assets.values());
      for (const bitmap of next.assets.values())
        if (!old.has(bitmap)) bitmap.close();
      return;
    }
    this.#files = { ...files, skin: next, keys: wanted };
    this.#emit({ skin: withFallback(next, this.#builtin(files.fallback)) }, [
      ...next.assets.values(),
    ]);
  }

  /** Loads an `.osk` (ZIP) skin archive chosen by the user. */
  loadOsk(file: File): Promise<void> {
    const name = file.name.replace(/\.(osk|zip)$/i, "");
    return this.#load(`Reading “${file.name}”…`, async (isCurrent) => {
      const archive = await openOsk(file);
      if (isCurrent())
        await this.#userSkin(name, ".osk file", archive.resolve, isCurrent);
    });
  }

  /** Loads a skin folder from `<input type="file" webkitdirectory>`. */
  loadFolder(files: readonly File[]): Promise<void> {
    if (!files.length) return Promise.resolve();
    const lookup = new Map<string, File>();
    for (const file of files)
      lookup.set(
        file.webkitRelativePath.split("/").slice(1).join("/").toLowerCase(),
        file,
      );
    const name = files[0].webkitRelativePath.split("/")[0];
    return this.#load(`Reading folder “${name}”…`, (isCurrent) =>
      this.#userSkin(
        name,
        "skin folder",
        async (path) =>
          lookup.get(path.replace(/\\/g, "/").toLowerCase()) ?? null,
        isCurrent,
      ),
    );
  }

  /** Releases the loaded skin's bitmaps; call after the renderer is destroyed. */
  destroy(): void {
    this.#sequence++;
    for (const bitmap of this.#owned) bitmap.close();
    this.#owned = [];
  }
}
