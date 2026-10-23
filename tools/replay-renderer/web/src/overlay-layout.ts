export interface OverlayLayer {
  folder: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  settings: Record<string, unknown>;
}
/** Numeric layout controls never embed executable overlay pages into the tool UI. */
export class OverlayEditor {
  private layers: {
    node: HTMLElement;
    inputs: Record<string, HTMLInputElement>;
  }[] = [];
  private list = document.createElement("div");
  /** Renders into `root`: a section label with an Add action, then the layers. */
  constructor(root: HTMLElement) {
    const head = document.createElement("div"),
      label = document.createElement("span"),
      help = document.createElement("span"),
      spacer = document.createElement("span");
    head.className = "subhead";
    label.className = "v-label";
    label.textContent = "Overlays";
    help.className = "v-help";
    help.tabIndex = 0;
    help.setAttribute("role", "img");
    help.dataset.tipPos = "left";
    const tip = "MP4 only. Installed overlay folders, driven by the first track.";
    help.setAttribute("aria-label", tip);
    help.dataset.tip = tip;
    spacer.className = "v-bar__spacer";
    this.list.className = "layers";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "v-btn v-btn--sm";
    add.textContent = "Add";
    add.setAttribute("aria-label", "Add overlay layer");
    add.onclick = () => this.add();
    head.append(label, help, spacer, add);
    root.append(head, this.list);
  }
  private add() {
    const node = document.createElement("div");
    node.className = "layer";
    const inputs: Record<string, HTMLInputElement> = {};
    for (const [key, title, value] of [
      ["folder", "Folder", ""],
      ["width", "Page width", "640"],
      ["height", "Page height", "180"],
      ["x", "X", "0"],
      ["y", "Y", "0"],
      ["scale", "Scale", "1"],
      ["opacity", "Opacity", "1"],
    ] as const) {
      const label = document.createElement("label"),
        caption = document.createElement("span"),
        input = document.createElement("input");
      label.className = key === "folder" ? "v-field folder" : "v-field";
      caption.textContent = title;
      input.className = "v-input";
      input.type = key === "folder" ? "text" : "number";
      input.value = value;
      input.dataset.overlay = key;
      if (key === "folder")
        input.placeholder = "/home/you/.local/share/vosu/static/counter";
      else input.step = key === "scale" || key === "opacity" ? "0.05" : "1";
      label.append(caption, input);
      node.append(label);
      inputs[key] = input;
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "v-btn v-btn--sm v-btn--ghost";
    remove.textContent = "Remove";
    const layer = { node, inputs };
    remove.onclick = () => {
      this.layers.splice(this.layers.indexOf(layer), 1);
      node.remove();
    };
    node.append(remove);
    this.list.append(node);
    this.layers.push(layer);
    inputs.folder.focus();
  }
  get configured() {
    return this.layers.length > 0;
  }
  read(): OverlayLayer[] {
    return this.layers.map(({ inputs }) => {
      const folder = inputs.folder.value.trim();
      if (!folder)
        throw new Error("Every overlay layer needs an absolute folder path");
      const values = Object.fromEntries(
        Object.entries(inputs)
          .filter(([key]) => key !== "folder")
          .map(([key, input]) => [key, Number(input.value)]),
      );
      if (!Object.values(values).every(Number.isFinite))
        throw new Error("Overlay transforms must be finite numbers");
      return {
        folder,
        width: values.width,
        height: values.height,
        x: values.x,
        y: values.y,
        scale: values.scale,
        opacity: values.opacity,
        settings: {},
      };
    });
  }
}
