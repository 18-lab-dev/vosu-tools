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
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./style.css";
import { defineThemes, themeName, type Scheme } from "./themes";

interface Skin {
  name: string;
  folder: string;
  current: boolean;
  origin: "stable" | "added";
  available: boolean;
}
interface Library {
  client: "stable" | "lazer" | null;
  skin: { name: string | null; files: boolean; builtin: string | null } | null;
  skins_dir: string | null;
  skins: Skin[];
}
/** The lazer client's current skin, read through vosu's /files/skin/ route. */
const LAZER = "lazer:current";

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const list = $<HTMLUListElement>("#skins");
const filter = $<HTMLInputElement>("#filter");
const save = $<HTMLButtonElement>("#save");
const reload = $<HTMLButtonElement>("#reload");
const status = $("#status");
const diagnostics = $<HTMLOListElement>("#diagnostics");
const guide = $("#guide");
const addForm = $<HTMLFormElement>("#add-folder");
const folderPath = $<HTMLInputElement>("#folder-path");
const folderHint = $("#folder-hint");
const folderHintText = folderHint.textContent!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  node.append(...children.filter((c): c is Node | string => !!c));
  return node;
}

let scheme: Scheme = currentScheme();
function currentScheme(): Scheme {
  return (
    vosu.colorScheme ??
    (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
  );
}
function applyScheme() {
  scheme = currentScheme();
  document.documentElement.dataset.scheme = scheme;
  document.documentElement.style.colorScheme = scheme;
  monaco.editor.setTheme(themeName(scheme));
}

let library: Library = { client: null, skin: null, skins_dir: null, skins: [] };
let open: string | null = null,
  files: string[] | undefined,
  diskRevision = "",
  savedText = "",
  conflict = false,
  loading = false,
  libraryError = "";
let issues: Diagnostic[] = [];

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
defineThemes(monaco);
document.documentElement.dataset.scheme = scheme;
document.documentElement.style.colorScheme = scheme;
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
// Monaco measures glyphs once; a font that arrives later misaligns the gutter.
await document.fonts.load('13.5px "JetBrains Mono Variable"');
const editor = monaco.editor.create($("#editor"), {
  model,
  theme: themeName(scheme),
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
  fontSize: 13.5,
  lineHeight: 22,
  colorDecorators: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  padding: { top: 14, bottom: 14 },
  fixedOverflowWidgets: true,
});
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
  if (!save.disabled) void store();
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!save.disabled) void store();
  }
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
          ? pathCandidates(files ?? [], spec.type === "prefix")
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
function rgb(value: string | undefined) {
  const c = (value ?? "").split(",").map(Number);
  return c.length >= 3 &&
    c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)
    ? c
    : null;
}
monaco.languages.registerColorProvider("skin-ini", {
  provideDocumentColors() {
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

function reveal(line: number, column = 1) {
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column });
  editor.focus();
}
const dirty = () => open !== null && model.getValue() !== savedText;

/** Title block and colour strip, both read from the text being edited. */
function renderProof() {
  const doc = parse(model.getValue());
  const general = (key: string) =>
    doc.lines.find((l) => l.section === "General" && l.key === key)?.value;
  const skin = library.skins.find((s) => s.folder === open);
  const name =
    open === null
      ? "Nothing open"
      : general("Name") ||
        (open === LAZER ? library.skin?.name : skin?.name) ||
        "Untitled skin";
  $("#skin-name").textContent = name;
  const author = general("Author");
  $("#skin-meta").replaceChildren(
    ...(open === null
      ? []
      : [
          author ? h("span", {}, `by ${author}`) : null,
          h(
            "span",
            { class: "path", title: open === LAZER ? "" : open },
            open === LAZER ? "lazer current skin · read-only snapshot" : open,
          ),
        ].filter((n): n is HTMLSpanElement => !!n)),
  );
  const colours = doc.lines.filter((l) => {
    const s =
      l.section === "Colours" && l.key ? resolve(l.section, l.key) : null;
    return s && ["rgb", "rgba"].includes(s.type) && rgb(l.value);
  });
  $("#colour-bar").replaceChildren(
    ...colours.map((l) => {
      const c = rgb(l.value)!;
      const chip = h("span", { class: "chip" });
      chip.style.backgroundColor = `rgb(${c[0]} ${c[1]} ${c[2]})`;
      const short =
        /^Combo(\d)$/.exec(l.key!)?.[1] ?? l.key!.replace(/[a-z]/g, "");
      return h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            title: `${l.key}: ${l.value}`,
            ariaLabel: `${l.key} ${l.value}, line ${l.line}`,
            onclick: () => reveal(l.line, l.valueColumn ?? 1),
          },
          chip,
          h("span", { class: "chip-label" }, short),
        ),
      );
    }),
  );
}

