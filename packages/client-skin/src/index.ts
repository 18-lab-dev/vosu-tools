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
  builtinLook,
  loadScope,
  loadSkin,
  overLook,
  type BuiltinSkinName,
  type Skin,
  type SkinScope,
} from "@vosu-tools/render-core";
import {
  hostSkinFiles,
  readCurrentSkin,
  type CurrentSkin,
  type Fetcher,
} from "./host";
import { openOsk } from "./osk";

export { hostSkinFiles, readCurrentSkin } from "./host";
export type {
  CurrentSkin,
  Fetcher,
  HostSkinEntry,
  HostSkinFiles,
  HostSkinInfo,
} from "./host";
export { openOsk } from "./osk";
export type { SkinArchive } from "./osk";
export {
  LAZER_DEFAULT_SCROLL_SPEED,
  MANIA_SETTINGS_POINTER,
  MAX_SCROLL_SPEED,
  MIN_SCROLL_SPEED,
  maniaScroll,
  readManiaSettings,
} from "./scroll";
export type { ClientManiaSettings, ManiaScroll, ScrollSource } from "./scroll";

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
   * The images to decode (rulesets and mania key counts, render-core's
   * `SkinScope`) until `useScope` says otherwise; everything when omitted.
   * Tools that follow maps pass `{ rulesets: [], maniaKeys: [] }` and call
   * `useScope(sceneScope(map))` per scene: only what the scene on screen
   * draws is then requested and decoded (a mania scene asks for a tenth of
   * a full skin's files; hold bodies can be tens of megabytes).
   */
  scope?: SkinScope;
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

const sorted = (values: readonly number[] | undefined) =>
  values && [...new Set(values)].sort((a, b) => a - b);
/** A scope with its lists sorted and deduplicated (undefined lists stay "all"). */
const normalise = (scope: SkinScope | undefined): SkinScope =>
  scope ? { rulesets: sorted(scope.rulesets), maniaKeys: sorted(scope.maniaKeys) } : {};
const sameList = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]));
const sameScope = (a: SkinScope, b: SkinScope) =>
  sameList(a.rulesets, b.rulesets) && sameList(a.maniaKeys, b.maniaKeys);

