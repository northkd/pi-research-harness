#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createIdleStageReviewer, validateConfig } from '../src/idle-stage-review.mjs';
import { readVerified } from '../src/workbench-sync.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw Error('usage: run-stage-review.mjs --config ABSOLUTE_PATH');

const stat = fs.lstatSync(args[1]);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw Error('private-config-required');

let raw;
try { raw = JSON.parse(readVerified(args[1], 64 * 1024)); } catch { throw Error('private-config-invalid'); }
const config = validateConfig(raw);

if (!config.enabled) {
  process.stdout.write('[idle-stage-review] disabled by configuration\n');
  process.exit(0);
}

const reviewer = createIdleStageReviewer({
  config,
  onEvent: event => {
    if (event.event === 'error' || event.event === 'aborted' || event.event === 'stage-record-error') {
      process.stderr.write('[idle-stage-review] ' + event.event + ' ' + (event.reason ?? event.code ?? 'unknown') + '\n');
    }
  },
});

let closing = false;
let timer;
const close = () => {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  reviewer.close();
  process.exit(0);
};

process.on('SIGTERM', close);
process.on('SIGINT', close);
process.on('exit', () => reviewer.close());

await reviewer.tick().catch(error => process.stderr.write('[idle-stage-review] tick-error ' + (error?.code ?? 'unknown') + '\n'));
timer = setInterval(() => {
  if (closing) return;
  void reviewer.tick().catch(error => process.stderr.write('[idle-stage-review] tick-error ' + (error?.code ?? 'unknown') + '\n'));
}, config.tickIntervalMs);
process.stdout.write('[idle-stage-review] started\n');
