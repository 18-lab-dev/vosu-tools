// The mania scroll speed of Skin studio's previews: the Preview tab's Scroll
// field, else the osu! client's own setting (vosu's /settings/mania, followed
// live), else lazer's default, chosen by @vosu-tools/client-skin like Map
// preview and Practice. The demo maps play at rate 1, so the speed is the
// setting itself.
import {
  maniaScroll,
  readManiaSettings,
  type ClientManiaSettings,
  type ManiaScroll,
} from "@vosu-tools/client-skin/scroll";

/** A preview that draws mania at a scroll speed and direction. */
export interface ScrollTarget {
  setScroll(speed: number, up: boolean): void;
}

export class ClientScroll {
  #client: ClientManiaSettings | null = null;
  #override: number | null = null;
  readonly #targets = new Set<ScrollTarget>();
  readonly #onChange: (scroll: ManiaScroll) => void;

  /** `onChange` runs with the scroll in use whenever it may have changed. */
  constructor(onChange: (scroll: ManiaScroll) => void) {
    this.#onChange = onChange;
  }

  /** The client's settings as read from vosu, or null without a client. */
  get settings(): ClientManiaSettings | null {
    return this.#client;
  }

  get current(): ManiaScroll {
    return maniaScroll({ override: this.#override, client: this.#client, rate: 1 });
  }

  /** Draws `target` at the current scroll now and after every change. */
  add(target: ScrollTarget): void {
    this.#targets.add(target);
    target.setScroll(this.current.speed, this.#client?.scrollUp ?? false);
  }

  /**
   * The game subscription's `/client` and `/settings/mania` values: without a
   * client its settings do not apply.
   */
  setClient(client: unknown, mania: unknown): void {
    this.#client =
      client === "stable" || client === "lazer"
        ? readManiaSettings(mania)
        : null;
    this.#apply();
  }

  /** The Scroll field: a speed, or null (blank) to follow the client. */
  setOverride(value: number | null): void {
    this.#override = value !== null && Number.isFinite(value) && value > 0 ? value : null;
    this.#apply();
  }

  #apply(): void {
    const scroll = this.current,
      up = this.#client?.scrollUp ?? false;
    for (const target of this.#targets) target.setScroll(scroll.speed, up);
    this.#onChange(scroll);
  }
}
