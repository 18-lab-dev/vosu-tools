// Types for the browser bridge vosu serves at /tools/_host/v1/bridge.js
// (docs/tools/protocol.md in the vosu repository). The module is provided by
// the host at runtime and is never bundled; tool tsconfigs map the URL here
// through `paths` (see tsconfig.tool.json).

export interface ToolIdentity {
  id: string;
  name: string;
  version: string;
}

export interface VosuBridge {
  /** Resolves after a launch code (if any) is exchanged and data-theme is applied. */
  readonly ready: Promise<void>;
  readonly tool: ToolIdentity;
  /** True only in a tab opened from the dashboard; a reload is read-only. */
  readonly canWrite: boolean;
  readonly dashboardUrl: string;
  /** Fetch relative to /tools/<id>/api/, adding the UI session header. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Selected-field /websocket/v2/subscribe helper; returns an unsubscribe function. */
  subscribe(fields: unknown, onFrame: (frame: unknown) => void): () => void;
}

export declare const vosu: VosuBridge;