function refresh() {
  issues = open === null ? [] : validate(model.getValue(), files);
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
  $("#issue-count").textContent = open === null ? "" : String(issues.length);
  diagnostics.replaceChildren(
    ...(open === null
      ? [
          h(
            "li",
            { class: "idle" },
            "Open a skin to check it against the wiki reference.",
          ),
        ]
      : issues.length === 0
        ? [
            h(
              "li",
              { class: "clean" },
              "No problems found against the wiki reference.",
            ),
          ]
        : issues.map((d) =>
            h(
              "li",
              { class: d.severity },
              h(
                "button",
                { type: "button", onclick: () => reveal(d.line, d.column) },
                h("span", { class: "line" }, `L${d.line}`),
                h("span", { class: "message" }, d.message),
              ),
            ),
          )),
  );
  save.disabled =
    !vosu.canWrite ||
    open === null ||
    open === LAZER ||
    loading ||
    conflict ||
    !dirty();
  reload.disabled = open === null || loading;
  save.title = !vosu.canWrite
    ? "Read-only: open this tool from the vosu dashboard to save."
    : open === LAZER
      ? "Lazer's current skin is read-only; use Edit externally in lazer."
      : "";
  renderProof();
}
model.onDidChangeContent(refresh);

async function request(path: string, init?: RequestInit) {
  const response = await vosu.fetch(path, init);
  if (!response.ok)
    throw new Error((await response.text()) || response.statusText);
  return response.json();
}
const post = (path: string, body: unknown) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function show(target: string | null) {
  open = target;
  guide.hidden = open !== null;
  $("#editor").hidden = open === null;
  editor.updateOptions({ readOnly: open === LAZER || !vosu.canWrite });
  renderLibrary();
  if (open === null) renderGuide();
  refresh();
}

