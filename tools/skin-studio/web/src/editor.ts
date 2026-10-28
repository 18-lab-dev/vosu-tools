// The skin.ini editor, loaded on demand (the first view never fetches
// Monaco): the skin.ini language (tokens, completion, hovers, colour swatches
// and quick fixes from @vosu-tools/skin-spec) and one editor that mirrors the
// studio's TextDocs in Monaco models. Only the editor core and the
// contributions skin.ini uses are bundled; no other languages or workers.

import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/colorPicker/browser/colorContributions.js";
import "monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  parse,
  resolve,
  keys,
  sections,
  documentation,
  pathCandidates,
  imageLookupKind,
  legacyImageName,
  type Diagnostic,
} from "@vosu-tools/skin-spec";
import { type TextDoc, rgb } from "./text-doc";

/** The document each model mirrors (its files and last diagnostics). */
const docs = new WeakMap<monaco.editor.ITextModel, TextDoc>();
const stateOf = (model: monaco.editor.ITextModel) =>
  docs.get(model) ?? { files: undefined, issues: [] as Diagnostic[] };

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.languages.register({ id: "skin-ini" });
monaco.languages.setLanguageConfiguration("skin-ini", {
  comments: { lineComment: "//" },
  // No bracket pairs: skin.ini headers are not programming-language blocks.
  brackets: [],
  wordPattern: /[^\s:,[\]{}()]+/g,
});
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
    doc.lines.find((l) => l.block === block && l.key === "Keys")?.value?.split("//", 1)[0].trim() ?? 4,
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
      const comment = line.indexOf("//", colon + 1);
      if (comment >= 0 && pos.column > comment) return { suggestions: [] };
      const valueEnd = (comment < 0 ? line : line.slice(0, comment)).trimEnd().length;
      range = new monaco.Range(
        pos.lineNumber,
        colon + 2,
        pos.lineNumber,
        Math.max(colon + 2, valueEnd + 1),
      );
      const path = spec?.type === "image" || spec?.type === "prefix";
      if (path) {
        const start = colon + 1 + (line.slice(colon + 1).match(/^\s*/)?.[0].length ?? 0);
        const typed = line.slice(start, pos.column - 1).replace(/\\/g, "/");
        const folder = typed.slice(0, typed.lastIndexOf("/") + 1);
        range = new monaco.Range(pos.lineNumber, start + 1, pos.lineNumber, Math.max(start + 1, valueEnd + 1));
        const entries = new Map<string, boolean>();
        const files = stateOf(model).files ?? [];
        const variantsOf = new Map<string, string[]>();
        for (const file of files) {
          if (!/\.png$/i.test(file)) continue;
          const name = legacyImageName(file)?.toLowerCase();
          if (!name) continue;
          const variants = variantsOf.get(name) ?? [];
          variants.push(file);
          variantsOf.set(name, variants);
        }
        const candidates = pathCandidates(files, imageLookupKind(section, current!.key!));
        for (const name of candidates) {
          if (!name.toLowerCase().startsWith(folder.toLowerCase())) continue;
          const slash = name.indexOf("/", folder.length);
          const value = slash < 0 ? name : name.slice(0, slash + 1);
          entries.set(value, slash >= 0);
        }
        return {
          suggestions: [...entries].map(([value, directory]) => {
            const lower = value.toLowerCase();
            const variants = [...(variantsOf.get(lower) ?? []), ...(variantsOf.get(`${lower}-0`) ?? [])];
            const thumbnail = variants.map((file) => docs.get(model)?.assetUrls.get(file)).find(Boolean);
            return {
              label: value.slice(folder.length),
              filterText: value,
              detail: directory ? "Folder" : `${value}${variants.some((file) => /@2x\./i.test(file)) ? " · @2x" : ""}${variants.some((file) => /-0(?:@2x)?\./i.test(file)) ? " · animation" : ""}`,
              documentation: !directory && thumbnail ? { value: `![Preview](${thumbnail}|width=96,height=64)` } : undefined,
              kind: directory ? monaco.languages.CompletionItemKind.Folder : monaco.languages.CompletionItemKind.File,
              insertText: (start === colon + 1 ? " " : "") + value,
              command: directory ? { id: "editor.action.triggerSuggest", title: "Open folder" } : undefined,
              range,
            };
          }),
        };
      }
      const values = spec?.enum ?? (spec?.default ? [spec.default] : []);
      return {
        suggestions: values.map((value) => ({
          label: value,
          kind: monaco.languages.CompletionItemKind.Value,
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
  /** Opens the find widget (Ctrl+F from anywhere on the tab). */
  find(): void;
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
    multiCursorModifier: "alt",
    selectionClipboard: false,
    find: { addExtraSpaceOnTop: false },
    // skin.ini completion comes from the spec; word lists and link
    // detection would only wake the editor worker.
    wordBasedSuggestions: "off",
    links: false,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  // Monaco adds Ctrl to these on Linux to avoid desktop shortcuts; this
  // editor consistently uses the requested VS Code-style Shift+Alt gesture.
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
    void editor.getAction("editor.action.copyLinesUpAction")?.run();
  });
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => {
    void editor.getAction("editor.action.copyLinesDownAction")?.run();
  });
  // Chromium/Linux can dispatch primary-selection paste after middle-up
  // even when the pointer/auxclick default was cancelled. Treat that paste
  // as part of the rectangle gesture, not as an edit; a new key/pointer
  // gesture restores ordinary paste immediately.
  let middlePaste = false;
  container.addEventListener("keydown", () => { middlePaste = false; }, true);
  container.addEventListener("paste", (event) => {
    if (!middlePaste) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    middlePaste = false;
  }, true);
  container.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  // VS Code defaults to Shift+Alt+drag (viewController.dispatchMouse).
  // Keep that natively; own Alt+drag and middle-drag before the browser or
  // Monaco starts a last-cursor drag / primary-selection paste.
  container.addEventListener("pointerdown", (down) => {
    const middle = down.button === 1;
    middlePaste = middle;
    if (!middle && (!down.altKey || down.shiftKey || down.button !== 0)) return;
    const anchor = editor.getTargetAtClientPoint(down.clientX, down.clientY)?.position;
    if (!anchor) return;
    down.preventDefault();
    down.stopImmediatePropagation();
    editor.focus();
    container.setPointerCapture(down.pointerId);
    const previous = editor.getSelections() ?? [];
    let dragged = false;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId || !(event.buttons & (middle ? 4 : 1))) return;
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 4) return;
      const end = editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
      const model = editor.getModel();
      if (!end || !model) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragged = true;
      // Hit-test each visual row at the two screen X coordinates. Reusing
      // model columns would turn a zero-width box into a destructive range
      // across tabs, wide glyphs or wrapped lines.
      const origin = editor.getDomNode()!.getBoundingClientRect();
      const from = editor.getScrolledVisiblePosition(anchor);
      const to = editor.getScrolledVisiblePosition(end);
      if (!from || !to) return;
      const height = editor.getOption(monaco.editor.EditorOption.lineHeight);
      const selections: monaco.Selection[] = [];
      for (let top = Math.min(from.top, to.top); top <= Math.max(from.top, to.top); top += height) {
        const y = origin.top + top + height / 2;
        const start = editor.getTargetAtClientPoint(down.clientX, y)?.position;
        const finish = editor.getTargetAtClientPoint(event.clientX, y)?.position;
        if (start && finish) selections.push(monaco.Selection.fromPositions(start, finish));
      }
      if (selections.length) editor.setSelections(selections);
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId) return;
      if (!dragged && event.type === "pointerup")
        editor.setSelections([...(middle ? [] : previous), new monaco.Selection(anchor.lineNumber, anchor.column, anchor.lineNumber, anchor.column)]);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      container.removeEventListener("lostpointercapture", stop);
      if (container.hasPointerCapture(down.pointerId))
        container.releasePointerCapture(down.pointerId);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    container.addEventListener("lostpointercapture", stop);
  }, true);
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
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly, readOnlyMessage: { value: "Edit it in the draft" } }),
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
    find: () => {
      editor.focus();
      void editor.getAction("actions.find")?.run();
    },
    layout: () => editor.layout(),
    applyTheme,
  };
}
