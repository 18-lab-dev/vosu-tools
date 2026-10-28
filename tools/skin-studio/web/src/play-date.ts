/**
 * When the last play was, from stable epoch milliseconds or lazer ISO UTC
 * text: `relative` for the label (`10 min ago`, `5 h 3 min ago`, `23 days
 * ago` from 48 h on), `absolute` for its title. `stale`: an hour old or
 * older than a play seen before (`newest`), or without a date.
 */
export function playDate(value: number | string, newest = 0, now = Date.now()) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return { timestamp: 0, stale: true, relative: "date unavailable", absolute: "" };
  const age = now - timestamp;
  const minutes = Math.floor(Math.abs(age) / 60000);
  const span =
    minutes >= 48 * 60
      ? `${Math.floor(minutes / 1440)} days`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
        : `${minutes} min`;
  const relative = minutes < 1 ? "just now" : `${span} ${age >= 0 ? "ago" : "from now"}`;
  const stale = age >= 3600000 || timestamp < newest;
  const absolute = new Date(timestamp).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
  return { timestamp, stale, relative, absolute };
}
