// The studio's keyboard shortcuts: which key does what where (`shortcut`,
// dispatched by main.ts), and the sheet that lists every binding, including
// the ones the screens handle themselves (grid, picker, Explorer list).
//
// Text fields and the skin.ini editor keep their own keys: Ctrl+Z, Ctrl+F,
// arrows, Delete and `?` act on the field there. Only Ctrl+Enter (export)
// and Ctrl+/ (this sheet) also work from a text field, since fields give
// them no meaning; the editor keeps both (Monaco's comment toggle).

export type View = "elements" | "explorer" | "keymodes" | "ini" | "preview";
export type Action =
  | "undo"
  | "redo"
  | "find"
  | "export"
  | "sheet"
  | "previous-count"
  | "next-count"
  | "clear-slots"
  | "deselect";

export interface Where {
  view: View;
  /** Focus is in a text field (input, textarea, select, contenteditable). */
  text: boolean;
  /** Focus is in the skin.ini editor. */
  editor: boolean;
  /** A modal dialog is open (it handles its own keys). */
  modal: boolean;
}

type Key = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented">;

/** The studio action `event` triggers where focus is, or null to leave it alone. */
export function shortcut(event: Key, where: Where): Action | null {
  if (event.defaultPrevented || where.modal || where.editor || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "enter") return "export";
    if (key === "/") return "sheet";
    if (where.text) return null;
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    // The Preview tab has nothing to filter: the browser's find stays.
    if (key === "f" && !event.shiftKey && where.view !== "preview") return "find";
    return null;
  }
  if (where.text) return null;
  if (event.key === "?") return "sheet";
  if (where.view !== "keymodes" || event.shiftKey) return null;
  if (event.key === "[") return "previous-count";
  if (event.key === "]") return "next-count";
  if (event.key === "Delete" || event.key === "Backspace") return "clear-slots";
  if (event.key === "Escape") return "deselect";
  return null;
}

/** Whether `element` takes typed text, so its own keys win. */
export function typesText(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement)
    return !["button", "checkbox", "color", "file", "radio", "range", "reset", "submit"].includes(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Every binding, by where it applies, for the shortcut sheet. */
export const SHEET: { area: string; keys: [string[], string][] }[] = [
  {
    area: "Everywhere",
    keys: [
      [["Ctrl+Z"], "Undo the last draft change"],
      [["Ctrl+Shift+Z", "Ctrl+Y"], "Redo"],
      [["Ctrl+F"], "Filter: skins, files or images (skin.ini: find)"],
      [["Ctrl+Enter"], "Run the chosen export or apply"],
      [["?", "Ctrl+/"], "This sheet"],
    ],
  },
  {
    area: "Keymodes",
    keys: [
      [["[", "]"], "Previous or next key count"],
      [["Arrows"], "Move between slots and fields"],
      [["Enter"], "On a slot: choose its image; on an image: assign it"],
      [["Delete", "Backspace"], "Clear the selected slots"],
      [["Esc"], "Clear the selection; in the picker, back to the slot"],
      [["Ctrl+click"], "Add or remove a slot or value"],
      [["Shift+click", "Shift+Arrows"], "Select or grow a range"],
      [["Ctrl+A"], "Select every slot, or a whole value row"],
      [["Ctrl+Space"], "Toggle the focused slot"],
    ],
  },
  {
    area: "Explorer list",
    keys: [
      [["Arrows", "PageUp", "PageDown", "Home", "End"], "Move"],
      [["Shift+Arrows", "Shift+click"], "Select a range"],
      [["Space", "Ctrl+click"], "Toggle a file"],
      [["Ctrl+A"], "Select every file"],
      [["Enter", "Double-click"], "Inspect: show the file's details (Use changes the draft)"],
      [["Esc"], "Clear the selection"],
    ],
  },
  {
    area: "skin.ini",
    keys: [
      [["Ctrl+S"], "Save the selected skin's skin.ini"],
      [["Ctrl+Z", "Ctrl+F", "Ctrl+/"], "The editor's undo, find and comment"],
    ],
  },
];
