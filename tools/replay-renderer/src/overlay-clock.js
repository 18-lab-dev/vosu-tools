// Installed pages keep real WebSocket connections. The driver waits for their
// frame acknowledgement, drains fetch chains, then advances Chrome virtual time.
window.__vosuTime = 0;
window.__vosuEpoch = 0;
Date.now = () => window.__vosuEpoch + window.__vosuTime;
Object.defineProperty(performance, "now", { value: () => window.__vosuTime });
const nativeAnimationFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) =>
  nativeAnimationFrame(() => callback(window.__vosuTime));
const sockets = new Set(),
  waiters = [];
function notify() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (
      [...sockets].every(
        (socket) =>
          socket.readyState > 1 || socket.__vosuSequence >= waiters[i].sequence,
      )
    ) {
      waiters.splice(i, 1)[0].resolve();
    }
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
    if (new URL(url, location.href).pathname.startsWith("/websocket/v2")) {
      sockets.add(this);
      this.__vosuSequence = -1;
      this.addEventListener("message", (event) => {
        try {
          const value = JSON.parse(event.data);
          this.__vosuSequence = Array.isArray(value)
            ? value[1]
            : (value.__render?.sequence ?? -1);
        } catch {}
        notify();
      });
      this.addEventListener("close", notify);
    }
  }
};
window.__vosuWait = (sequence) =>
  new Promise((resolve) => {
    waiters.push({ sequence, resolve });
    notify();
  });
const pending = new Set(),
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
  pending.add(operation);
  operation.finally(() => pending.delete(operation)).catch(() => {});
  return operation;
};
window.__vosuIdle = async () => {
  for (let quiet = 0; quiet < 4; ) {
    if (pending.size) {
      await Promise.allSettled([...pending]);
      quiet = 0;
    } else {
      await Promise.resolve();
      quiet++;
    }
  }
  await document.fonts.ready;
};
