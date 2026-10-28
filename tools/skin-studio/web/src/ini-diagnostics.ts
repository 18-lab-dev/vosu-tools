import { validate } from "@vosu-tools/skin-spec";
import type { TextDoc } from "./text-doc";

export interface ValidationClock {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

interface Request {
  text: string;
  files: string[] | undefined;
  timer?: number;
}

/** Keep whole-file checks off the typing path; reuse results until text or files change. */
export class IniDiagnostics {
  #requests = new WeakMap<TextDoc, Request>();

  constructor(
    private readonly publish: (doc: TextDoc) => void,
    private readonly check: typeof validate = validate,
    private readonly clock: ValidationClock = window,
    private readonly delay = 200,
  ) {}

  /** Returns whether the document's diagnostics match its current text and files. */
  schedule(doc: TextDoc): boolean {
    const text = doc.getValue(), files = doc.files;
    const previous = this.#requests.get(doc);
    if (previous?.text === text && previous.files === files) return previous.timer === undefined;
    if (previous?.timer !== undefined) this.clock.clearTimeout(previous.timer);
    const request: Request = { text, files };
    this.#requests.set(doc, request);
    request.timer = this.clock.setTimeout(() => {
      if (this.#requests.get(doc) !== request) return;
      request.timer = undefined;
      // A hidden document may change without requesting another check.
      if (doc.getValue() !== text || doc.files !== files) {
        this.#requests.delete(doc);
        return;
      }
      doc.issues = this.check(text, files);
      this.publish(doc);
    }, this.delay);
    return false;
  }
}
