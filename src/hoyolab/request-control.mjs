import { setTimeout as delay } from "node:timers/promises";

// Bound work per process; deployments with multiple workers also need a shared gateway limit.
export function createRequestGate({ concurrency = 4, maxQueue = 24 } = {}) {
  let active = 0;
  const queue = [];
  function release() {
    active -= 1;
    while (queue.length) {
      const item = queue.shift();
      item.signal?.removeEventListener("abort", item.abort);
      if (item.signal?.aborted) continue;
      active += 1;
      item.resolve(release);
      break;
    }
  }
  return async function acquire(signal) {
    signal?.throwIfAborted();
    if (active < concurrency) {
      active += 1;
      return release;
    }
    if (queue.length >= maxQueue) throw new Error("REQUEST_QUEUE_FULL");
    return new Promise((resolve, reject) => {
      const item = { resolve, signal, abort: () => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      } };
      signal?.addEventListener("abort", item.abort, { once: true });
      queue.push(item);
    });
  };
}

export async function abortableDelay(ms, signal) {
  if (ms > 0) await delay(ms, undefined, { signal });
  signal?.throwIfAborted();
}

// Cleanup must not hide a size/timeout error or hold the request slot indefinitely.
function cancelBody(body) {
  try { void Promise.resolve(body?.cancel?.()).catch(() => {}); }
  catch { /* The original limit or cancellation error remains authoritative. */ }
}

export async function readBoundedResponse(response, maxBytes, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (declared > maxBytes) {
    cancelBody(response.body);
    throw new Error("RESPONSE_TOO_LARGE");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    signal?.throwIfAborted();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const onAbort = () => cancelBody(reader);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        cancelBody(reader);
        throw new Error("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
