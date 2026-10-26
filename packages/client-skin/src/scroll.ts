/**
 * The osu! client's mania scroll speed for tool previews.
 *
 * vosu reports the client's mania settings at `/settings/mania` of the v2
 * document (`/websocket/v2/subscribe`). Both clients use the 1-40 scale with
 * the same on-screen speed: lazer's notes travel the distance from the stage
 * top to the default hit position (402 of 480 legacy units) in
 * `11485 / speed` ms, and its time range is scaled with the skin's
 * `HitPosition` so that the speed stays the same whatever the hit position,
 * which is how stable scrolls (ppy/osu#26131 made lazer match stable at the
 * same setting; `DrawableManiaRuleset.updateTimeRange`). render-core's
 * `scrollSpeed` has exactly that meaning, so either client's value is passed
 * as it is.
 *
 * The scroll time is real time in both clients: lazer multiplies its time
 * range (in map time) by the track's tempo × frequency, and stable's fixed
 * speed ignores the rate too, so rate mods and custom rates do not change how
 * fast notes move on screen. A preview whose clock runs at `rate` map
 * milliseconds per real millisecond therefore draws `speed / rate`. A map
 * generated at 1.1x plays at rate 1 in the client and in a preview of it.
 */
export const MANIA_SETTINGS_POINTER = "/settings/mania";

/** lazer's default (`ManiaRulesetConfigManager`, osu! 2026.1005.0). */
export const LAZER_DEFAULT_SCROLL_SPEED = 8;
export const MIN_SCROLL_SPEED = 1;
export const MAX_SCROLL_SPEED = 40;

/** What vosu reports about the client's mania settings. */
export interface ClientManiaSettings {
  /** The speed the client scrolls at (1-40), or null when vosu has no value. */
  scrollSpeed: number | null;
  /** Upward scrolling (lazer's ManiaScrollingDirection.Up). */
  scrollUp: boolean;
  /**
   * stable's "BPM scale" scroll speed mode instead of the fixed speed. Off
   * when vosu leaves it out: vosu reports stable's own ManiaSpeedBPMScale
   * (src/memory/stable/settings.rs), false for lazer, which has no such
   * mode (src/state/bundle/models.rs), and false for a missing value
   * (src/api/v2/wire.rs, setting_bool).
   */
  bpmScale: boolean;
}

const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const record = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/**
 * Reads vosu's `/settings/mania` value: lazer's double-precision
 * `scrollSpeedValue`, else stable's per-map speed when per-map speeds are on,
 * else the integer `scrollSpeed` (with stable's mania speed reading on, vosu
 * already reports the current map's speed there). A missing or zero speed is
 * null.
 */
export function readManiaSettings(value: unknown): ClientManiaSettings {
  const mania = record(value),
    legacy = finite(mania.scrollSpeed),
    perBeatmap = finite(mania.perBeatmapScrollSpeed),
    speed =
      finite(mania.scrollSpeedValue) ??
      (mania.usePerBeatmapSpeedScale === true && perBeatmap
        ? perBeatmap
        : legacy);
  return {
    scrollSpeed: speed !== null && speed > 0 ? speed : null,
    // vosu's names: 0 = up, 1 = down.
    scrollUp: finite(record(mania.scrollDirection).number) === 0,
    bpmScale: mania.speedBPMScale === true,
  };
}

export type ScrollSource = "override" | "setting" | "client" | "default";

export interface ManiaScroll {
  /** The scroll speed setting shown (1-40). */
  setting: number;
  /** Where it came from: the page's field, the tool's dashboard setting, the client, or lazer's default. */
  source: ScrollSource;
  /** render-core's `scrollSpeed` for a preview clock running at `rate`. */
  speed: number;
  /** One short line for the control's hint. */
  note: string;
}

const clamp = (v: number) =>
  Math.min(MAX_SCROLL_SPEED, Math.max(MIN_SCROLL_SPEED, v));
const valid = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const shown = (v: number) => String(Math.round(v * 10) / 10);

/**
 * The scroll speed a preview draws with: an override typed in the page, else
 * the tool's own setting, else the client's speed, else lazer's default.
 * `client` is null without a connected client. `rate` is how fast the
 * preview's clock runs (the client's track rate when following it; 1 for a
 * map with its rate already applied, as Practice generates).
 */
export function maniaScroll({
  override,
  setting,
  client,
  rate = 1,
}: {
  override?: number | null;
  setting?: number | null;
  client: ClientManiaSettings | null;
  rate?: number;
}): ManiaScroll {
  const r = valid(rate) ? rate : 1;
  const pick = (value: number, source: ScrollSource, note: string) => {
    const s = clamp(value);
    return { setting: s, source, speed: s / r, note };
  };
  if (valid(override)) return pick(override, "override", "Set here; clear it to follow osu!.");
  if (valid(setting))
    return pick(setting, "setting", "From this tool's settings on the vosu dashboard.");
  if (client && valid(client.scrollSpeed))
    return pick(
      client.scrollSpeed,
      "client",
      client.bpmScale
        ? `osu! scales your speed (${shown(client.scrollSpeed)}) with BPM; the preview uses it unscaled.`
        : `Your osu! scroll speed (${shown(client.scrollSpeed)}).`,
    );
  return pick(
    LAZER_DEFAULT_SCROLL_SPEED,
    "default",
    client
      ? `osu! does not report its scroll speed; lazer's default (${LAZER_DEFAULT_SCROLL_SPEED}) is used.`
      : `No osu! client is connected; lazer's default (${LAZER_DEFAULT_SCROLL_SPEED}) is used.`,
  );
}
