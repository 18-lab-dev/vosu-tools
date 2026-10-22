import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/colorPicker/browser/colorContributions.js";
import "monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { vosu } from "/tools/_host/v1/bridge.js";
import {
  parse,
  resolve,
  keys,
  sections,
  validate,
  documentation,
  pathCandidates,
  revision,
  type Diagnostic,
} from "@vosu-tools/skin-spec";
import "./style.css";
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
const select = document.querySelector<HTMLSelectElement>("#skins")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const status = document.querySelector<HTMLElement>("#status")!;
const diagnostics = document.querySelector<HTMLOListElement>("#diagnostics")!;
let files: string[] = [],
  diskRevision = "",
  savedText = "",
  conflict = false,
  loading = false;
let issues: Diagnostic[] = [];
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
const model = monaco.editor.createModel("", "skin-ini");
const editor = monaco.editor.create(
  document.querySelector<HTMLElement>("#editor")!,
  {
    model,
    theme:
      document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: 14,
    colorDecorators: true,
    scrollBeyondLastLine: false,
  },
);
new MutationObserver(() =>
  monaco.editor.setTheme(
    document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark",
  ),
).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
function context(line: number) {
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
  provideCompletionItems(_model, pos) {
    const { current, section, count } = context(pos.lineNumber),
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
          ? pathCandidates(files, spec.type === "prefix")
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
  provideHover(_m, pos) {
    const { current, section } = context(pos.lineNumber);
    const spec = current?.key ? resolve(section, current.key) : undefined;
    return spec ? { contents: [{ value: documentation(spec) }] } : null;
  },
});
monaco.languages.registerColorProvider("skin-ini", {
  provideDocumentColors() {
    return parse(model.getValue()).lines.flatMap((l) => {
      const s = l.key ? resolve(l.section, l.key) : undefined;
      if (!s || !["rgb", "rgba"].includes(s.type)) return [];
      const c = l.value!.split(",").map(Number);
      if (
        c.length < 3 ||
        c.some((v) => !Number.isFinite(v) || v < 0 || v > 255)
      )
        return [];
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
  provideColorPresentations(_m, info) {
    const c = info.color;
    const spec = context(info.range.startLineNumber).current;
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
    provideCodeActions(_m, range) {
      return {
        actions: issues
          .filter((d) => d.line === range.startLineNumber && d.replacement)
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
function refresh() {
  issues = validate(model.getValue(), files);
  monaco.editor.setModelMarkers(
    model,
    "skin-spec",
    issues.map((d) => ({
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
  diagnostics.replaceChildren(
    ...issues.map((d) => {
      const li = document.createElement("li"),
        button = document.createElement("button");
      button.textContent = `${d.line} / ${d.message}`;
      button.onclick = () => {
        editor.revealLineInCenter(d.line);
        editor.setPosition({ lineNumber: d.line, column: d.column });
        editor.focus();
      };
      li.append(button);
      return li;
    }),
  );
  save.disabled =
    !vosu.canWrite ||
    !select.value ||
    loading ||
    conflict ||
    model.getValue() === savedText;
}
model.onDidChangeContent(refresh);
async function request(path: string, init?: RequestInit) {
  const response = await vosu.fetch(path, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function load() {
  if (loading || !select.value) return;
  loading = true;
  refresh();
  try {
    const data = await request(
      `v1/skin?folder=${encodeURIComponent(select.value)}`,
    );
    files = data.files;
    diskRevision = data.revision;
    savedText = data.text;
    conflict = false;
    model.setValue(data.text);
    status.textContent = `${files.length} files indexed · ${select.selectedOptions[0].textContent}`;
  } catch (error) {
    status.textContent = String(error);
  } finally {
    loading = false;
    refresh();
  }
}
select.onchange = () => {
  if (
    model.getValue() !== savedText &&
    !confirm("Discard unsaved editor changes and open another skin?")
  ) {
    const option = [...select.options].find((o) => o.dataset.loaded === "true");
    if (option) select.value = option.value;
    return;
  }
  void load().then(() => {
    for (const o of select.options) o.dataset.loaded = String(o.selected);
  });
};
document.querySelector<HTMLButtonElement>("#reload")!.onclick = () => {
  if (
    model.getValue() === savedText ||
    confirm("Discard unsaved editor changes and reload from disk?")
  )
    void load();
};
save.onclick = async () => {
  loading = true;
  refresh();
  const text = model.getValue();
  try {
    const data = await request("v1/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: select.value,
        text,
        revision: diskRevision,
      }),
    });
    savedText = text;
    diskRevision = data.revision;
    status.textContent = `Saved atomically · backup: ${data.backup ?? "new skin.ini"}`;
  } catch (error) {
    status.textContent = String(error);
  } finally {
    loading = false;
    refresh();
  }
};
window.addEventListener("beforeunload", (event) => {
  if (model.getValue() !== savedText) {
    event.preventDefault();
  }
});
await vosu.ready;
document.querySelector("#mode")!.textContent = vosu.canWrite
  ? "WRITE SESSION"
  : "READ ONLY · Open from dashboard to save";
document.querySelector("#revision")!.textContent =
  `Wiki facts verified at ${revision.slice(0, 12)}. Native Monaco providers; no language server or CDN.`;
try {
  const skins: { folder: string; name: string; current: boolean }[] =
    await request("v1/skins");
  for (const skin of skins) {
    const option = document.createElement("option");
    option.value = skin.folder;
    option.textContent = skin.name + (skin.current ? " · CURRENT" : "");
    option.selected = skin.current;
    select.append(option);
  }
  if (skins.length) {
    await load();
    for (const o of select.options) o.dataset.loaded = String(o.selected);
  } else
    status.textContent =
      "No stable skins available. Select an osu!stable context in vosu. Lazer skins are unsupported.";
} catch (error) {
  status.textContent = String(error);
}
setInterval(async () => {
  if (!select.value || loading) return;
  try {
    const data = await request(
      `v1/skin?folder=${encodeURIComponent(select.value)}`,
    );
    files = data.files;
    if (data.revision !== diskRevision) {
      conflict = true;
      status.textContent =
        "EXTERNAL CHANGE · Reload before saving. Unsaved editor text is retained.";
    }
    refresh();
  } catch (error) {
    status.textContent = String(error);
  }
}, 4000);
