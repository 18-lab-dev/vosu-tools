// Write access. vosu gives a tab a write session only when the dashboard
// opens it with a one-time launch code; the session lives in that page's
// memory and in vosu's, so a reload, a restored tab, an expired launch code
// or a vosu restart (an update, say) leaves the tab read-only. Drafts are
// kept in this browser and never need a session; applying, exporting,
// dropping files and saving do.
import { vosu } from "/tools/_host/v1/bridge.js";

let lost = false;
const listeners = new Set<() => void>();

export const canWrite = () => vosu.canWrite && !lost;

/** The dashboard's Tools page, where "Open" starts a tab with a session. */
export const dashboardTools = () => new URL("tools", vosu.dashboardUrl).href;

/** Why this tab cannot write, in one line. */
export const readOnlyReason = () =>
  lost
    ? "vosu restarted and forgot this tab's session"
    : "this tab was not opened from the dashboard (or was reloaded)";

/** vosu refused a write for want of a session: switch the page to read-only. */
export function sessionLost() {
  if (lost) return;
  lost = true;
  for (const listener of listeners) listener();
}
export const onSessionChange = (listener: () => void) => listeners.add(listener);

/** Whether a failed response is vosu refusing a write without a session. */
export const isSessionRefusal = (status: number, text: string) =>
  status === 403 && /tool UI session/i.test(text);
