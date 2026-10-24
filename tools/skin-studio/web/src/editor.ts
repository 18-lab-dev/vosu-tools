// The skin.ini editor, loaded on demand (the first view never fetches
// Monaco): the skin.ini language (tokens, completion, hovers, colour swatches
// and quick fixes from @vosu-tools/skin-spec) and one editor that mirrors the
// studio's TextDocs in Monaco models. Only the editor core and the five
// contributions skin.ini uses are bundled; no other languages or workers.

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/colorPicker/browser/colorContributions.js";
import "monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  parse,
  resolve,
  keys,
  sections,
  documentation,
  pathCandidates,
  type Diagnostic,
} from "@vosu-tools/skin-spec";
import { type TextDoc, rgb } from "./text-doc";

/** The document each model mirrors (its files and last diagnostics). */
const docs = new WeakMap<monaco.editor.ITextModel, TextDoc>();
const stateOf = (model: monaco.editor.ITextModel) =>
  docs.get(model) ?? { files: undefined, issues: [] as Diagnostic[] };

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.languages.register({ id: "skin-ini" });
monaco.languages.setMonarchTokensProvider("skin-ini", {
  tokenizer: {
    root: [
      [/^\s*(\/\/|;).*$/, "comment"],
      [/^\s*\[[^\]]+\]/, "type"],
      [/^\s*[^:]+(?=:)/, "key"],
      [/:/, "delimiter"],
      [/-?\d+(\.\d+)?/, "number"],
    ],
  },
});

function context(model: monaco.editor.ITextModel, line: number) {
  const doc = parse(model.getValue());
  const current = doc.lines.find((l) => l.line === line);
  const preceding = doc.lines.filter((l) => l.line <= line);
  const section = current?.section ?? preceding.at(-1)?.section ?? "";
  const block = current?.block ?? preceding.at(-1)?.block;
  const count = Number(
    doc.lines.find((l) => l.block === block && l.key === "Keys")?.value ?? 4,
  );
  return { current, section, count };
}

