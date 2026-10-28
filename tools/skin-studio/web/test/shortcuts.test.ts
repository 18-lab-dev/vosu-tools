import { expect, test } from "bun:test";
import { SHEET, shortcut, type View, type Where } from "../src/shortcuts";

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; prevented?: boolean } = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  defaultPrevented: !!mods.prevented,
});
const at = (view: View, where: Partial<Where> = {}): Where => ({ view, text: false, editor: false, modal: false, ...where });

test("undo and redo work on every tab, Cmd as well as Ctrl", () => {
  for (const view of ["elements", "explorer", "keymodes", "ini", "preview"] as const) {
    expect(shortcut(key("z", { ctrl: true }), at(view))).toBe("undo");
    expect(shortcut(key("Z", { ctrl: true, shift: true }), at(view))).toBe("redo");
    expect(shortcut(key("y", { ctrl: true }), at(view))).toBe("redo");
    expect(shortcut(key("z", { meta: true }), at(view))).toBe("undo");
  }
});

test("text fields keep undo, find, arrows, Delete and ?", () => {
  const text = at("keymodes", { text: true });
  for (const event of [key("z", { ctrl: true }), key("z", { ctrl: true, shift: true }), key("y", { ctrl: true }), key("f", { ctrl: true }), key("ArrowUp"), key("Delete"), key("Backspace"), key("Escape"), key("?"), key("["), key("]")])
    expect(shortcut(event, text)).toBeNull();
  // Fields give these no meaning: export and the sheet still work.
  expect(shortcut(key("Enter", { ctrl: true }), text)).toBe("export");
  expect(shortcut(key("/", { ctrl: true }), text)).toBe("sheet");
});

test("the skin.ini editor keeps every key", () => {
  const editor = at("ini", { editor: true, text: true });
  for (const event of [key("z", { ctrl: true }), key("f", { ctrl: true }), key("/", { ctrl: true }), key("Enter", { ctrl: true }), key("?")])
    expect(shortcut(event, editor)).toBeNull();
});

test("Ctrl+F filters where there is a list, else the browser finds", () => {
  for (const view of ["elements", "explorer", "keymodes", "ini"] as const) expect(shortcut(key("f", { ctrl: true }), at(view))).toBe("find");
  expect(shortcut(key("f", { ctrl: true }), at("preview"))).toBeNull();
  expect(shortcut(key("F", { ctrl: true, shift: true }), at("keymodes"))).toBeNull();
});

test("Keymodes keys apply on that screen only", () => {
  expect(shortcut(key("["), at("keymodes"))).toBe("previous-count");
  expect(shortcut(key("]"), at("keymodes"))).toBe("next-count");
  expect(shortcut(key("Delete"), at("keymodes"))).toBe("clear-slots");
  expect(shortcut(key("Backspace"), at("keymodes"))).toBe("clear-slots");
  expect(shortcut(key("Escape"), at("keymodes"))).toBe("deselect");
  for (const view of ["elements", "explorer", "ini", "preview"] as const)
    for (const k of ["[", "]", "Delete", "Escape"]) expect(shortcut(key(k), at(view))).toBeNull();
  // Shift+arrows and other grid keys stay the grid's own.
  expect(shortcut(key("Delete", { shift: true }), at("keymodes"))).toBeNull();
  expect(shortcut(key("a", { ctrl: true }), at("keymodes"))).toBeNull();
  expect(shortcut(key(" ", { ctrl: true }), at("keymodes"))).toBeNull();
});

test("keys a screen handled, Alt chords and open dialogs are left alone", () => {
  expect(shortcut(key("Delete", { prevented: true }), at("keymodes"))).toBeNull();
  expect(shortcut(key("z", { ctrl: true, alt: true }), at("keymodes"))).toBeNull();
  expect(shortcut(key("?"), at("keymodes", { modal: true }))).toBeNull();
  expect(shortcut(key("?"), at("explorer"))).toBe("sheet");
});

test("no tab-switching shortcuts", () => {
  for (const k of ["l", "e", "k", "i", "p"]) expect(shortcut(key(k, { ctrl: true }), at("elements"))).toBeNull();
});

test("the sheet lists each dispatched binding", () => {
  const listed = new Set(SHEET.flatMap((area) => area.keys.flatMap(([combos]) => combos)));
  for (const combo of ["Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y", "Ctrl+F", "Ctrl+Enter", "?", "Ctrl+/", "[", "]", "Delete", "Backspace", "Esc", "Ctrl+S"])
    expect(listed.has(combo)).toBe(true);
});
