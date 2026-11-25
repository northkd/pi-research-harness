import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(import.meta.url);

export function createWorkbenchSyncProcess({ moduleFile, options, refreshNativeRoots, onDiagnostic }) {
  let child, ready, running, closing = false;
  let heartbeats = [];

  function requestTick() {
    if (!ready || running || closing) return;
    running = true;
    child.send({ type: 'tick', nativeRoots: refreshNativeRoots?.() }, error => {
      if (!error) return;
      running = false;
      if (!closing) onDiagnostic('workbench-sync-worker-unavailable');
    });
  }

  function start() {
    const subprocess = fork(entry, [], { execArgv: ['--max-old-space-size=256'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child = subprocess;
    ready = false;
    running = false;
    subprocess.on('message', message => {
      if (child !== subprocess) return;
      if (message.type === 'ready') { ready = true; requestTick(); }
      if (message.type === 'settled') {
        running = false;
        heartbeats = message.heartbeats;
      }
      if (message.type === 'diagnostic') onDiagnostic(message.code);
    });
    subprocess.once('exit', () => {
      if (child !== subprocess) return;
      child = undefined;
      ready = false;
      running = false;
      if (!closing) onDiagnostic('workbench-sync-worker-exited');
    });
    subprocess.on('error', () => { if (!closing) onDiagnostic('workbench-sync-worker-unavailable'); });
    subprocess.send({ type: 'configure', moduleFile, options }, error => {
      if (error && !closing) onDiagnostic('workbench-sync-worker-unavailable');
    });
  }

  return {
    heartbeat({ cwd, adoptionId, charterHash }) {
      const matching = heartbeats.filter(row => row.cwd === cwd && row.adoptionId === adoptionId && row.charterHash === charterHash);
      return matching.length === 1 ? matching[0].heartbeatAt : undefined;
    },
    tick() {
      if (closing) return;
      if (!child?.connected) start();
      else requestTick();
    },
    async close() {
      closing = true;
      const subprocess = child;
      if (!subprocess || subprocess.exitCode !== null || subprocess.signalCode !== null) return;
      const exited = once(subprocess, 'exit');
      const timeout = setTimeout(() => subprocess.kill('SIGKILL'), 8000);
      timeout.unref();
      if (subprocess.connected) subprocess.send({ type: 'close' }, () => {});
      try { await exited; }
      finally { clearTimeout(timeout); }
    },
  };
}

if (process.argv[1] === entry) {
  let collector;
  let nativeRoots;
  function close() {
    collector?.close();
    collector = undefined;
    if (process.connected) process.disconnect();
  }
  function send(message) { if (process.connected) process.send(message, () => {}); }
  const diagnostic = code => send({ type: 'diagnostic', code });
  process.on('disconnect', close);
  process.on('message', async message => {
    if (message.type === 'close') { close(); return; }
    if (message.type === 'configure') {
      try {
        const { createWorkbenchSyncCollector } = await import(pathToFileURL(message.moduleFile).href);
        if (!process.connected) return;
        nativeRoots = message.options.nativeRoots;
        collector = createWorkbenchSyncCollector({ ...message.options, refreshNativeRoots: () => nativeRoots, onError: diagnostic });
        send({ type: 'ready' });
      } catch {
        diagnostic('workbench-sync-worker-start-unavailable');
        close();
      }
      return;
    }
    if (message.type !== 'tick' || !collector) return;
    if (message.nativeRoots) nativeRoots = message.nativeRoots;
    try { await collector.tick(); }
    catch { diagnostic('workbench-sync-tick-unavailable'); }
    finally { send({ type: 'settled', heartbeats: collector?.heartbeats() ?? [] }); }
  });
}