monaco.languages.registerCompletionItemProvider("skin-ini", {
  triggerCharacters: ["[", ":", ",", "/"],
  provideCompletionItems(model, pos) {
    const { current, section, count } = context(model, pos.lineNumber),
      line = model.getLineContent(pos.lineNumber),
      colon = line.indexOf(":");
    const word = model.getWordUntilPosition(pos);
    let range = new monaco.Range(
      pos.lineNumber,
      word.startColumn,
      pos.lineNumber,
      word.endColumn,
    );
    if (colon >= 0 && pos.column > colon + 1) {
      const spec = current?.key ? resolve(section, current.key) : undefined;
      range = new monaco.Range(
        pos.lineNumber,
        colon + 2,
        pos.lineNumber,
        line.length + 1,
      );
      const values =
        spec?.type === "image" || spec?.type === "prefix"
          ? pathCandidates(stateOf(model).files ?? [], spec.type === "prefix")
          : (spec?.enum ?? (spec?.default ? [spec.default] : []));
      return {
        suggestions: values.map((value) => ({
          label: value,
          kind: monaco.languages.CompletionItemKind.File,
          insertText: " " + value,
          range,
        })),
      };
    }
    if (line.trimStart().startsWith("[") || !section) {
      range = new monaco.Range(
        pos.lineNumber,
        1,
        pos.lineNumber,
        line.length + 1,
      );
      return {
        suggestions: sections.map((s) => ({
          label: `[${s}]`,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: `[${s}]`,
          range,
        })),
      };
    }
    return {
      suggestions: keys(section, count).map((s) => ({
        label: s.key,
        kind: monaco.languages.CompletionItemKind.Property,
        insertText: `${s.key}: ${s.default ?? s.enum?.[0] ?? ""}`,
        documentation: { value: documentation(s) },
        range,
      })),
    };
  },
});
monaco.languages.registerHoverProvider("skin-ini", {
  provideHover(model, pos) {
    const { current, section } = context(model, pos.lineNumber);
    const spec = current?.key ? resolve(section, current.key) : undefined;
    return spec ? { contents: [{ value: documentation(spec) }] } : null;
  },
});
monaco.languages.registerColorProvider("skin-ini", {
  provideDocumentColors(model) {
    return parse(model.getValue()).lines.flatMap((l) => {
      const s = l.key ? resolve(l.section, l.key) : undefined;
      const c = s && ["rgb", "rgba"].includes(s.type) ? rgb(l.value) : null;
      if (!c) return [];
      return [
        {
          range: new monaco.Range(
            l.line,
            l.valueColumn!,
            l.line,
            l.raw.length + 1,
          ),
          color: {
            red: c[0] / 255,
            green: c[1] / 255,
            blue: c[2] / 255,
            alpha: (c[3] ?? 255) / 255,
          },
        },
      ];
    });
  },
  provideColorPresentations(model, info) {
    const c = info.color;
    const spec = context(model, info.range.startLineNumber).current;
    const rgba = spec?.key && resolve(spec.section, spec.key)?.type === "rgba";
    const label = [c.red, c.green, c.blue, ...(rgba ? [c.alpha] : [])]
      .map((v) => Math.round(v * 255))
      .join(",");
    return [{ label, textEdit: { range: info.range, text: label } }];
  },
});
monaco.languages.registerCodeActionProvider(
  "skin-ini",
  {
    provideCodeActions(model, range) {
      return {
        actions: stateOf(model)
          .issues.filter(
            (d) => d.line === range.startLineNumber && d.replacement,
          )
          .map((d) => {
            const line = model.getLineContent(d.line),
              isHeader = line.trim().startsWith("[");
            const editRange = isHeader
              ? new monaco.Range(d.line, 1, d.line, line.length + 1)
              : new monaco.Range(d.line, 1, d.line, line.indexOf(":") + 1);
            return {
              title: `Use ${d.replacement}`,
              kind: "quickfix",
              edit: {
                edits: [
                  {
                    resource: model.uri,
                    textEdit: { range: editRange, text: d.replacement! },
                    versionId: model.getVersionId(),
                  },
                ],
              },
            };
          }),
        dispose() {},
      };
    },
  },
  { providedCodeActionKinds: ["quickfix"] },
);

