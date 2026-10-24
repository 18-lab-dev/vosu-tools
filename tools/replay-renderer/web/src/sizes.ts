/** Output frame size picker: common sizes across aspect ratios, saved custom
 *  sizes, and a validated custom width × height entry. */

export interface Size {
  width: number;
  height: number;
}
interface Saved extends Size {
  name: string;
}
export interface SizeStore {
  saved: Saved[];
  last: string | null;
  /** Layout picked in the studio; absent means `auto`. */
  layout?: string | null;
  /** "Export for" picked in the studio; absent: the tool settings. */
  export?: { export_for: string; discord_mb: number } | null;
}
interface Group {
  ratio: string;
  label: string;
  sizes: [number, number, string][];
}

const GROUPS: Group[] = [
  {
    ratio: "16:9",
    label: "16:9 widescreen",
    sizes: [
      [3840, 2160, "4K UHD"],
      [2560, 1440, "1440p"],
      [1920, 1080, "1080p"],
      [1280, 720, "720p"],
      [854, 480, "480p"],
    ],
  },
  {
    ratio: "16:10",
    label: "16:10",
    sizes: [
      [2560, 1600, "WQXGA"],
      [1920, 1200, "WUXGA"],
      [1680, 1050, "WSXGA+"],
      [1280, 800, "WXGA"],
    ],
  },
  {
    ratio: "21:9",
    label: "21:9 ultrawide",
    sizes: [
      [3440, 1440, "UWQHD"],
      [2560, 1080, "UWFHD"],
    ],
  },
  {
    ratio: "32:9",
    label: "32:9 super ultrawide",
    sizes: [
      [5120, 1440, "DQHD"],
      [3840, 1080, "DFHD"],
    ],
  },
  {
    ratio: "4:3",
    label: "4:3",
    sizes: [
      [1600, 1200, "UXGA"],
      [1440, 1080, "1080p 4:3"],
      [1024, 768, "XGA"],
      [640, 480, "VGA"],
    ],
  },
  {
    ratio: "9:16",
    label: "9:16 vertical",
    sizes: [
      [1080, 1920, "Shorts / Reels"],
      [720, 1280, "720p vertical"],
    ],
  },
  {
    ratio: "4:5",
    label: "4:5 portrait",
    sizes: [
      [1080, 1350, "Feed portrait"],
      [864, 1080, "1080p 4:5"],
    ],
  },
  {
    ratio: "1:1",
    label: "1:1 square",
    sizes: [
      [1080, 1080, "Square"],
      [720, 720, "Square 720"],
    ],
  },
];

