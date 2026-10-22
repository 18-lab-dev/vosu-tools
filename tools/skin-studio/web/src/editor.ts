// Monaco skin.ini language: tokens, completion, hovers, colour swatches and
// quick fixes from @vosu-tools/skin-spec. Models carry their own file list
// (for image-name completion and checks) and diagnostics.

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
  validate,
  documentation,
  pathCandidates,
  type Diagnostic,
} from "@vosu-tools/skin-spec";
import { defineThemes, themeName, type Scheme } from "./themes";

export { monaco };

interface ModelState {
  /** Skin files for image checks; undefined skips them (hashed lazer stores). */
  files?: string[];
  issues: Diagnostic[];
}
const state = new WeakMap<monaco.editor.ITextModel, ModelState>();
const stateOf = (model: monaco.editor.ITextModel) => {
  let s = state.get(model);
  if (!s) state.set(model, (s = { issues: [] }));
  return s;
};

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
defineThemes(monaco);
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
export function rgb(value: string | undefined) {
  const c = (value ?? "").split(",").map(Number);
  return c.length >= 3 &&
    c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)
    ? c
    : null;
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

/** Validates a model against the spec, updating its markers. */
export function check(model: monaco.editor.ITextModel): Diagnostic[] {
  const s = stateOf(model);
  s.issues = validate(model.getValue(), s.files);
  monaco.editor.setModelMarkers(
    model,
    "skin-spec",
    s.issues.map((d) => ({
      startLineNumber: d.line,
      endLineNumber: d.line,
      startColumn: d.column,
      endColumn: model.getLineMaxColumn(d.line),
      message: d.message,
      severity:
        d.severity === "error"
          ? monaco.MarkerSeverity.Error
          : monaco.MarkerSeverity.Warning,
    })),
  );
  return s.issues;
}
export function setFiles(
  model: monaco.editor.ITextModel,
  files: string[] | undefined,
) {
  stateOf(model).files = files;
}

export async function createEditor(container: HTMLElement, scheme: Scheme) {
  // Monaco measures glyphs once; a font that arrives later misaligns the gutter.
  await document.fonts.load('13px "JetBrains Mono Variable"');
  return monaco.editor.create(container, {
    model: null,
    theme: themeName(scheme),
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 21,
    colorDecorators: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    padding: { top: 10, bottom: 10 },
    fixedOverflowWidgets: true,
  });
}
export const setScheme = (scheme: Scheme) =>
  monaco.editor.setTheme(themeName(scheme));