/** A CSS colour (hex, rgb() with alpha, …) as Monaco's `#rrggbbaa`. */
function hex(value: string): string {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.fillStyle = "#000";
  probe.fillStyle = value;
  const normal = String(probe.fillStyle);
  if (normal.startsWith("#")) return normal;
  const [r, g, b, a = 1] = (normal.match(/[\d.]+/g) ?? []).map(Number);
  return `#${[r, g, b, Math.round(a * 255)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

const THEME = "skin-studio";
/** Defines the editor theme from the 18-LAB tokens of the current mode. */
function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => hex(css.getPropertyValue(name).trim());
  const bare = (name: string) => token(name).slice(1, 7);
  const light = document.documentElement.dataset.theme === "light";
  monaco.editor.defineTheme(THEME, {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: bare("--fg") },
      { token: "comment", foreground: bare("--muted"), fontStyle: "italic" },
      { token: "type", foreground: bare("--accent") },
      { token: "key", foreground: bare("--fg") },
      { token: "delimiter", foreground: bare("--muted") },
      { token: "number", foreground: bare("--note") },
    ],
    colors: {
      "editor.background": token("--bg-sunken"),
      "editor.foreground": token("--fg"),
      "editorGutter.background": token("--bg-sunken"),
      "editorLineNumber.foreground": token("--muted"),
      "editorLineNumber.activeForeground": token("--accent"),
      "editor.lineHighlightBackground": token("--hover"),
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": token("--selected"),
      "editor.inactiveSelectionBackground": token("--selected"),
      "editorCursor.foreground": token("--accent"),
      "editorWhitespace.foreground": token("--rule"),
      "editorIndentGuide.background1": token("--rule"),
      "editorWidget.background": token("--bg-raised"),
      "editorWidget.foreground": token("--fg"),
      "editorWidget.border": token("--rule-strong"),
      "editorHoverWidget.background": token("--bg-raised"),
      "editorHoverWidget.foreground": token("--fg"),
      "editorHoverWidget.border": token("--rule-strong"),
      "editorSuggestWidget.background": token("--bg-raised"),
      "editorSuggestWidget.foreground": token("--fg"),
      "editorSuggestWidget.border": token("--rule-strong"),
      "editorSuggestWidget.highlightForeground": token("--accent"),
      "editorSuggestWidget.focusHighlightForeground": token("--accent"),
      "editorSuggestWidget.selectedBackground": token("--selected"),
      "editorSuggestWidget.selectedForeground": token("--fg"),
      "list.hoverBackground": token("--hover"),
      "editorError.foreground": token("--danger"),
      "editorWarning.foreground": token("--caution"),
      "editorLightBulb.foreground": token("--caution"),
      "textLink.foreground": token("--accent"),
      "textLink.activeForeground": token("--accent"),
      "textCodeBlock.background": token("--bg-sunken"),
      focusBorder: token("--accent"),
      "scrollbarSlider.background": `${token("--rule-strong").slice(0, 7)}99`,
      "scrollbarSlider.hoverBackground": token("--rule-strong"),
      "scrollbarSlider.activeBackground": token("--accent"),
      "scrollbar.shadow": "#00000000",
      "widget.shadow": "#0000002e",
    },
  });
  monaco.editor.setTheme(THEME);
}

export interface IniEditor {
  /** Shows a document (its model is created on first use). */
  show(doc: TextDoc): void;
  setReadOnly(readOnly: boolean): void;
  /** Markers for the document's current `issues`. */
  mark(doc: TextDoc): void;
  reveal(line: number, column: number): void;
  layout(): void;
  /** Re-reads the 18-LAB colour tokens after a mode change. */
  applyTheme(): void;
}

/** Creates the editor in `container`; `save` runs on Ctrl/Cmd+S. */
export async function createIniEditor(
  container: HTMLElement,
  save: () => void,
): Promise<IniEditor> {
  // Monaco measures glyphs once; a font that arrives later misaligns the gutter.
  await document.fonts.load('13px "IBM Plex Mono"');
  applyTheme();
  const editor = monaco.editor.create(container, {
    model: null,
    theme: THEME,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim(),
    fontSize: 13,
    lineHeight: 20,
    colorDecorators: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    padding: { top: 8, bottom: 8 },
    fixedOverflowWidgets: true,
    // skin.ini completion comes from the spec; word lists and link
    // detection would only wake the editor worker.
    wordBasedSuggestions: "off",
    links: false,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  const models = new Map<TextDoc, monaco.editor.ITextModel>();
  const modelOf = (doc: TextDoc) => {
    let model = models.get(doc);
    if (model) return model;
    model = monaco.editor.createModel(doc.getValue(), "skin-ini");
    docs.set(model, doc);
    models.set(doc, model);
    let syncing = false;
    // Typing updates the document; outside changes update the model.
    model.onDidChangeContent(() => {
      if (!syncing) doc.setValue(model!.getValue());
    });
    doc.onDidChangeContent(() => {
      if (model!.getValue() === doc.getValue()) return;
      syncing = true;
      model!.setValue(doc.getValue());
      syncing = false;
    });
    return model;
  };
  return {
    show(doc) {
      const model = modelOf(doc);
      if (editor.getModel() !== model) editor.setModel(model);
    },
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly }),
    mark(doc) {
      const model = modelOf(doc);
      monaco.editor.setModelMarkers(
        model,
        "skin-spec",
        doc.issues.map((d) => ({
          startLineNumber: d.line,
          endLineNumber: d.line,
          startColumn: d.column,
          endColumn: model.getLineMaxColumn(
            Math.min(d.line, model.getLineCount()),
          ),
          message: d.message,
          severity:
            d.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
        })),
      );
    },
    reveal(line, column) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    },
    layout: () => editor.layout(),
    applyTheme,
  };
}
