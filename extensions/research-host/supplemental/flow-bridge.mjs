import { configurePluginRequester } from './bridge-request.mjs';
import { startFlowFilesReporter } from './flows/bridge/flow-files-reporter.js';
import { probeFlowRuntime } from './flow-control.mjs';

/** Register once inside the native Pi process using the host's private lane. */
export function registerFlowBridge(pi, { requestPlugin, emitSnapshot }) {
  if (!pi?.events || typeof requestPlugin !== 'function' || typeof emitSnapshot !== 'function') throw new Error('flow-bridge-host-required');
  configurePluginRequester(requestPlugin);
  startFlowFilesReporter(pi);
  const report = async () => {
    const probe = await probeFlowRuntime(pi.events);
    emitSnapshot({ type: 'flows_list', flows: probe.flows, runtimeAvailable: probe.available });
    emitSnapshot({ type: 'commands_list', commands: pi.getCommands?.() || [] });
  };
  pi.on('session_start', report);
  for (const name of ['flow:rediscover', 'flow:register-flows-dir', 'flow:unregister-flows-dir']) pi.events.on(name, report);
  const forwards = {
    'flow:flow-started': 'flow_started', 'flow:agent-started': 'flow_agent_started',
    'flow:agent-complete': 'flow_agent_complete', 'flow:agent-error': 'flow_agent_error',
    'flow:subagent-tool-call': 'flow_tool_call', 'flow:subagent-tool-result': 'flow_tool_result',
    'flow:assistant-text': 'flow_assistant_text', 'flow:thinking-text': 'flow_thinking_text',
    'flow:loop-iteration': 'flow_loop_iteration', 'flow:auto-decision': 'flow_auto_decision',
    'flow:complete': 'flow_complete', 'flow:summary-started': 'flow_summary_started',
    'flow:summary-ready': 'flow_summary_ready', 'flow:summary-dismissed': 'flow_summary_dismissed',
    'flow:autonomous-mode-changed': 'flow_autonomous_changed',
  };
  for (const [source, target] of Object.entries(forwards)) pi.events.on(source, data => emitSnapshot({ eventType: target, data }));
  for (const name of ['flows-anthropic-bridge:status', 'flows-anthropic-bridge:agent-active']) pi.events.on(name, data => emitSnapshot({ eventType: name, data }));
}