/** Same limits as the service: even sides of 64–7680 px, ≤ 7680×4320 pixels. */
export function sizeProblem(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height))
    return "Width and height must be whole numbers.";
  if (width < 64 || height < 64 || width > 7680 || height > 7680)
    return "Each side must be 64–7680 px.";
  if (width * height > 7680 * 4320)
    return "At most 7680 × 4320 pixels per frame.";
  if (width % 2 || height % 2) return "Video sides must be even numbers.";
  return "";
}
export function parseSize(text: string | null | undefined): Size | null {
  const match = /^(\d+)\s*[x×X]\s*(\d+)$/.exec(text?.trim() ?? "");
  if (!match) return null;
  const size = { width: Number(match[1]), height: Number(match[2]) };
  return sizeProblem(size.width, size.height) ? null : size;
}
function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
/** Named ratio when it is a common one, else the reduced fraction. */
export function ratioOf({ width, height }: Size) {
  const known = GROUPS.find(({ ratio }) => {
    const [w, h] = ratio.split(":").map(Number);
    // "21:9" panels are really 2.37–2.39:1; 3% tolerance keeps names apart.
    return Math.abs((width / height) / (w / h) - 1) < 0.03;
  });
  if (known) return known.ratio;
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

interface Option {
  size: Size;
  label: string;
  saved?: string;
}

export class SizePicker {
  private value: Size = { width: 1920, height: 1080 };
  private store: SizeStore = { saved: [], last: null };
  private button = document.createElement("button");
  private panel = document.createElement("div");
  private list = document.createElement("div");
  private options: { node: HTMLElement; option: Option }[] = [];
  private active = -1;
  private width = document.createElement("input");
  private height = document.createElement("input");
  private name = document.createElement("input");
  private problem = document.createElement("p");
  canWrite = false;
  constructor(
    root: HTMLElement,
    labelId: string,
    private onChange: (size: Size) => void,
    private persist: {
      save(saved: Saved): Promise<SizeStore>;
      remove(name: string): Promise<SizeStore>;
    },
    private report: (error: unknown) => void,
  ) {
    root.className = "sizes";
    this.button.type = "button";
    this.button.className = "v-select size-trigger";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-labelledby", `${labelId} size-value`);
    this.panel.className = "size-panel";
    this.panel.hidden = true;
    this.list.className = "size-list";
    this.list.id = "size-list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-labelledby", labelId);
    this.list.tabIndex = -1;
    this.button.setAttribute("aria-controls", this.list.id);
    const custom = document.createElement("div");
    custom.className = "size-custom";
    const heading = document.createElement("p");
    heading.className = "size-group v-label";
    heading.textContent = "Custom";
    const row = document.createElement("div");
    row.className = "size-inputs";
    for (const [input, label] of [
      [this.width, "Custom width"],
      [this.height, "Custom height"],
    ] as const) {
      input.type = "number";
      input.min = "64";
      input.max = "7680";
      input.step = "2";
      input.className = "v-input";
      input.setAttribute("aria-label", label);
      input.oninput = () => this.validate();
    }
    const times = document.createElement("span");
    times.textContent = "×";
    times.setAttribute("aria-hidden", "true");
    const use = document.createElement("button");
    use.type = "button";
    use.className = "v-btn v-btn--sm";
    use.textContent = "Use";
    use.onclick = () => {
      const size = this.customSize();
      if (size) this.pick(size);
    };
    row.append(this.width, times, this.height, use);
    const saveRow = document.createElement("div");
    saveRow.className = "size-inputs";
    this.name.className = "v-input";
    this.name.placeholder = "Name";
    this.name.maxLength = 48;
    this.name.setAttribute("aria-label", "Name for this size");
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    save.className = "v-btn v-btn--sm size-save";
    save.onclick = () => void this.saveCustom();
    saveRow.append(this.name, save);
    this.problem.className = "size-problem";
    this.problem.setAttribute("role", "status");
    custom.append(heading, row, saveRow, this.problem);
    this.panel.append(this.list, custom);
    root.append(this.button, this.panel);
    this.button.onclick = () => (this.panel.hidden ? this.open() : this.close());
    this.button.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.open();
      }
    };
    this.list.onkeydown = (event) => this.key(event);
    document.addEventListener("pointerdown", (event) => {
      if (!this.panel.hidden && !root.contains(event.target as Node)) this.close();
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.hidden) {
        event.stopPropagation();
        this.close();
        this.button.focus();
      }
    });
    this.render();
  }
  get size() {
    return this.value;
  }
  set(size: Size, store?: SizeStore) {
    if (store) this.store = store;
    this.value = size;
    this.render();
  }
  private customSize(): Size | null {
    const size = { width: Number(this.width.value), height: Number(this.height.value) };
    const problem = sizeProblem(size.width, size.height);
    this.problem.textContent = problem;
    this.width.setAttribute("aria-invalid", String(!!problem));
    this.height.setAttribute("aria-invalid", String(!!problem));
    return problem ? null : size;
  }
  private validate() {
    if (this.width.value && this.height.value) this.customSize();
    else this.problem.textContent = "";
  }
  private async saveCustom() {
    const size = this.customSize();
    if (!size) return;
    const name = this.name.value.trim() || `${size.width} × ${size.height}`;
    try {
      this.store = await this.persist.save({ name, ...size });
      this.name.value = "";
      this.pick(size);
    } catch (error) {
      this.report(error);
    }
  }
  private allOptions(): { group: string; options: Option[] }[] {
    const groups: { group: string; options: Option[] }[] = [];
    if (this.store.saved.length)
      groups.push({
        group: "Saved",
        options: this.store.saved.map((s) => ({
          size: { width: s.width, height: s.height },
          label: s.name,
          saved: s.name,
        })),
      });
    for (const group of GROUPS)
      groups.push({
        group: group.label,
        options: group.sizes.map(([width, height, label]) => ({
          size: { width, height },
          label,
        })),
      });
    const current = this.value;
    if (!groups.some((g) => g.options.some((o) => same(o.size, current))))
      groups.unshift({
        group: "Current",
        options: [{ size: current, label: "Custom" }],
      });
    return groups;
  }
  private render() {
    const { width, height } = this.value;
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(".size-save"))
      button.disabled = !this.canWrite;
    const value = document.createElement("span");
    value.id = "size-value";
    value.className = "size-value";
    value.textContent = `${width} × ${height}`;
    const ratio = document.createElement("span");
    ratio.className = "size-ratio";
    ratio.textContent = ratioOf(this.value);
    this.button.replaceChildren(glyph(this.value), value, ratio);
    this.list.replaceChildren();
    this.options = [];
    for (const { group, options } of this.allOptions()) {
      const heading = document.createElement("p");
      heading.className = "size-group v-label";
      heading.setAttribute("role", "presentation");
      heading.textContent = group;
      this.list.append(heading);
      for (const option of options) {
        const node = document.createElement("div");
        node.className = "size-option";
        node.setAttribute("role", "option");
        node.id = `size-${this.options.length}`;
        const selected = same(option.size, this.value);
        node.setAttribute("aria-selected", String(selected));
        const dims = document.createElement("span");
        dims.className = "size-dims";
        dims.textContent = `${option.size.width} × ${option.size.height}`;
        const label = document.createElement("span");
        label.className = "size-name";
        label.textContent = option.label;
        node.append(glyph(option.size), dims, label);
        if (option.saved) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "v-btn v-btn--sm v-btn--ghost v-btn--icon size-remove";
          remove.textContent = "×";
          remove.tabIndex = -1;
          remove.disabled = !this.canWrite;
          remove.setAttribute("aria-label", `Delete saved size ${option.saved}`);
          remove.onclick = async (event) => {
            event.stopPropagation();
            try {
              this.store = await this.persist.remove(option.saved!);
              this.render();
            } catch (error) {
              this.report(error);
            }
          };
          node.append(remove);
        }
        const index = this.options.length;
        node.onclick = () => this.pick(option.size);
        node.onpointermove = () => this.highlight(index, false);
        this.options.push({ node, option });
        this.list.append(node);
      }
    }
  }
  private open() {
    this.render();
    this.panel.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.width.value = String(this.value.width);
    this.height.value = String(this.value.height);
    this.problem.textContent = "";
    this.highlight(
      Math.max(0, this.options.findIndex((o) => same(o.option.size, this.value))),
      true,
    );
    this.list.focus();
  }
  private close() {
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }
  private highlight(index: number, scroll: boolean) {
    this.options[this.active]?.node.classList.remove("active");
    this.active = Math.max(0, Math.min(this.options.length - 1, index));
    const node = this.options[this.active]?.node;
    if (!node) return;
    node.classList.add("active");
    this.list.setAttribute("aria-activedescendant", node.id);
    if (!scroll) return;
    // A group's first option brings its heading along.
    const heading = node.previousElementSibling;
    (heading?.classList.contains("size-group") ? heading : node).scrollIntoView({
      block: "nearest",
    });
    node.scrollIntoView({ block: "nearest" });
  }
  private key(event: KeyboardEvent) {
    const moves: Record<string, number> = {
      ArrowDown: this.active + 1,
      ArrowUp: this.active - 1,
      Home: 0,
      End: this.options.length - 1,
      PageDown: this.active + 6,
      PageUp: this.active - 6,
    };
    if (event.key in moves) {
      event.preventDefault();
      this.highlight(moves[event.key], true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = this.options[this.active]?.option;
      if (option) this.pick(option.size);
    } else if (event.key === "Tab") this.close();
  }
  private pick(size: Size) {
    this.value = size;
    this.close();
    this.render();
    this.button.focus();
    this.onChange(size);
  }
}

function same(a: Size, b: Size) {
  return a.width === b.width && a.height === b.height;
}
/** Small rectangle drawn at the size's aspect ratio. */
function glyph({ width, height }: Size) {
  const box = document.createElement("span");
  box.className = "size-glyph";
  box.setAttribute("aria-hidden", "true");
  const scale = 18 / Math.max(width, height);
  box.style.width = `${Math.max(4, Math.round(width * scale))}px`;
  box.style.height = `${Math.max(4, Math.round(height * scale))}px`;
  return box;
}
