// Synthetic real-component layout fixture. Never connects to a dashboard/session or model.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '@dashboard/components/chat/ChatView.js';
import { ThemeProvider } from '@dashboard/components/settings/ThemeProvider.js';
import { NativeSubagents } from '@dashboard/components/split/NativeSubagents.js';
import { createInitialState } from '@dashboard/lib/chat/event-reducer.js';
import { PluginContextProvider } from '@blackbelt-technology/dashboard-plugin-runtime/context';
import { publishSessionEvents } from '@dashboard-runtime/session-events-store.js';
import '@dashboard/index.css';

const long = 'unbroken_identifier_'.repeat(32);
const description = `本机合成任务说明，仅测试换行，不含私人科研。 ${long.slice(0, 200)} /synthetic/${'nested/path/'.repeat(8)}input.txt\n${'下一行合成说明仍须可见。\n'.repeat(10)}`;
const now = Date.now();
publishSessionEvents('layout-fixture', [{ id: 'synthetic-snapshot', sessionId: 'layout-fixture', timestamp: now,
  eventType: 'native_subagents_snapshot', data: { available: true, snapshot: { generatedAt: now, runs: [{
    id: '11111111-1111-4111-8111-111111111111', kind: 'workflow', state: 'running', label: '合成工作流',
    children: [{ id: 'synthetic-agent', kind: 'subagent', label: '合成任务', description, state: 'running', model: 'fixture/model-with-a-long-name:high', tokens: { total: 12345 } }],
  }] } } }]);
const variant = new URLSearchParams(location.search).get('variant') || 'assistant';
const state = createInitialState();
const text = `# 合成长文本回归\n\n正文 ${long}\n\n[https://example.invalid/${long}](https://example.invalid/${long})\n\n行内路径 \`/synthetic/${long}.txt\`\n\n`;
const code = `\n\n\`\`\`python\nprint('${long}')\n\`\`\`\n\n`;
const table = `\n\n| ${'wide-column | '.repeat(36)}\n| ${'--- | '.repeat(36)}\n| ${'synthetic | '.repeat(36)}\n`;
if (variant === 'stream') { state.streamingText = text + code + table; state.isStreaming = true; state.status = 'streaming'; }
else if (variant === 'pending') state.pendingPrompt = { text, status: 'sending' } as typeof state.pendingPrompt;
else if (variant === 'steering') { /* Rendered by its own ChatView prop below. */ }
else state.messages = [{ id: 'synthetic-message', role: variant === 'user' ? 'user' : 'assistant', content: new URLSearchParams(location.search).has('short') ? '短消息，完整显示。' : text + code + table, timestamp: now }];

function Fixture() {
  const [liveState, setLiveState] = useState(state);
  useEffect(() => {
    const update = () => setLiveState(previous => ({ ...previous, streamingText: previous.streamingText + ' synthetic-stream-update' }));
    window.addEventListener('fixture-stream-update', update);
    return () => window.removeEventListener('fixture-stream-update', update);
  }, []);
  return <ThemeProvider><PluginContextProvider connectionStatus="connected">
    <main style={{ display: 'flex', minWidth: 0, flexDirection: 'column', height: '100vh', padding: 12 }}>
      <h1 style={{ fontSize: 16 }}>Synthetic overflow regression · no private session</h1>
      {variant === 'subagents' ? <section aria-label="Subagents" style={{ minWidth: 0 }}><NativeSubagents sessionId="layout-fixture" /></section>
      : <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
          <ChatView sessionId="synthetic-chat" state={liveState} toolContext={{}} pendingSteering={variant === 'steering' ? [text] : undefined} />
        </div>}
    </main>
  </PluginContextProvider></ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
