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
/** A skin in lazer's library (`lazer-library` `/v1/skins`, files only). */
export interface LazerSkin {
  id: string;
  name: string;
  creator: string | null;
}
export interface SkinContext {
  skins: string[];
  imported_skins: string[];
  lazer_skins?: LazerSkin[];
  current_skin: CurrentSkin;
}
/** Skin value prefixes: lazer library skins and render-core's drawn looks. */
export const LAZER = "lazer/";
export const BUILTIN = "builtin/";
const BUILTIN_LOOKS: [string, string][] = [
  ["argon", "Argon"],
  ["argon-pro", "Argon Pro"],
  ["triangles", "Triangles"],
  ["legacy", "Classic"],
];
export interface SkinGroup {
  /** Empty for the ungrouped "current skin" entry. */
  label: string;
  options: { value: string; label: string }[];
}
/** Every skin a track can use, grouped as the per-track menu shows them. */
export function skinGroups(context: SkinContext): SkinGroup[] {
  const current = context.current_skin;
  const currentLabel =
    current.source === "folder" || current.source === "vosu"
      ? `Current · ${current.name ?? "unnamed"}`
      : current.source === "builtin"
        ? `Current · ${BUILTIN_LOOKS.find(([id]) => id === current.builtin)?.[1] ?? current.builtin} (built-in)`
        : "Current · none (classic)";
  const groups: SkinGroup[] = [
    { label: "", options: [{ value: "", label: currentLabel }] },
    {
      label: "lazer",
      options: (context.lazer_skins ?? []).map((skin) => ({
        value: LAZER + skin.id,
        label: skin.creator ? `${skin.name} (${skin.creator})` : skin.name,
      })),
    },
    {
      label: "osu! Skins folder",
      options: context.skins.map((name) => ({ value: name, label: name })),
    },
    {
      label: "Imported .osk",
      options: context.imported_skins.map((name) => ({ value: IMPORTED + name, label: name })),
    },
    {
      label: "Built-in",
      options: BUILTIN_LOOKS.map(([id, label]) => ({ value: BUILTIN + id, label })),
    },
  ];
  return groups.filter((group) => group.options.length);
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
  private lazer: LazerSkin[] = [];
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
    this.lazer = context.lazer_skins ?? [];
    this.current = context.current_skin;
    this.render();
    this.changed();
  }
  describeReadOnly() {
    this.view.current.textContent = "Read-only";
  }
  /** Whether a preset's skin still exists; empty means the current skin. */
  available(value: string | null | undefined) {
    if (!value) return true;
    return skinGroups(this.context()).some((group) =>
      group.options.some((option) => option.value === value),
    );
  }
  private context(): SkinContext {
    return {
      skins: this.installed,
      imported_skins: this.imported,
      lazer_skins: this.lazer,
      current_skin: this.current,
    };
  }
  /** lazer built-in id to draw for Current skin tracks, if any. */
  get builtin() {
    return this.current.source === "builtin" ? this.current.builtin : null;
  }
  /** Short note for a skin choice that cannot render as chosen. */
  note(value: string) {
    if (value) return this.available(value) ? "" : `${value} is missing.`;
    if (this.current.source === "none") return "No current skin: classic look.";
    return "";
  }
  select(value: string) {
    const select = document.createElement("select");
    select.className = "v-select";
    for (const { label, options } of skinGroups(this.context())) {
      const parent = label ? document.createElement("optgroup") : select;
      if (parent instanceof HTMLOptGroupElement) parent.label = label;
      for (const option of options) parent.append(new Option(option.label, option.value));
      if (parent !== select) select.append(parent);
    }
    if (!this.available(value))
      select.add(new Option(`${value} (missing)`, value));
    select.value = value;
    return select;
  }
  private render() {
    const { current } = this;
    const title = document.createElement("span"),
      detail = document.createElement("span");
    title.textContent = current.name ?? current.builtin ?? "None";
    detail.className = "v-muted";
    detail.textContent = {
      folder: "stable",
      vosu: "lazer",
      builtin: "lazer built-in, drawn by the studio",
      none: "classic look",
    }[current.source];
    this.view.current.replaceChildren(title, " ", detail);
    this.view.list.replaceChildren(
      ...this.imported.map((name) => {
        const item = document.createElement("li"),
          label = document.createElement("span"),
          remove = document.createElement("button");
        label.textContent = name;
        remove.type = "button";
        remove.className = "v-btn v-btn--sm v-btn--ghost";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove imported skin ${name}`);
        let armed: number | undefined;
        remove.onclick = () => {
          if (!armed) {
            remove.textContent = "Confirm";
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
      status.textContent = `Imported ${result.name} (${result.files} files)`;
    } catch (error) {
      status.textContent = "";
      this.report(error);
    } finally {
      this.view.input.disabled = false;
    }
  }
}
