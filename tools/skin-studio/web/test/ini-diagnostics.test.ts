import { expect, test } from "bun:test";
import { validate } from "@vosu-tools/skin-spec";
import { IniDiagnostics } from "../src/ini-diagnostics";
import { TextDoc } from "../src/text-doc";

function clock() {
  let now = 0, serial = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, delay: number) {
      const id = ++serial;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) { tasks.delete(id); },
    advance(duration: number) {
      const until = now + duration;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        tasks.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = until;
    },
  };
}

const ini = "[Mania]\nKeys: 4\nNoteImage0: missing\n";

test("a burst of 52 keystrokes runs one idle validation and then reuses the result", () => {
  const timer = clock(), doc = new TextDoc();
  doc.files = ["note.png"];
  let checks = 0, publications = 0;
  const diagnostics = new IniDiagnostics(() => publications++, (text, files) => { checks++; return validate(text, files); }, timer);
  for (let index = 0; index < 52; index++) {
    doc.setValue(ini + "// " + "x".repeat(index + 1));
    expect(diagnostics.schedule(doc)).toBe(false);
    timer.advance(80);
  }
  expect(checks).toBe(0);
  timer.advance(119);
  expect(checks).toBe(0);
  timer.advance(1);
  expect(checks).toBe(1);
  expect(publications).toBe(1);
  expect(doc.issues.some(issue => issue.message.startsWith("Missing image"))).toBe(true);
  for (let index = 0; index < 52; index++) expect(diagnostics.schedule(doc)).toBe(true);
  timer.advance(1000);
  expect(checks).toBe(1);

  doc.setValue(ini.replace("missing", "note"));
  diagnostics.schedule(doc);
  timer.advance(200);
  expect(checks).toBe(2);
  expect(doc.issues).toEqual([]);
  doc.files = [];
  diagnostics.schedule(doc);
  timer.advance(200);
  expect(checks).toBe(3);
  expect(doc.issues.some(issue => issue.message.startsWith("Missing image"))).toBe(true);
});

test("a hidden document's stale request cannot publish obsolete squiggles", () => {
  const timer = clock(), doc = new TextDoc();
  doc.files = [];
  doc.setValue(ini);
  let checks = 0;
  const diagnostics = new IniDiagnostics(() => { throw new Error("stale publication"); }, () => { checks++; return []; }, timer);
  diagnostics.schedule(doc);
  doc.setValue("[General]\nName: Replaced\n");
  timer.advance(200);
  expect(checks).toBe(0);
  expect(doc.issues).toEqual([]);
});

test("selected-skin and mix-draft validation have independent idle deadlines", () => {
  const timer = clock(), selected = new TextDoc(), draft = new TextDoc();
  selected.setValue(ini);
  draft.setValue("[General]\nName: Mix\n");
  const published: TextDoc[] = [];
  const diagnostics = new IniDiagnostics(doc => published.push(doc), validate, timer);
  diagnostics.schedule(selected);
  timer.advance(100);
  diagnostics.schedule(draft);
  timer.advance(100);
  expect(published).toEqual([selected]);
  timer.advance(100);
  expect(published).toEqual([selected, draft]);
});
