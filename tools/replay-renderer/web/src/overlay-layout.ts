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
  /** `root` is a `<details>` panel; its summary carries the heading. */
  constructor(root: HTMLElement) {
    const summary = document.createElement("summary"),
      heading = document.createElement("h2");
    summary.className = "panel-head";
    heading.textContent = "Overlay layers";
    summary.append(heading);
    const help = document.createElement("p");
    help.className = "note";
    help.textContent =
      "MP4 queue only. Each layer is an installed overlay folder (with index.html) driven by the first track through a private synthetic vosu server, never your live game. Position, page size, scale and opacity are per layer.";
    this.list.className = "layers";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add overlay layer";
    add.onclick = () => this.add();
    root.append(summary, help, this.list, add);
  }
  private add() {
    const node = document.createElement("div");
    node.className = "layer";
    const inputs: Record<string, HTMLInputElement> = {};
    for (const [key, title, value] of [
      ["folder", "Overlay folder (absolute path)", ""],
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
      label.className = key === "folder" ? "field folder" : "field";
      caption.textContent = title;
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
    remove.className = "quiet";
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