async function openSkin(target: string) {
  if (loading) return;
  if (dirty() && !confirm("Discard unsaved changes to this skin.ini?")) return;
  loading = true;
  refresh();
  try {
    let text: string;
    if (target === LAZER) {
      const response = await fetch("/files/skin/skin.ini", {
        credentials: "omit",
      });
      if (response.status === 404)
        throw new Error("The current lazer skin has no skin.ini.");
      if (!response.ok)
        throw new Error(
          `vosu could not read the lazer skin (${response.status}).`,
        );
      text = await response.text();
      files = undefined;
      diskRevision = "";
    } else {
      const data = await request(
        `v1/skin?folder=${encodeURIComponent(target)}`,
      );
      text = data.text;
      files = data.files;
      diskRevision = data.revision;
    }
    conflict = false;
    show(target);
    model.setValue(text);
    // Monaco normalises mixed line endings; compare against what it holds.
    savedText = model.getValue();
    editor.setScrollTop(0);
    status.textContent =
      target === LAZER
        ? "Read-only snapshot. Image names are not checked because lazer stores files under hashes."
        : `${files!.length} files indexed${text ? "" : " · no skin.ini yet; saving creates one"}`;
  } catch (error) {
    status.textContent = message(error);
  } finally {
    loading = false;
    refresh();
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function renderLibrary() {
  const query = filter.value.trim().toLowerCase();
  const entries: { key: string; name: string; tags: string[]; skin?: Skin }[] =
    [];
  if (library.client === "lazer" && library.skin?.files)
    entries.push({
      key: LAZER,
      name: library.skin.name ?? "Current skin",
      tags: ["lazer", "read-only"],
    });
  for (const skin of library.skins)
    entries.push({
      key: skin.folder,
      name: skin.name,
      skin,
      tags: [
        ...(skin.current ? ["current"] : []),
        ...(skin.origin === "added" ? ["added"] : []),
        ...(skin.available ? [] : ["gone"]),
      ],
    });
  const total = library.skins.length;
  $("#skin-count").textContent = total ? String(total) : "";
  filter.hidden = total < 8;
  const shown = entries.filter(
    (e) => !query || e.name.toLowerCase().includes(query),
  );
  list.replaceChildren(
    ...shown.map((e) =>
      h(
        "li",
        { class: e.skin && !e.skin.available ? "gone" : "" },
        h(
          "button",
          {
            type: "button",
            class: "skin",
            disabled: !!e.skin && !e.skin.available,
            title: e.skin?.folder ?? "",
            onclick: () => void openSkin(e.key),
          },
          h("span", { class: "name" }, e.name),
          ...e.tags.map((t) => h("span", { class: `tag ${t}` }, t)),
        ),
        e.skin?.origin === "added"
          ? h(
              "button",
              {
                type: "button",
                class: "forget",
                title: "Remove from the library (files stay untouched)",
                ariaLabel: `Forget ${e.name}`,
                disabled: !vosu.canWrite,
                onclick: () => void forget(e.skin!),
              },
              "Forget",
            )
          : null,
      ),
    ),
  );
  list
    .querySelectorAll<HTMLButtonElement>("button.skin")
    .forEach((button, i) =>
      button.setAttribute("aria-current", String(shown[i].key === open)),
    );
  if (query && !shown.length)
    list.append(
      h("li", { class: "none" }, `No skin matches “${filter.value}”.`),
    );
  else if (!entries.length)
    list.append(
      h("li", { class: "none" }, "No skins yet. Add a skin folder below."),
    );
}

function renderGuide() {
  const lazer = library.client === "lazer";
  const skin = library.skin;
  const blocks: Node[] = [];
  if (libraryError) {
    blocks.push(
      h("p", { class: "kicker" }, "Service unavailable"),
      h("h2", {}, "The editor service could not read the skin library."),
      h("p", { class: "error" }, libraryError),
    );
  } else if (lazer) {
    blocks.push(
      h("p", { class: "kicker" }, "osu!lazer"),
      h("h2", {}, "Lazer keeps skins inside its own file store."),
      h(
        "p",
        {},
        "Its files are stored under hashed names, so there is no skin folder this editor could safely write to. Lazer can lend you a real folder instead:",
      ),
      h(
        "ol",
        { class: "steps" },
        h(
          "li",
          {},
          "In lazer, open the skin editor (",
          h("kbd", {}, "Ctrl Shift S"),
          ") and choose ",
          h("b", {}, "File → Edit externally…"),
        ),
        h(
          "li",
          {},
          "Press ",
          h("b", {}, "Open folder"),
          " and copy the path of the folder that opens (named after a long hash, in your temp directory).",
        ),
        h(
          "li",
          {},
          "Paste it into ",
          h("b", {}, "Add a skin folder"),
          " in the library, then edit and save here.",
        ),
        h(
          "li",
          {},
          "Back in lazer, press ",
          h("b", {}, "Finish editing and import changes"),
          ". Lazer then removes the folder; forget it here.",
        ),
      ),
    );
    if (skin?.files)
      blocks.push(
        h(
          "p",
          { class: "current" },
          `Current skin: ${skin.name ?? "unnamed"}. `,
          h(
            "button",
            {
              type: "button",
              class: "quiet",
              onclick: () => void openSkin(LAZER),
            },
            "Inspect its skin.ini (read-only)",
          ),
        ),
      );
    else if (skin?.builtin)
      blocks.push(
        h(
          "p",
          { class: "current" },
          `Current skin: ${skin.name ?? skin.builtin} is built into lazer and has no skin.ini. Select an imported skin in lazer to edit one.`,
        ),
      );
    else if (skin?.name)
      blocks.push(h("p", { class: "current" }, `Current skin: ${skin.name}.`));
  } else if (library.client === "stable") {
    if (library.skins.some((s) => s.origin === "stable"))
      blocks.push(
        h("p", { class: "kicker" }, "osu!stable"),
        h("h2", {}, "Pick a skin from the library."),
        h(
          "p",
          {},
          `Skins are read from ${library.skins_dir}. Nothing is written until you save.`,
        ),
      );
    else
      blocks.push(
        h("p", { class: "kicker" }, "osu!stable"),
        h("h2", {}, "This osu! install has no skins yet."),
        h(
          "p",
          {},
          `vosu found no skin folders in ${library.skins_dir ?? "the Skins folder"}. Install a skin in osu! or add a folder from elsewhere.`,
        ),
      );
  } else {
    blocks.push(
      h("p", { class: "kicker" }, "No client"),
      h("h2", {}, "vosu isn't reading an osu! client right now."),
      h(
        "p",
        {},
        "Start osu!stable or osu!lazer, or choose an instance in the vosu dashboard; this page updates on its own. Skin folders you add work without a client.",
      ),
    );
  }
  if (!vosu.canWrite)
    blocks.push(
      h(
        "p",
        { class: "note" },
        "This tab is read-only. Open the editor from the vosu dashboard to add folders and save.",
      ),
    );
  guide.replaceChildren(h("div", { class: "guide-body" }, ...blocks));
}

async function loadLibrary() {
  try {
    library = await request("v1/skins");
    libraryError = "";
  } catch (error) {
    libraryError = message(error);
  }
  renderLibrary();
  if (open === null) renderGuide();
}

async function store() {
  if (open === null || open === LAZER) return;
  loading = true;
  refresh();
  const text = model.getValue();
  try {
    const data = await post("v1/save", {
      folder: open,
      text,
      revision: diskRevision,
    });
    savedText = text;
    diskRevision = data.revision;
    status.textContent = data.backup
      ? `Saved. Previous version kept as ${data.backup}.`
      : "Saved. Created a new skin.ini.";
  } catch (error) {
    status.textContent = message(error);
  } finally {
    loading = false;
    refresh();
  }
}

async function forget(skin: Skin) {
  if (skin.folder === open && dirty() && !confirm("Discard unsaved changes?"))
    return;
  try {
    library = await post("v1/folders/forget", { folder: skin.folder });
    if (skin.folder === open) {
      savedText = "";
      show(null);
      model.setValue("");
    }
    renderLibrary();
    status.textContent = `Forgot ${skin.folder}. Its files were not touched.`;
  } catch (error) {
    status.textContent = message(error);
  }
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const path = folderPath.value.trim();
  if (!path) return folderPath.focus();
  const before = new Set(library.skins.map((s) => s.folder));
  folderHint.removeAttribute("role");
  folderHint.classList.remove("error");
  try {
    library = await post("v1/folders/add", { path });
    folderPath.value = "";
    folderHint.textContent = folderHintText;
    const added =
      library.skins.find((s) => !before.has(s.folder)) ??
      library.skins.find((s) => s.origin === "added" && s.folder === path);
    renderLibrary();
    if (added) await openSkin(added.folder);
  } catch (error) {
    folderHint.textContent = message(error);
    folderHint.classList.add("error");
    folderHint.setAttribute("role", "alert");
  }
});
filter.addEventListener("input", renderLibrary);
reload.onclick = () => {
  if (open !== null) void openSkin(open);
};
save.onclick = () => void store();
window.addEventListener("beforeunload", (event) => {
  if (dirty()) event.preventDefault();
});

show(null);
try {
  await vosu.ready;
} catch (error) {
  status.textContent = message(error);
}
applyScheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (!vosu.colorScheme) applyScheme();
});
$("#mode").textContent = vosu.canWrite
  ? "Write session"
  : "Read-only · open from the vosu dashboard to save";
