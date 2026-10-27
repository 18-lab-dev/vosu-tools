/** Last-play dates are stable epoch milliseconds or lazer ISO UTC text. */
export function playDate(value: number | string, newest = 0, now = Date.now()) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return { timestamp: 0, stale: true, text: "Played: date unavailable — check that this is your latest completed play." };
  const age = now - timestamp;
  const minutes = Math.floor(Math.abs(age) / 60000);
  const relative = minutes < 1 ? "just now" : `${minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`} ${age >= 0 ? "ago" : "from now"}`;
  const stale = age >= 3600000 || timestamp < newest;
  const absolute = new Date(timestamp).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
  return { timestamp, stale, text: `Played ${relative} · ${absolute}${stale ? " — Older play: only completed, saved mania scores with replays are available; this may not be your latest attempt." : ""}` };
}
