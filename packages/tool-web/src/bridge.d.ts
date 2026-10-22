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
  /** Resolves after a launch code (if any) is exchanged. */
  readonly ready: Promise<void>;
  readonly tool: ToolIdentity;
  /** True only in a tab opened from the dashboard; a reload is read-only. */
  readonly canWrite: boolean;
  readonly dashboardUrl: string;
  /**
   * The dashboard's colour mode when the tool was opened, else the system
   * preference. Tools choose their own theme; this is only a hint. Bridges
   * from before vosu 1.2.0 do not provide it.
   */
  readonly colorScheme?: "dark" | "light";
  /** Fetch relative to /tools/<id>/api/, adding the UI session header. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Selected-field /websocket/v2/subscribe helper; returns an unsubscribe
   * function. Bridges from vosu 1.2.0 reconnect with backoff and report the
   * connection through `onStatus`; older bridges ignore it and do not reconnect.
   */
  subscribe(
    fields: unknown,
    onFrame: (frame: unknown) => void,
    onStatus?: (state: "connecting" | "open" | "closed") => void,
  ): () => void;
  /**
   * Effective tool settings (defaults applied) from `GET /tools/<id>/_settings`.
   * Settings of type "password" are never included. Bridges from before this
   * route existed do not provide it; fall back to fetching the route directly.
   */
  settings?(): Promise<Record<string, unknown>>;
}

export declare const vosu: VosuBridge;
