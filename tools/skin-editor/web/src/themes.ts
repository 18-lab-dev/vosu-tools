import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";

export type Scheme = "dark" | "light";

/**
 * Proof-sheet palettes. Keep in sync with the custom properties in
 * style.css: the editor surface is `--sunk`, accents are the two inks.
 */
const palettes = {
  dark: {
    base: "vs-dark",
    sunk: "130f0e",
    panel: "201918",
    line: "3b302d",
    text: "f1e7df",
    muted: "b09f95",
    faint: "6f625b",
    ink: "ff5d8f",
    ink2: "52c6b4",
    warn: "efb54a",
    error: "ff7262",
    select: "ff5d8f33",
    highlight: "f1e7df0c",
  },
  light: {
    base: "vs",
    sunk: "fffcf6",
    panel: "faf6ee",
    line: "d9cfbf",
    text: "2a201d",
    muted: "6b5d55",
    faint: "a69a90",
    ink: "c2185b",
    ink2: "0b7266",
    warn: "8f5d00",
    error: "b8322a",
    select: "c2185b26",
    highlight: "2a201d0a",
  },
} as const;

export const themeName = (scheme: Scheme) => `skin-proof-${scheme}`;

export function defineThemes(monaco: typeof Monaco) {
  for (const scheme of ["dark", "light"] as const) {
    const p = palettes[scheme];
    const hex = (v: string) => `#${v}`;
    monaco.editor.defineTheme(themeName(scheme), {
      base: p.base,
      inherit: true,
      rules: [
        { token: "", foreground: p.text },
        { token: "comment", foreground: p.muted, fontStyle: "italic" },
        { token: "type", foreground: p.ink, fontStyle: "bold" },
        { token: "key", foreground: p.text },
        { token: "delimiter", foreground: p.faint },
        { token: "number", foreground: p.ink2 },
      ],
      colors: {
        "editor.background": hex(p.sunk),
        "editor.foreground": hex(p.text),
        "editorGutter.background": hex(p.sunk),
        "editorLineNumber.foreground": hex(p.faint),
        "editorLineNumber.activeForeground": hex(p.ink),
        "editor.lineHighlightBackground": hex(p.highlight),
        "editor.lineHighlightBorder": "#00000000",
        "editor.selectionBackground": hex(p.select),
        "editor.inactiveSelectionBackground": hex(p.select),
        "editorCursor.foreground": hex(p.ink),
        "editorWhitespace.foreground": hex(p.line),
        "editorIndentGuide.background1": hex(p.line),
        "editorWidget.background": hex(p.panel),
        "editorWidget.foreground": hex(p.text),
        "editorWidget.border": hex(p.line),
        "editorHoverWidget.background": hex(p.panel),
        "editorHoverWidget.foreground": hex(p.text),
        "editorHoverWidget.border": hex(p.line),
        "editorSuggestWidget.background": hex(p.panel),
        "editorSuggestWidget.foreground": hex(p.text),
        "editorSuggestWidget.border": hex(p.line),
        "editorSuggestWidget.highlightForeground": hex(p.ink),
        "editorSuggestWidget.focusHighlightForeground": hex(p.ink),
        "editorSuggestWidget.selectedBackground": hex(p.select),
        "editorSuggestWidget.selectedForeground": hex(p.text),
        "list.hoverBackground": hex(p.highlight),
        "editorError.foreground": hex(p.error),
        "editorWarning.foreground": hex(p.warn),
        "editorMarkerNavigation.background": hex(p.panel),
        "editorLightBulb.foreground": hex(p.warn),
        "textLink.foreground": hex(p.ink),
        "textLink.activeForeground": hex(p.ink),
        "textCodeBlock.background": hex(p.sunk),
        focusBorder: hex(p.ink),
        "scrollbarSlider.background": `#${p.muted}40`,
        "scrollbarSlider.hoverBackground": `#${p.muted}66`,
        "scrollbarSlider.activeBackground": `#${p.ink}80`,
        "scrollbar.shadow": "#00000000",
        "widget.shadow": "#0000002e",
      },
    });
  }
}
