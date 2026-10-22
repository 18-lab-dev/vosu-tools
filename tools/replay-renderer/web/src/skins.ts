import type { Fetcher } from "./studio";

/** Skin value prefix for `.osk` archives imported into this tool's data dir. */
export const IMPORTED = "imported/";

/** How the service can read the client's current skin (`/v1/context` `current_skin`). */
interface CurrentSkin {
  /** `folder`: stable skin folder; `vosu`: files served by vosu (lazer);
   *  `builtin`: a lazer built-in skin without files; `none`: nothing reported. */
  source: "folder" | "vosu" | "builtin" | "none";
  name: string | null;
  builtin: string | null;
}
export interface SkinContext {
  skins: string[];
  imported_skins: string[];
  current_skin: CurrentSkin;
}
interface View {
  current: HTMLElement;
  input: HTMLInputElement;
  status: HTMLElement;
  list: HTMLElement;
}

/** Current, installed and imported skins, plus `.osk` import through ≤1 MiB parts. */
export class SkinLibrary {
  private installed: string[] = [];
  private imported: string[] = [];
  private current: CurrentSkin = { source: "none", name: null, builtin: null };
  constructor(
    private view: View,
    private fetcher: Fetcher,
    private changed: () => void,
    private report: (error: unknown) => void,
  ) {
    view.input.onchange = () => {
      const file = view.input.files?.[0];
      view.input.value = "";
      if (file) void this.importArchive(file);
    };
  }
  update(context: SkinContext) {
    this.installed = context.skins;
    this.imported = context.imported_skins;
    this.current = context.current_skin;
    this.render();
    this.changed();
  }
  describeReadOnly() {
    this.view.current.textContent =
      "Open the studio from the vosu dashboard to use your skins.";
  }
  /** Whether a preset's skin still exists; empty means the current skin. */
  available(value: string | null | undefined) {
    if (!value) return true;
    return value.startsWith(IMPORTED)
      ? this.imported.includes(value.slice(IMPORTED.length))
      : this.installed.includes(value);
  }
  /** Explains a skin choice that renders with the studio's default skin. */
  note(value: string) {
    if (value) {
      return this.available(value)
        ? ""
        : `${value} is no longer available; pick another skin.`;
    }
    if (this.current.source === "builtin")
      return `lazer's built-in ${this.current.builtin} skin has no files, so this track uses the studio's default skin.`;
    if (this.current.source === "none")
      return "vosu reports no current skin, so this track uses the studio's default skin.";
    return "";
  }
  select(value: string) {
    const select = document.createElement("select");
    select.add(new Option(this.currentLabel(), ""));
    for (const [label, names, prefix] of [
      ["osu! Skins folder", this.installed, ""],
      ["Imported .osk", this.imported, IMPORTED],
    ] as const) {
      if (!names.length) continue;
      const group = document.createElement("optgroup");
      group.label = label;
      for (const name of names) group.append(new Option(name, prefix + name));
      select.append(group);
    }
    if (!this.available(value))
      select.add(new Option(`${value} (missing)`, value));
    select.value = value;
    return select;
  }
  private currentLabel() {
    switch (this.current.source) {
      case "folder":
      case "vosu":
        return `Current skin · ${this.current.name ?? "unnamed"}`;
      case "builtin":
        return `Current skin · ${this.current.builtin} built-in (studio default)`;
      default:
        return "Current skin · unavailable (studio default)";
    }
  }
  private render() {
    const { current } = this;
    const title = document.createElement("b"),
      detail = document.createElement("small");
    title.textContent = current.name ?? current.builtin ?? "No current skin";
    detail.textContent = {
      folder: "Current skin, read from your osu! stable Skins folder.",
      vosu: "Current lazer skin, read through vosu.",
      builtin: `lazer's built-in ${current.builtin} skin is drawn by the game and has no files. Tracks set to Current skin use the studio's default skin; import the .osk you want instead.`,
      none: "vosu reports no current skin. Tracks set to Current skin use the studio's default skin.",
    }[current.source];
    this.view.current.classList.toggle(
      "fallback",
      current.source === "builtin" || current.source === "none",
    );
    this.view.current.replaceChildren(title, detail);
    this.view.list.replaceChildren(
      ...this.imported.map((name) => {
        const item = document.createElement("li"),
          label = document.createElement("span"),
          remove = document.createElement("button");
        label.textContent = name;
        remove.type = "button";
        remove.className = "quiet";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove imported skin ${name}`);
        let armed: number | undefined;
        remove.onclick = () => {
          if (!armed) {
            remove.textContent = "Confirm remove";
            armed = window.setTimeout(() => {
              armed = undefined;
              remove.textContent = "Remove";
            }, 4000);
            return;
          }
          clearTimeout(armed);
          remove.disabled = true;
          void this.remove(name);
        };
        item.append(label, remove);
        return item;
      }),
    );
  }
  private async refresh() {
    this.update(await (await this.fetcher("v1/context")).json());
  }
  private async remove(name: string) {
    try {
      await this.fetcher(`v1/skins/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await this.refresh();
      this.view.status.textContent = `Removed ${name}.`;
    } catch (error) {
      this.report(error);
      this.render();
    }
  }
  private async importArchive(file: File) {
    const name = file.name.replace(/\.(osk|zip)$/i, "");
    const status = this.view.status;
    this.view.input.disabled = true;
    try {
      const query = new URLSearchParams({ name, size: String(file.size) });
      const started = (await (
        await this.fetcher(`v1/skins/uploads?${query}`, { method: "POST" })
      ).json()) as { upload: string; part_size: number };
      for (let offset = 0; offset < file.size; offset += started.part_size) {
        status.textContent = `Importing ${name} · ${Math.floor((offset / file.size) * 100)}%`;
        await this.fetcher(`v1/skins/uploads/${started.upload}?offset=${offset}`, {
          method: "POST",
          body: await file
            .slice(offset, offset + started.part_size)
            .arrayBuffer(),
        });
      }
      status.textContent = `Unpacking ${name}…`;
      const result = (await (
        await this.fetcher(`v1/skins/uploads/${started.upload}/finish`, {
          method: "POST",
        })
      ).json()) as { name: string; files: number };
      await this.refresh();
      status.textContent = `Imported ${result.name} (${result.files} files). Pick it in a track's Skin menu.`;
    } catch (error) {
      status.textContent = "";
      this.report(error);
    } finally {
      this.view.input.disabled = false;
    }
  }
}
