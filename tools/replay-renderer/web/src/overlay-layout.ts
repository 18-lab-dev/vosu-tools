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
  constructor(private root: HTMLElement) {
    const heading = document.createElement("h2");
    heading.textContent = "04 / OVERLAY LAYOUT";
    const help = document.createElement("p");
    help.className = "help";
    help.textContent =
      "Native MP4 only. Layers follow the first replay through a private synthetic vosu server, not your live game. Choose an absolute installed overlay folder (index.html); position, viewport, scale and opacity are independent for each page.";
    const add = document.createElement("button");
    add.textContent = "Add installed overlay folder";
    add.onclick = () => this.add();
    root.append(heading, help, add);
  }
  private add() {
    const node = document.createElement("article");
    node.className = "track";
    const inputs: Record<string, HTMLInputElement> = {};
    for (const [key, title, value] of [
      ["folder", "Overlay folder", ""],
      ["width", "Page width", "640"],
      ["height", "Page height", "180"],
      ["x", "X", "0"],
      ["y", "Y", "0"],
      ["scale", "Scale", "1"],
      ["opacity", "Opacity", "1"],
    ] as const) {
      const label = document.createElement("label"),
        input = document.createElement("input");
      label.textContent = title;
      input.type = key === "folder" ? "text" : "number";
      input.value = value;
      input.dataset.overlay = key;
      if (key === "folder")
        input.placeholder = "/home/you/.local/share/vosu/static/counter";
      else input.step = key === "scale" || key === "opacity" ? "0.05" : "1";
      label.append(input);
      node.append(label);
      inputs[key] = input;
    }
    const remove = document.createElement("button");
    remove.textContent = "Remove overlay";
    const layer = { node, inputs };
    remove.onclick = () => {
      this.layers.splice(this.layers.indexOf(layer), 1);
      node.remove();
    };
    node.append(remove);
    this.root.append(node);
    this.layers.push(layer);
  }
  get configured() {
    return this.layers.length > 0;
  }
  read(): OverlayLayer[] {
    return this.layers.map(({ inputs }) => {
      const folder = inputs.folder.value.trim();
      if (!folder)
        throw new Error("Every overlay needs an absolute folder path");
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
