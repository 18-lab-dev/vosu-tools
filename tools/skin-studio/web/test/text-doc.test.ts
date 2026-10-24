import { expect, test } from "bun:test";
// Monaco's own text buffer builder: what a model created from the text holds.
import { PieceTreeTextBufferBuilder } from "monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js";
import { TextDoc, normaliseText, rgb } from "../src/text-doc";

const monacoValue = (text: string) => {
  const builder = new PieceTreeTextBufferBuilder();
  builder.acceptChunk(text);
  const { textBuffer } = builder
    .finish(true)
    .create(1 /* DefaultEndOfLine.LF */);
  return textBuffer.getLinesContent().join(textBuffer.getEOL());
};

test("text is normalised exactly as a Monaco model stores it", () => {
  const samples = [
    "",
    "[General]",
    "a\r\nb\nc\r\n",
    "a\nb\r\nc\n",
    "a\rb\r\nc",
    "\uFEFF[General]\r\nName: x\r\nAuthor: y\nVersion: latest\r\n",
    "a\r\n\r\n\n\n",
    // (A text that is only "\r" is left out: the builder alone holds the
    // dangling CR back and yields two breaks; real files never consist of one.)
    "x\n\r\n\r",
  ];
  // Plus random mixes of the three line breaks.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 300; i++) {
    let text = random() < 0.2 ? "\uFEFF" : "";
    for (let j = 0, n = Math.floor(random() * 12); j < n; j++)
      text +=
        "ab"[Math.floor(random() * 2)] +
        ["\n", "\r\n", "\r", ""][Math.floor(random() * 4)];
    samples.push(text);
  }
  for (const text of samples)
    expect(normaliseText(text)).toBe(monacoValue(text));
});

test("documents notify only on real changes", () => {
  const doc = new TextDoc();
  let changes = 0;
  doc.onDidChangeContent(() => changes++);
  doc.setValue("a\r\nb\r\nc\n");
  expect(doc.getValue()).toBe("a\r\nb\r\nc\r\n");
  doc.setValue("a\r\nb\r\nc\r\n");
  expect(changes).toBe(1);
  expect(rgb("255, 0, 10")).toEqual([255, 0, 10]);
  expect(rgb("256,0,0")).toBeNull();
});