const fileCount = (count: number) =>
  `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;

export class ClientSkin {
  #state: SkinState;
  #owned: ImageBitmap[] = [];
  #sequence = 0;
  #clientKey = "";
  #game: [string | null, string | null] = [null, null];
  /** What the shown skin decodes images for (normalised). */
  #scope: SkinScope;
  /** The shown skin loaded from files, before built-in fallbacks fill it. */
  #files:
    | {
        skin: Skin;
        fallback: BuiltinSkinName;
        scope: SkinScope;
      }
    | undefined;
  #scopeSequence = 0;
  #scopePending: { scope: SkinScope; done: Promise<void> } | undefined;
  /** The client skin load in progress, and the host report it loads once known. */
  #clientPending: { key?: string; done: Promise<void> } | undefined;
  /** The latest skin load started (`#load`), until it settles. */
  #loading: { seq: number; done: Promise<void> } | undefined;
  readonly #onChange: (state: SkinState) => void;
  readonly #fetch: Fetcher;

  constructor(options: ClientSkinOptions) {
    this.#onChange = options.onChange;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#scope = normalise(options.scope);
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

  /** A built-in look; each is drawn once per page and shared (render-core). */
  #builtin(name: BuiltinSkinName): Skin {
    return builtinLook(name);
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
    /** The file skin's bitmaps; omitted for looks not loaded from files. */
    owned?: ImageBitmap[],
  ): void {
    // Only an installed client skin counts as "already shown" for reloads.
    if (choice !== "client") this.#clientKey = "";
    // A file skin may own no bitmaps yet (a scope with nothing to draw).
    if (!owned) this.#files = undefined;
    this.#emit({ skin, choice, label, source, message, tone }, owned ?? []);
  }

  /** Runs one load; a later load always wins over one still in progress. */
  #load(
    pending: string,
    load: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const seq = ++this.#sequence,
      isCurrent = () => seq === this.#sequence;
    this.#emit({ busy: true, message: pending, tone: "info" });
    const record = { seq, done: Promise.resolve() };
    this.#loading = record;
    record.done = (async () => {
      try {
        await load(isCurrent);
      } catch (error) {
        if (isCurrent())
          this.#emit({
            message: error instanceof Error ? error.message : String(error),
            tone: "error",
          });
      } finally {
        if (this.#loading === record) this.#loading = undefined;
        if (isCurrent()) this.#emit({ busy: false });
      }
    })();
    return record.done;
  }

  /** The skin load in progress, unless a later choice replaced it. */
  #inFlight(): Promise<void> | undefined {
    return this.#loading?.seq === this.#sequence ? this.#loading.done : undefined;
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
   * when vosu reports the skin already shown or already loading (at startup
   * the game's first frame asks while the first load is still running).
   */
  useClient({ force = true }: { force?: boolean } = {}): Promise<void> {
    this.#state = { ...this.#state, choice: "client" };
    if (force) return this.#loadClient();
    return (async () => {
      const current = await readCurrentSkin(this.#fetch);
      const key = JSON.stringify(current);
      const pending = this.#clientPending;
      // A load that has not read the report yet will read this one.
      if (pending && (pending.key === undefined || pending.key === key))
        return pending.done;
      if (!pending && this.#state.choice === "client" && key === this.#clientKey) {
        this.#emit({ message: "", tone: "info" });
        return;
      }
      return this.#loadClient(current);
    })();
  }

  /** Loads the client's skin (`known`: the host report already read). */
  #loadClient(known?: CurrentSkin): Promise<void> {
    const pending: { key?: string; done: Promise<void> } = {
      key: known && JSON.stringify(known),
      done: Promise.resolve(),
    };
    pending.done = this.#load(
      "Asking vosu for the current skin…",
      async (isCurrent) => {
        const current = known ?? (await readCurrentSkin(this.#fetch));
        if (!isCurrent()) return;
        const key = JSON.stringify(current);
        pending.key = key;
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
            const ini = await hostSkinFiles(
              this.#fetch,
              current.info.entries,
            ).resolve("skin.ini");
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
        // vosu's file list (when it sends one) spares requests for files
        // the skin lacks.
        const host = hostSkinFiles(this.#fetch, current.info.entries),
          asked = this.#scope,
          first = await loadSkin(host.resolve, current.name, asked),
          { skin: loaded, scope } = await this.#currentScope(first, asked);
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
        this.#files = { skin: loaded, fallback: current.fallback, scope };
        this.#install(
          overLook(loaded, current.fallback),
          "client",
          current.name,
          `${client} · current skin · ${fileCount(host.served)}`,
          "",
          "info",
          [...loaded.assets.values()],
        );
      },
    ).finally(() => {
      if (this.#clientPending === pending) this.#clientPending = undefined;
    });
    this.#clientPending = pending;
    return pending.done;
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
    const asked = this.#scope;
    const { skin: loaded, scope } = await this.#currentScope(
      await loadSkin(
        async (path) => {
          const blob = await resolve(path);
          if (blob) used++;
          return blob;
        },
        name,
        asked,
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
    this.#files = { skin: loaded, fallback: "legacy", scope };
    this.#install(
      overLook(loaded),
      "user",
      name,
      `${source} · ${fileCount(used)} used`,
      `Loaded “${name}”.`,
      "info",
      [...loaded.assets.values()],
    );
  }

  /**
   * Whether the shown skin has its images for exactly this scope. False
   * while the first skin from files is still loading, so a tool does not
   * draw the scene in the fallback look first.
   */
  hasScope(scope: SkinScope): boolean {
    const wanted = normalise(scope);
    if (!this.#files && this.#inFlight()) return false;
    return (
      sameScope(this.#scope, wanted) &&
      (!this.#files || sameScope(this.#files.scope, wanted))
    );
  }

  /** A freshly loaded skin with the scope asked for while it loaded. */
  async #currentScope(
    loaded: Skin,
    scope: SkinScope,
  ): Promise<{ skin: Skin; scope: SkinScope }> {
    const now = this.#scope;
    if (sameScope(scope, now)) return { skin: loaded, scope };
    const next = await loadScope(loaded, now);
    const kept = new Set(next.assets.values());
    for (const bitmap of loaded.assets.values())
      if (!kept.has(bitmap)) bitmap.close();
    return { skin: next, scope: now };
  }

  /**
   * Decodes the shown skin's images for exactly this scope (the scene's
   * ruleset and mania stage, render-core's `sceneScope`) and releases the
   * others. The current skin stays drawn until the new set is ready; then
   * `onChange` reports it. Later skin loads use this scope too. Resolves
   * once a skin load in progress has finished as well.
   */
  useScope(scope: SkinScope): Promise<void> {
    const wanted = normalise(scope);
    // Asking again while the same scope loads (e.g. every frame) waits for it.
    const pending = this.#scopePending;
    if (pending && sameScope(pending.scope, wanted)) return pending.done;
    const done = this.#loadScope(wanted).finally(() => {
      if (this.#scopePending?.done === done) this.#scopePending = undefined;
    });
    this.#scopePending = { scope: wanted, done };
    return done;
  }

  async #loadScope(wanted: SkinScope): Promise<void> {
    const scopeSequence = ++this.#scopeSequence;
    this.#scope = wanted;
    // A skin still loading picks up this scope itself (#currentScope).
    const inFlight = this.#inFlight();
    if (inFlight) await inFlight;
    if (scopeSequence !== this.#scopeSequence) return;
    const files = this.#files;
    if (!files || sameScope(files.scope, wanted)) return;
    const sequence = this.#sequence;
    const next = await loadScope(files.skin, wanted);
    if (
      sequence !== this.#sequence ||
      scopeSequence !== this.#scopeSequence ||
      this.#files !== files
    ) {
      // Superseded: release only what this call decoded.
      const old = new Set(files.skin.assets.values());
      for (const bitmap of next.assets.values())
        if (!old.has(bitmap)) bitmap.close();
      return;
    }
    this.#files = { ...files, skin: next, scope: wanted };
    this.#emit({ skin: overLook(next, files.fallback) }, [
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
