// Installed pages keep real WebSocket connections to the private overlay
// server. After every published state the server ends each stream socket's
// frames with a sync marker (`__vosuSyncPrefix` + sequence) that this script
// consumes before any page listener sees it. The driver waits until every open
// stream socket has seen the frame's marker and every `getSettings` has its
// answer, drains fetch chains, then advances Chrome's virtual time.
window.__vosuTime = 0;
window.__vosuEpoch = 0;
const errors = [];
// Whether the page draws with WebGPU: full Chrome (a custom
// VOSU_RENDER_CHROMIUM) leaves WebGPU canvases out of its captures, and the
// render warns about it.
window.__vosuWebGpu = false;
for (const Canvas of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
  if (!Canvas) continue;
  const getContext = Canvas.prototype.getContext;
  Canvas.prototype.getContext = function (type, ...options) {
    const context = getContext.call(this, type, ...options);
    if (type === "webgpu" && context) window.__vosuWebGpu = true;
    return context;
  };
}
Date.now = () => window.__vosuEpoch + window.__vosuTime;
Object.defineProperty(performance, "now", { value: () => window.__vosuTime });
// Animation frames follow the export's frames: once the page has loaded, every
// callback requested before a frame runs exactly once at that frame, with the
// frame's time, after its data arrived and before it is captured (as a browser
// runs rAF between tasks and paint). Chrome's own frames (paced by virtual
// time and the compositor, several or none per export frame) never call page
// callbacks. While the page loads, before its first frame, Chrome's frames run
// them so pages that wait for a frame during startup still start.
const nativeAnimationFrame = window.requestAnimationFrame.bind(window);
let framesDriven = false;
const frameCallbacks = new Map();
let nextFrameCallback = 1;
window.requestAnimationFrame = (callback) => {
  const id = nextFrameCallback++;
  frameCallbacks.set(id, callback);
  if (!framesDriven)
    nativeAnimationFrame(() => {
      if (framesDriven || !frameCallbacks.delete(id)) return;
      callback(window.__vosuTime);
    });
  return id;
};
window.cancelAnimationFrame = (id) => {
  frameCallbacks.delete(id);
};
/**
 * Runs the animation frame callbacks requested so far, at the frame's time.
 * It also asks Chrome for a frame of its own: full headless Chrome produces
 * the next frame (which the capture waits for) only when something requested
 * one, and a page whose picture did not change requested none.
 */
