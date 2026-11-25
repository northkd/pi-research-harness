class RpcTimeoutError extends Error {
  constructor(method, ms) {
    super(`ACP request ${method} timed out after ${ms} ms`);
    this.name = "RpcTimeoutError";
  }
}
class RpcError extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
class LineSplitter {
  parts = [];
  len = 0;
  discarding = false;
  discarded = 0;
  maxLineBytes;
  constructor(maxLineBytes) {
    this.maxLineBytes = maxLineBytes;
  }
  /** Feed a chunk; returns complete lines (UTF-8, without the newline). */
  push(chunk) {
    const lines = [];
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl < 0 ? chunk.length : nl;
      this.append(chunk.subarray(start, end));
      if (nl < 0) break;
      if (this.discarding) {
        this.discarding = false;
        this.discarded += 1;
      } else lines.push(this.take());
      this.parts = [];
      this.len = 0;
      start = nl + 1;
    }
    return lines;
  }
  append(slice) {
    if (this.discarding || slice.length === 0) return;
    if (this.len + slice.length > this.maxLineBytes) {
      this.discarding = true;
      this.parts = [];
      this.len = 0;
      return;
    }
    this.parts.push(slice);
    this.len += slice.length;
  }
  take() {
    return Buffer.concat(this.parts, this.len).toString("utf8");
  }
}
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function createAcpConnection(o) {
  const splitter = new LineSplitter(o.maxLineBytes);
  const pending = /* @__PURE__ */ new Map();
  let nextId = 1;
  let closed = false;
  let skipped = 0;
  const write = (obj) => {
    if (closed || o.output.destroyed || !o.output.writable) return;
    o.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...obj })}
`);
  };
  async function handleRequest(id, method, params) {
    const handler = o.requestHandlers?.[method];
    if (!handler || !Object.hasOwn(o.requestHandlers ?? {}, method)) {
      write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      write({ id, result: await handler(params) ?? null });
    } catch (err) {
      write({ id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
  function handleResponse(msg) {
    const id = msg.id;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (isRec(msg.error)) {
      const e = msg.error;
      p.reject(new RpcError(typeof e.code === "number" ? e.code : -32e3, typeof e.message === "string" ? e.message : "error", e.data));
    } else p.resolve(msg.result);
  }
  function dispatch(msg) {
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";
    if (typeof msg.method === "string") {
      if (hasId) handleRequest(msg.id, msg.method, msg.params).catch(() => {
      });
      else o.onNotification?.(msg.method, msg.params);
    } else if (hasId) handleResponse(msg);
    else skipped += 1;
  }
  function onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      return;
    }
    if (!isRec(parsed)) {
      skipped += 1;
      return;
    }
    dispatch(parsed);
  }
  o.input.on("data", (chunk) => {
    if (closed) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const line of splitter.push(buf)) onLine(line);
  });
  const ended = () => {
    if (closed) return;
    o.onClose?.();
  };
  o.input.on("end", ended);
  o.input.on("close", ended);
  return {
    request(method, params, timeoutMs = o.requestTimeoutMs) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("ACP connection closed"));
          return;
        }
        const id = nextId++;
        const entry = { resolve, reject, method };
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new RpcTimeoutError(method, timeoutMs));
          }, timeoutMs);
        }
        pending.set(id, entry);
        write({ id, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    counters: () => ({ skippedLines: skipped, discardedLines: splitter.discarded }),
    close(reason) {
      if (closed) return;
      closed = true;
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(reason);
      }
      pending.clear();
    }
  };
}
export {
  LineSplitter,
  createAcpConnection
};
