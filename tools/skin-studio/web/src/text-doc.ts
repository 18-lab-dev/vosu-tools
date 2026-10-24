// skin.ini text held outside the editor, so the studio works before (and
// without) Monaco loading. The editor, once loaded, mirrors each document in
// a model; text is normalised the way a Monaco model normalises it, so the
// two always agree and dirty checks do not change when the editor arrives.

import type { Diagnostic } from "@vosu-tools/skin-spec";

/**
 * Line endings and BOM as a Monaco text model stores them: one end-of-line
 * style (CRLF when more than half the breaks contain CR, else LF) and no
 * leading BOM.
 */
export function normaliseText(text: string): string {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const crlf = body.match(/\r\n/g)?.length ?? 0;
  const cr = (body.match(/\r/g)?.length ?? 0) - crlf;
  const lf = (body.match(/\n/g)?.length ?? 0) - crlf;
  const total = crlf + cr + lf;
  if (!total) return body;
  const eol = cr + crlf > total / 2 ? "\r\n" : "\n";
  if ((eol === "\r\n" && !cr && !lf) || (eol === "\n" && !cr && !crlf))
    return body;
  return body.replace(/\r\n|\r|\n/g, eol);
}

export class TextDoc {
  #text = "";
  #listeners = new Set<() => void>();
  /** Skin files for image checks; undefined skips them (hashed lazer stores). */
  files: string[] | undefined;
  /** Diagnostics of the last check (quick fixes read them). */
  issues: Diagnostic[] = [];

  getValue() {
    return this.#text;
  }
  /** Replaces the text (normalised); listeners run when it changed. */
  setValue(text: string) {
    const next = normaliseText(text);
    if (next === this.#text) return;
    this.#text = next;
    for (const listener of this.#listeners) listener();
  }
  onDidChangeContent(listener: () => void) {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }
}

/** `r,g,b[,a]` with every channel in 0–255, else null. */
export function rgb(value: string | undefined) {
  const c = (value ?? "").split(",").map(Number);
  return c.length >= 3 &&
    c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)
    ? c
    : null;
}