$("#mode").classList.toggle("live", vosu.canWrite);
for (const control of addForm.querySelectorAll<
  HTMLInputElement | HTMLButtonElement
>("input, button"))
  control.disabled = !vosu.canWrite;
$("#revision").textContent =
  `Key reference from the osu! wiki at ${revision.slice(0, 10)}. Completion, hovers and checks run locally.`;
await loadLibrary();
const current = library.skins.find((s) => s.current && s.available);
if (current) await openSkin(current.folder);
else
  status.textContent = libraryError
    ? "Service unavailable."
    : `${library.skins.length} skin${library.skins.length === 1 ? "" : "s"} in the library.`;

setInterval(async () => {
  if (loading || document.hidden) return;
  if (open === null || open === LAZER) return void loadLibrary();
  try {
    const data = await request(`v1/skin?folder=${encodeURIComponent(open)}`);
    files = data.files;
    if (data.revision !== diskRevision && !conflict) {
      conflict = true;
      status.textContent =
        "skin.ini changed on disk. Reload before saving; your editor text is kept until then.";
    }
    refresh();
  } catch {
    await loadLibrary();
    const skin = library.skins.find((s) => s.folder === open);
    if (!skin?.available) {
      conflict = true;
      status.textContent =
        "This folder is gone (lazer deletes its external-edit folder after import). Your text is kept in the editor; forget the folder when done.";
      refresh();
    }
  }
}, 4000);