window.__vosuAnimate = () => {
  framesDriven = true;
  const due = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of due) {
    try {
      callback(window.__vosuTime);
    } catch (error) {
      errors.push(String(error));
      queueMicrotask(() => {
        throw error;
      });
    }
  }
};
// Page timers run on the render clock too. Chrome's virtual time runs freely
// while a page loads (until its first frame), which would fire every retry
// and timeout at once; here a timer fires only once the clock reaches it,
// earliest first. A zero delay runs right after the current task.
const timers = new Map();
let nextTimer = 1;
function runTimers() {
  for (;;) {
    let next = null;
    for (const entry of timers) {
      const timer = entry[1];
      if (timer.due <= window.__vosuTime && (!next || timer.due < next[1].due || (timer.due === next[1].due && timer.order < next[1].order)))
        next = entry;
    }
    if (!next) return;
    const [id, timer] = next;
    if (timer.repeat) {
      timer.due += timer.repeat;
      timer.order = nextTimer++;
    } else timers.delete(id);
    try {
      timer.call(...timer.args);
    } catch (error) {
      errors.push(String(error));
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
function schedule(callback, delay, args, repeat) {
  const id = nextTimer++;
  const wait = Math.max(0, Number(delay) || 0);
  timers.set(id, {
    due: window.__vosuTime + wait,
    order: id,
    repeat: repeat ? Math.max(1, wait) : 0,
    call: typeof callback === "function" ? callback : () => (0, eval)(String(callback)),
    args,
  });
  if (wait === 0) queueMicrotask(runTimers);
  return id;
}
window.setTimeout = (callback, delay, ...args) => schedule(callback, delay, args, false);
window.setInterval = (callback, delay, ...args) => schedule(callback, delay, args, true);
window.clearTimeout = window.clearInterval = (id) => {
  timers.delete(id);
};
/** Moves the render clock to `time` and runs the timers it reached. */
window.__vosuAdvance = (time) => {
  window.__vosuTime = time;
  runTimers();
};
/** Server-pushed streams: each ends a published state with a sync marker. */
const STREAMS = new Set([
  "/ws",
  "/tokens",
  "/websocket/v2",
  "/websocket/v2/precise",
  "/websocket/v2/subscribe",
]);
const records = [],
  waiters = [];
addEventListener("error", (event) =>
  errors.push(String(event.message || event.error || "error")),
);
addEventListener("unhandledrejection", (event) =>
  errors.push(`unhandled rejection: ${event.reason}`),
);
/** Whether `record`'s socket owes nothing for state `sequence`. */
function settled(record, sequence) {
  const state = record.socket.readyState;
  if (state > 1) return true;
  if (record.stream) return record.sequence >= sequence;
  // A command socket is settled once each getSettings has been answered.
  return state === 1 && record.answered >= record.asked;
}
function notify() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (records.every((record) => settled(record, waiters[i].sequence)))
      waiters.splice(i, 1)[0].resolve();
  }
}
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url, protocols) {
    const endpoint = new URL(url, location.href);
    if (endpoint.host !== location.host)
      throw new Error(
        "Offline overlay WebSocket must use the synthetic render server",
      );
    super(url, protocols);
    const record = {
      path: endpoint.pathname,
      socket: this,
      stream: STREAMS.has(endpoint.pathname),
      commands: endpoint.pathname === "/websocket/commands",
      sequence: -1,
      sent: [],
      received: 0,
      asked: 0,
      answered: 0,
    };
    // Sockets the server does not answer (404) close; they are not waited on.
    if (record.stream || record.commands) records.push(record);
    const send = this.send.bind(this);
    this.send = (data) => {
      const text = String(data);
      // A socket still connecting throws: only commands that left count.
      send(data);
      if (record.sent.length < 4) record.sent.push(text.slice(0, 80));
      if (record.commands && text.startsWith("getSettings:")) record.asked++;
    };
    // Registered before any page listener, so the marker never reaches one.
    this.addEventListener("message", (event) => {
      if (
        typeof event.data === "string" &&
        event.data.startsWith(window.__vosuSyncPrefix)
      ) {
        event.stopImmediatePropagation();
        record.sequence = Number(
          event.data.slice(window.__vosuSyncPrefix.length),
        );
        notify();
        return;
      }
      record.received++;
      if (record.commands) {
        try {
          if (JSON.parse(event.data).command === "getSettings") record.answered++;
        } catch {}
      }
      // Answers settle after the page's own handlers ran on this event.
      queueMicrotask(notify);
    });
    this.addEventListener("open", notify);
    this.addEventListener("close", notify);
  }
};
window.__vosuWait = (sequence) =>
  new Promise((resolve) => {
    waiters.push({ sequence, resolve });
    notify();
  });
const pending = new Map(),
  nativeFetch = window.fetch.bind(window);
window.fetch = (...args) => {
  const endpoint = new URL(
    typeof args[0] === "string" || args[0] instanceof URL
      ? args[0]
      : args[0].url,
    location.href,
  );
  if (
    !["data:", "blob:"].includes(endpoint.protocol) &&
    endpoint.origin !== location.origin
  )
    return Promise.reject(
      new Error("Offline overlay fetch must use the synthetic render server"),
    );
  const operation = nativeFetch(...args).then(async (response) => {
    // Buffer before resolving so an awaited response.json() has no network tail.
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
  pending.set(operation, endpoint.pathname);
  operation.finally(() => pending.delete(operation)).catch(() => {});
  return operation;
};
window.__vosuIdle = async () => {
  for (let quiet = 0; quiet < 4; ) {
    if (pending.size) {
      await Promise.allSettled([...pending.keys()]);
      quiet = 0;
    } else {
      await Promise.resolve();
      quiet++;
    }
  }
  await document.fonts.ready;
};
/**
 * Loads every declared web font while the page loads (network still runs
 * there): a font first used mid-render would load while virtual time is
 * paused and never finish.
 */
window.__vosuPreloadFonts = () =>
  Promise.all([...document.fonts].map((font) => font.load().catch(() => undefined)));
/** What a page that stopped answering was waiting for, for the driver's error. */
window.__vosuDiagnose = () => ({
  sockets: records.map((record) => ({
    path: record.path,
    state: ["connecting", "open", "closing", "closed"][record.socket.readyState],
    sequence: record.sequence,
    sent: record.sent,
    received: record.received,
    asked: record.asked,
    answered: record.answered,
  })),
  fetches: [...pending.values()],
  fonts: document.fonts.status,
  errors: errors.slice(-3),
});
