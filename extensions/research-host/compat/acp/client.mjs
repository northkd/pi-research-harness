import net from 'node:net';
import { LineSplitter } from './acp-bridge/acp-connection.mjs';

/** No retries of commands: a lost response has unknown delivery, never a resend. */
export async function connectWorker(launch, options = {}) {
  const pending = new Map();
  const splitter = new LineSplitter(32 * 1024 * 1024);
  const socket = net.createConnection(launch.socket);
  let nextId = 1, closed = false;
  const rejectAll = error => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    options.onClose?.(error);
  };
  socket.on('error', error => rejectAll(error));
  socket.on('close', () => rejectAll(Object.assign(new Error('acp-worker-disconnected'), { delivery: 'unknown' })));
  socket.on('data', chunk => {
    for (const line of splitter.push(chunk)) {
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (message.event) { options.onMessage?.(message.event); continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else request.resolve(message.result);
    }
    if (splitter.discarded) socket.destroy();
  });
  function request(method, extra = {}) {
    return new Promise((resolve, reject) => {
      if (closed || socket.destroyed) { reject(new Error('acp-worker-disconnected')); return; }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('acp-worker-request-timeout'), { delivery: 'unknown' }));
      }, options.timeoutMs ?? 10_000);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, method, ...extra }) + '\n');
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('acp-worker-connect-timeout')); }, 5_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const session = await request('attach', { capability: launch.capability });
    return { session, request, close: () => socket.destroy(), get closed() { return closed; } };
  } catch (error) { socket.destroy(); throw error; }
}
