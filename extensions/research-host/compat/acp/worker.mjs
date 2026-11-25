import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createRuntime, pathsFor, sessionId } from './runtime.mjs';
import { LineSplitter } from './acp-bridge/acp-connection.mjs';
import { privateDir, readJson, sameProcess } from '../../session-host/files.mjs';

const launchFile = process.argv[2];
const directory = privateDir(path.dirname(launchFile));
const launch = readJson(launchFile);
const id = sessionId(launch.id);
const files = pathsFor(directory, id);
if (launchFile !== files.launch || launch.schema !== 'pi-research-acp-launch.v1'
  || launch.socket !== path.join(directory, `${id}.sock`) || !/^[0-9a-f]{64}$/.test(launch.capability ?? '')) throw new Error('acp-worker-launch-invalid');
let active, ended = false, runtime;
const write = (socket, message) => {
  if (!socket || socket.destroyed) return;
  if (socket.writableLength > 8 * 1024 * 1024) { socket.destroy(); return; }
  socket.write(JSON.stringify(message) + '\n');
};
const diagnostic = line => process.stderr.write(line + '\n');

const server = net.createServer(socket => {
  const splitter = new LineSplitter(32 * 1024 * 1024);
  let authenticated = false, chain = Promise.resolve();
  const timer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5_000);
  timer.unref();
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(timer);
    if (active === socket) { active = undefined; runtime?.disconnected(); }
  });
  socket.on('data', chunk => {
    for (const line of splitter.push(chunk)) {
      chain = chain.then(async () => {
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || !Number.isSafeInteger(message.id)) { socket.destroy(); return; }
        try {
          if (!authenticated) {
            const supplied = Buffer.from(typeof message.capability === 'string' ? message.capability : '');
            const expected = Buffer.from(launch.capability);
            if (message.method !== 'attach' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
              socket.destroy(); return;
            }
            if (active && !active.destroyed) throw new Error('acp-worker-already-attached');
            authenticated = true; active = socket; clearTimeout(timer);
            write(socket, { id: message.id, result: runtime.getSession() });
            await runtime.reconnected();
            return;
          }
          let result;
          if (message.method === 'status') result = runtime.getSession();
          else if (message.method === 'send') result = runtime.receive(message.message);
          else if (message.method === 'update') result = runtime.updateSession(message.patch);
          else if (message.method === 'stop') result = await runtime.stop();
          else throw new Error('acp-worker-method-unsupported');
          write(socket, { id: message.id, result });
          if (message.method === 'stop') setTimeout(() => shutdown(), 25);
        } catch (error) { write(socket, { id: message.id, error: { code: error.code ?? error.message, message: error.message } }); }
      }).catch(error => { diagnostic(error.message); socket.destroy(); });
    }
    if (splitter.discarded) socket.destroy();
  });
});

async function shutdown() {
  if (ended) return;
  ended = true;
  try { await runtime?.stop(); }
  catch (error) { diagnostic(error.message); process.exitCode = 1; }
  if (active && !active.destroyed) await new Promise(resolve => active.end(resolve));
  server.close();
  try { fs.unlinkSync(launch.socket); } catch (error) { if (error.code !== 'ENOENT') diagnostic(error.message); }
  process.exit(process.exitCode ?? 0);
}

if (fs.existsSync(launch.socket)) {
  const previous = (() => { try { return readJson(files.status); } catch { return undefined; } })();
  if (previous && sameProcess(previous.worker)) throw new Error('acp-worker-already-live');
  const stat = fs.lstatSync(launch.socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('acp-worker-socket-unsafe');
  fs.unlinkSync(launch.socket);
}
runtime = createRuntime({ ...launch, directory, onMessage: message => write(active, { event: message }),
  onDiagnostic: diagnostic, onExit: () => { setTimeout(() => shutdown(), 150); } });
server.on('error', async error => { diagnostic(error.message); await runtime.stop(); process.exit(1); });
server.listen(launch.socket, () => {
  fs.chmodSync(launch.socket, 0o600);
  runtime.start().catch(async error => { diagnostic(error.message); await shutdown(); });
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { shutdown().catch(() => process.exit(1)); });
