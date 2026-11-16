/**
 * Install-time patch adapter shared by foreground and detached native children.
 * Ordinary pi-subagents installations stay unchanged. In Pi Research the
 * configured host module must exist: errors never fall back to an unbounded run.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createResearchScheduledChild(launch, create, metadata = {}, options = {}) {
  const root = (options.env ?? process.env).PI_RESEARCH_LOOP_ROOT;
  if (!root) return create();
  if (!path.isAbsolute(root)) throw new Error('research-subagent-scheduler-path-invalid');
  const load = options.load ?? (url => import(url));
  const bridge = await load(pathToFileURL(path.join(root, 'src', 'subagent-scheduling.mjs')).href);
  if (typeof bridge.scheduleResearchSubagent !== 'function') throw new Error('research-subagent-scheduler-unavailable');
  return bridge.scheduleResearchSubagent(launch, create, metadata);
}
