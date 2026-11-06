(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.install(global);
})(globalThis, function () {
  'use strict';

  const DEMO_ID = 'DEMO-adoption';
  const readOnlySocketTypes = new Set([
    'subscribe', 'unsubscribe', 'request_commands', 'fetch_content', 'list_files',
    'openspec_get', 'sessions_page', 'request_models', 'request_providers',
    'list_sessions', 'watch_files', 'prompt_resync_request', 'history_backfill',
    'worktree_init_subscribe', 'worktree_init_unsubscribe', 'ping',
  ]);

  function isAllowedSocketMessage(message) {
    if (typeof message !== 'string') return false;
    try {
      const parsed = JSON.parse(message);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof parsed.type === 'string' && readOnlySocketTypes.has(parsed.type);
    } catch { return false; }
  }

  function simulatedSocketReply(message) {
    if (typeof message !== 'string') return null;
    try {
      const parsed = JSON.parse(message);
      if (parsed?.type === 'send_prompt' && typeof parsed.sessionId === 'string') {
        return { type: 'prompt_received', sessionId: parsed.sessionId, fresh: false };
      }
      if (parsed?.type === 'spawn_session' && typeof parsed.cwd === 'string') {
        return { type: 'spawn_result', cwd: parsed.cwd, requestId: parsed.requestId, success: false, message: '【模拟】没有创建真实会话，也没有调用模型。' };
      }
    } catch { /* unrecognized messages remain blocked */ }
    return null;
  }

  function rewriteStageFeedback(value) {
    if (typeof value === 'string' && value.includes('已成功为「') && value.includes('创建新会话')) {
      return '【模拟】已推进一个演示阶段；没有创建真实会话，也没有调用模型。';
    }
    return value;
  }

  function selectDemoPath(sessions, cwd, preferred, folderSegment) {
    const available = (Array.isArray(sessions) ? sessions : []).filter((row) =>
      row && row.cwd === cwd && typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.id)
      && !['ended', 'stopped', 'archived', 'error'].includes(row.status));
    const selected = available.find((row) => row.id === preferred) ?? available[0];
    return selected ? `/session/${selected.id}` : `/folder/${folderSegment}/research`;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return 'sha256:' + Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
  }

  async function makeObservation(cwd, charter, tick) {
    const now = new Date().toISOString();
    const parentSpecs = [
      ['DEMO:main', 'demo-main', '【模拟】主控 Agent：拆解科研目标、分派任务并汇总结果。'],
      ['DEMO:literature', 'demo-literature', '【模拟】Multi-Agent ①：梳理文献与候选思路。'],
      ['DEMO:experiment', 'demo-experiment', '【模拟】Multi-Agent ②：设计合成实验并解释结果。'],
      ['DEMO:review', 'demo-review', '【模拟】Multi-Agent ③：组织反例、评审和主张核对。'],
    ];
    const childSpecs = [
      ['DEMO:sub1', 'DEMO:main', 'research-mainline-supervisor', '【模拟】检查研究目标和阶段依赖。'],
      ['DEMO:sub2', 'DEMO:main', 'research-theory', '【模拟】列出假设与适用条件。'],
      ['DEMO:sub3', 'DEMO:literature', 'research-literature', '【模拟】整理虚构文献线索。'],
      ['DEMO:sub4', 'DEMO:literature', 'research-literature', '【模拟】独立核对另一组虚构文献，演示同角色叠放与铺开。'],
      ['DEMO:sub5', 'DEMO:experiment', 'research-numerics', '【模拟】检查人工生成的数据表。'],
      ['DEMO:sub6', 'DEMO:experiment', 'research-numerics', '【模拟】独立检查另一组合成指标，演示同角色叠放与铺开。'],
      ['DEMO:sub7', 'DEMO:review', 'research-critic', '【模拟】寻找反例并提出待核验问题。'],
      ['DEMO:sub8', 'DEMO:review', 'research-writer', '【模拟】整理主张与证据摘要。'],
    ];
    const active = Math.max(0, Math.min(8, Number(tick) || 0));
    // Explicit synthetic lineage: the experiment collaborator creates the
    // review collaborator. These records demonstrate nesting, never real runs.
    const parentIds = { 'DEMO:literature': 'DEMO:main', 'DEMO:experiment': 'DEMO:main', 'DEMO:review': 'DEMO:experiment' };
    const parents = parentSpecs.map(([id, role, prompt], index) => ({
      id, kind: 'pi-session', role, status: index === 0 ? 'idle' : (active >= index * 2 ? 'completed' : 'waiting'),
      ...(parentIds[id] ? { parentExecutionId: parentIds[id] } : {}),
      prompt, output: '【模拟】这是预设的展示内容，没有实际模型调用。', observedModel: 'DEMO/本地模拟（未调用）',
      startedAt: now, lastActivityAt: now,
    }));
    const children = childSpecs.map(([id, parentExecutionId, role, prompt], index) => ({
      id, kind: 'native-subagent', parentExecutionId, role,
      ...(index >= 5 ? { stage: '3-review' } : {}),
      status: index < active ? 'completed' : index === active && active < 8 ? 'running' : 'queued',
      prompt, output: '【模拟】任务结果为预设示例，不代表真实科研执行。', observedModel: 'DEMO/本地模拟（未调用）',
      startedAt: now, lastActivityAt: now,
    }));
    const relations = children.map((child, index) => ({
      id: `DEMO:edge-${index + 1}`, fromExecutionId: child.parentExecutionId, toExecutionId: child.id,
      kind: 'dispatch', evidence: { source: 'explicit-record', eventId: `DEMO:dispatch-${index + 1}` },
    })).concat(parents.filter(parent => parent.parentExecutionId).map((parent, index) => ({
      id: `DEMO:collaborator-edge-${index + 1}`, fromExecutionId: parent.parentExecutionId, toExecutionId: parent.id,
      kind: 'dispatch', evidence: { source: 'explicit-record', eventId: `DEMO:collaborator-dispatch-${index + 1}` },
    })));
    return {
      schema: 'res-workflow.workbench-observation.v1', cwd, adoptionId: DEMO_ID,
      charterHash: await sha256(JSON.stringify(charter)), revision: 'sha256:' + 'd'.repeat(64),
      updatedAt: now, heartbeatAt: now,
      coverage: { partial: true, reasons: ['【模拟】所有会话与派发均为本地预设，不是真实观测。'], parentSessions: 4, nativeRuns: 8 },
      executions: [...parents, ...children], relations,
      observedUsage: { responses: 0, inputTokens: 0, outputTokens: 0, inheritedExcluded: 0, metric: 'observed-assistant-responses' },
    };
  }

  function createDemoRuntime({ cwd, origin, upstream, notify, refresh = () => {} }) {
    const initialGoals = () => {
      const now = Date.now();
      return [
        { id: 'DEMO-G1', cwd, objective: '【模拟】完成样例研究的文献与实验梳理', status: 'paused', criteria: [{ text: '【模拟】整理文献线索', done: true }, { text: '【模拟】核对合成数据', done: false }], budget: { maxTurns: 12 }, autoRespawn: false, sessionIds: [], createdAt: now, updatedAt: now },
        { id: 'DEMO-G2', cwd, objective: '【模拟】建立可查看的主张与证据链', status: 'achieved', criteria: [{ text: '【模拟】登记三条示例主张', done: true }], budget: { maxTurns: 6 }, autoRespawn: false, sessionIds: [], createdAt: now, updatedAt: now },
      ];
    };
    const state = { tick: 0, charter: null, budget: { attempts: 24, modelRequests: 12 }, revision: 1, goals: initialGoals(), accessMode: null, prompts: [] };
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    const budget = () => ({ cwd, revision: `DEMO-${state.revision}`, limits: { ...state.budget }, usage: { attempts: 7, modelRequests: 0, inFlight: 0, unknown: 0 }, updatedAt: new Date().toISOString(), enforcement: { attempts: false, modelRequests: false, scope: 'native-research-workflow', physicalTransport: 'sse-http' } });
    const accessMode = () => ({ cwd, mode: 'default', revision: null, updatedAt: null,
      inheritance: 'workspace-sessions', ...(state.accessMode ?? {}) });
    const sessions = [
      ['DEMO:main', '【模拟】主控 Agent'], ['DEMO:literature', '【模拟】文献协作 Agent'],
      ['DEMO:experiment', '【模拟】实验协作 Agent'], ['DEMO:review', '【模拟】评审协作 Agent'],
    ].map(([id, name]) => ({ id, name, cwd, status: 'idle', driver: 'pi', model: 'DEMO/本地模拟（未调用）' }));
    const fakeSnapshot = async (response) => {
      if (!response.ok) return response;
      const data = await response.clone().json();
      if (data.cwd !== cwd || typeof data.research?.['state.json'] !== 'string') return response;
      const parsed = JSON.parse(data.research['state.json']);
      if (!parsed?.charter || !String(parsed.charter.objective ?? '').includes('演示')) return response;
      state.charter = parsed.charter;
      if (typeof data.research['events.jsonl'] === 'string') {
        data.research['events.jsonl'] = data.research['events.jsonl'].split('\n').filter((line) => {
          if (!line.trim()) return false;
          try { const event = JSON.parse(line); return !(event.kind === 'run-step' && event.detail?.stage === '3-review' && event.detail?.simulation === true); }
          catch { return true; }
        }).join('\n');
      }
      const now = new Date().toISOString();
      data.adopted = true;
      data.adoption = { id: DEMO_ID, cwd, status: 'confirmed', createdAt: now, updatedAt: now, partial: true, progress: { files: 6, sessions: 4, bytes: 0 }, sources: [], skipped: [{ label: '【模拟】', reason: '演示数据，不是真实接入。' }], charterHash: await sha256(JSON.stringify(state.charter)), historySelection: [], selectedHistories: [] };
      return json(data);
    };
    const wrapped = async (input, init = {}) => {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(raw, origin);
      const inputMethod = input && typeof input === 'object' ? input.method : undefined;
      const method = String(init.method ?? inputMethod ?? 'GET').toUpperCase();
      const isDemo = url.searchParams.get('cwd') === cwd;
      if (url.origin !== origin) { notify('演示模式已阻止外部网络请求。'); return json({ success: false, error: '演示模式：外部请求已阻止' }, 403); }
      const goalMatch = /^\/api\/folders\/goals(?:\/([^/]+)(\/sessions(?:\/[^/]+)?)?)?$/.exec(url.pathname);
      if (goalMatch && isDemo) {
        const id = goalMatch[1] ? decodeURIComponent(goalMatch[1]) : null;
        const found = id ? state.goals.find((item) => item.id === id) : null;
        if (method === 'GET' || method === 'HEAD') return id ? (found ? json({ success: true, data: found }) : json({ success: false, error: '模拟目标不存在' }, 404)) : json({ success: true, data: state.goals });
        let body = {}; try { body = JSON.parse(typeof init.body === 'string' ? init.body : '{}'); } catch { /* invalid mock input */ }
        if (method === 'POST' && !id && typeof body.objective === 'string' && body.objective.trim()) {
          const now = Date.now(); const goal = { id: `DEMO-G${now}`, cwd, objective: `【模拟】${body.objective.trim().slice(0, 1000)}`, criteria: Array.isArray(body.criteria) ? body.criteria : [], status: 'paused', budget: body.budget ?? {}, autoRespawn: false, sessionIds: [], createdAt: now, updatedAt: now };
          state.goals.push(goal); notify('已创建模拟目标；没有启动真实任务。'); return json({ success: true, data: goal });
        }
        if (method === 'PATCH' && found && !goalMatch[2]) {
          for (const key of ['objective', 'criteria', 'budget', 'judge', 'status']) if (Object.hasOwn(body, key)) found[key] = body[key];
          if (!String(found.objective).includes('模拟')) found.objective = `【模拟】${found.objective}`;
          found.autoRespawn = false; found.updatedAt = Date.now(); notify('目标只在本次演示中更新。'); return json({ success: true, data: found });
        }
        if (method === 'DELETE' && found && !goalMatch[2]) { state.goals = state.goals.filter((item) => item.id !== id); notify('已移除模拟目标。'); return json({ success: true }); }
        if ((method === 'POST' || method === 'DELETE') && found && goalMatch[2]) { notify('已模拟会话操作；没有启动真实任务。'); return json({ success: true }); }
        return json({ success: false, error: '演示模式：目标操作未执行' }, 403);
      }
      if (method !== 'GET' && method !== 'HEAD') {
        let body = {};
        try { body = JSON.parse(typeof init.body === 'string' ? init.body : '{}'); } catch { /* fail closed */ }
        if (url.pathname === '/api/res-workflow/access-mode' && method === 'POST' && body.cwd === cwd) {
          const previous = accessMode();
          if (body.expectedRevision !== previous.revision) return json({ code: 'access-mode-revision-conflict' }, 409);
          if (!['default', 'full-access'].includes(body.mode) || typeof body.requestId !== 'string'
            || Object.keys(body).some(key => !['cwd', 'mode', 'expectedRevision', 'requestId'].includes(key))) return json({ code: 'access-mode-invalid' }, 400);
          state.accessMode = { ...previous, mode: body.mode, revision: globalThis.crypto.randomUUID(), updatedAt: new Date().toISOString() };
          notify('【模拟】访问权限已切换；真实权限与运行任务没有改变。');
          return json(accessMode());
        }
        const promptTarget = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
        if (promptTarget && method === 'POST' && sessions.some(session => session.id === decodeURIComponent(promptTarget[1]))
          && typeof body.text === 'string' && body.text.trim()) {
          const sessionId = decodeURIComponent(promptTarget[1]);
          state.prompts.push({ sessionId, text: body.text });
          notify('【模拟】任务已交给选定的主 Agent；没有调用模型。');
          return json({ success: true, transmitted: true, simulated: true, promptId: `DEMO-prompt-${state.prompts.length}` });
        }
        if (url.pathname === '/api/res-workflow/research-budget' && body.cwd === cwd
          && Number.isSafeInteger(body.limits?.attempts) && body.limits.attempts >= 0
          && Number.isSafeInteger(body.limits?.modelRequests) && body.limits.modelRequests >= 0) {
          state.budget = { attempts: body.limits.attempts, modelRequests: body.limits.modelRequests }; state.revision++;
          notify('预算已在演示中更新；真实配置没有改变。'); return json(budget());
        }
        if (url.pathname === '/api/session/spawn' && body.cwd === cwd) {
          state.tick = Math.min(8, state.tick + 1); notify('已模拟启动阶段；没有创建真实任务或调用模型。'); refresh();
          return json({ success: true, simulated: true });
        }
        notify('演示模式已阻止真实写入或模型请求。');
        return json({ success: false, error: '演示模式：真实操作已阻止' }, 403);
      }
      if (url.pathname === '/api/res-workflow/research-budget' && isDemo) return json(budget());
      if (url.pathname === '/api/res-workflow/access-mode' && isDemo) return json(accessMode());
      // DEMO: conversations have no native membership or private adoption proof.
      // Never read a real owner's binding and display it as a simulated session's.
      if (url.pathname === '/api/res-workflow/charter-binding' && isDemo) return json({
        schema: 'pi-research-charter-binding.v1', cwd, adopted: false, adoptionId: null,
        status: 'unavailable', bindingRevision: 0, boundCharterHash: null, boundCharterRevision: null,
        currentCharterHash: null, currentCharterRevision: null, currentObjective: null,
        canRebind: false, updatedAt: null, error: 'demo-session-has-no-native-binding',
      });
      if (url.pathname === '/api/sessions') return json(sessions);
      if (url.pathname === '/api/res-workflow/workbench-sync' && isDemo) {
        if (!state.charter) {
          const source = await upstream(`${origin}/api/res-workflow?cwd=${encodeURIComponent(cwd)}`, { method: 'GET' });
          if (!source.ok) return source;
          const data = await source.json(); state.charter = JSON.parse(data.research['state.json']).charter;
        }
        return json(await makeObservation(cwd, state.charter, state.tick));
      }
      const response = await upstream(input, init);
      if (url.pathname === '/api/res-workflow' && isDemo) return fakeSnapshot(response);
      return response;
    };
    return { fetch: wrapped, state, step() { state.tick = Math.min(8, state.tick + 1); refresh(); }, reset() { state.tick = 0; state.budget = { attempts: 24, modelRequests: 12 }; state.goals = initialGoals(); state.accessMode = null; state.prompts = []; state.revision++; refresh(); } };
  }

  function parseDemoEntry(href) {
    const entry = new URL(href);
    if (entry.searchParams.get('res-demo') !== '1') return null;
    const cwd = entry.searchParams.get('demo-project');
    if (!cwd || !cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 4096 || !/(?:demo|演示)/i.test(cwd.split('/').filter(Boolean).at(-1) || '')) return null;
    return { entry, cwd };
  }

  function install(window) {
    const parsed = parseDemoEntry(window.location.href);
    if (!parsed) return;
    const { entry, cwd: DEMO_CWD } = parsed;
    const folderSegment = btoa(unescape(encodeURIComponent(DEMO_CWD))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const enteredFromDemo = entry.pathname === '/res-workflow-demo.html';
    const selectedPath = enteredFromDemo ? `/folder/${folderSegment}/research` : entry.pathname;
    if (enteredFromDemo) window.history.replaceState(null, '', `${selectedPath}?res-demo=1&demo-project=${encodeURIComponent(DEMO_CWD)}`);

    let label;
    const notify = (message) => { if (label) label.textContent = message; };
    const refresh = () => window.document.dispatchEvent(new Event('visibilitychange'));
    const upstream = window.fetch.bind(window);
    const runtime = createDemoRuntime({ cwd: DEMO_CWD, origin: window.location.origin, upstream, notify, refresh });
    window.fetch = runtime.fetch;

    const send = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function (message) {
      if (isAllowedSocketMessage(message)) return send.call(this, message);
      const reply = simulatedSocketReply(message);
      notify(reply?.type === 'prompt_received'
        ? '模拟助手：已收到。可先看主控派发、子任务执行与评审汇总；没有调用模型。'
        : '已拦截真实会话操作；演示不会调用模型或写入项目。');
      if (reply) queueMicrotask(() => this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify(reply) })));
    };
    const xhrOpen = window.XMLHttpRequest.prototype.open, xhrSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (method, ...args) { this.__demoMethod = String(method).toUpperCase(); return xhrOpen.call(this, method, ...args); };
    window.XMLHttpRequest.prototype.send = function (...args) { if (this.__demoMethod !== 'GET' && this.__demoMethod !== 'HEAD') { notify('已拦截真实写入。'); this.abort(); return; } return xhrSend.apply(this, args); };
    try { window.navigator.sendBeacon = () => false; } catch { /* browser may make this property read-only */ }
    window.document.addEventListener('submit', (event) => {
      const form = event.target;
      if (form && String(form.method || 'GET').toUpperCase() !== 'GET') { event.preventDefault(); notify('演示模式已阻止表单的真实提交。'); }
    }, true);

    const push = window.history.pushState.bind(window.history), replace = window.history.replaceState.bind(window.history);
    const keepDemo = (value) => { if (value == null) return value; const url = new URL(String(value), window.location.href); if (url.origin !== window.location.origin) return value; url.searchParams.set('res-demo', '1'); url.searchParams.set('demo-project', DEMO_CWD); return url.pathname + url.search + url.hash; };
    window.history.pushState = (data, title, value) => push(data, title, keepDemo(value));
    window.history.replaceState = (data, title, value) => replace(data, title, keepDemo(value));

    function mount() {
      if (window.document.getElementById('res-workflow-simulation-banner')) return;
      const box = window.document.createElement('div'); box.id = 'res-workflow-simulation-banner';
      box.setAttribute('role', 'region'); box.setAttribute('aria-label', '本地模拟演示控制');
      box.style.cssText = 'position:fixed;z-index:2147483000;right:14px;bottom:14px;max-width:min(560px,calc(100vw - 28px));padding:10px 12px;border:1px solid #e3ab4c;border-radius:12px;background:#242018;color:#fff4db;box-shadow:0 8px 30px #0008;font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif';
      const title = window.document.createElement('strong'); title.textContent = '本地模拟演示 · 4 个 Multi-Agent / 8 个 Subagent';
      label = window.document.createElement('div'); label.textContent = '所有记录均为模拟；本标签页禁止真实模型请求和写入。'; label.style.cssText = 'margin:3px 0 7px;color:#f1d5a4';
      const buttons = window.document.createElement('div'); buttons.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      const add = (text, action) => { const button = window.document.createElement('button'); button.type = 'button'; button.textContent = text; button.style.cssText = 'border:1px solid #b58a43;border-radius:6px;padding:4px 9px;background:#3b3222;color:#fff4db;cursor:pointer'; button.addEventListener('click', action); buttons.appendChild(button); return button; };
      let timer = null;
      const play = add('▶ 播放模拟', () => { if (timer) { clearInterval(timer); timer = null; play.textContent = '▶ 播放模拟'; return; } play.textContent = '❚❚ 暂停'; timer = setInterval(() => { runtime.step(); notify(`模拟进度：${runtime.state.tick}/8；没有模型调用。`); if (runtime.state.tick >= 8) { clearInterval(timer); timer = null; play.textContent = '▶ 播放模拟'; } }, 1200); });
      add('单步', () => { runtime.step(); notify(`模拟进度：${runtime.state.tick}/8；没有模型调用。`); });
      add('重置', () => { if (timer) clearInterval(timer); timer = null; play.textContent = '▶ 播放模拟'; runtime.reset(); notify('模拟已重置；真实项目未修改。'); });
      add('退出模拟', () => { if (timer) clearInterval(timer); window.location.assign(selectedPath); });
      box.append(title, label, buttons); window.document.body.appendChild(box);
      const rewriteFeedback = () => {
        for (const item of window.document.querySelectorAll('[role="alert"] span')) {
          const before = item.textContent, after = rewriteStageFeedback(before);
          if (after !== before) item.textContent = after;
        }
      };
      new MutationObserver(rewriteFeedback).observe(window.document.body, { childList: true, subtree: true, characterData: true });
      rewriteFeedback();
    }
    if (window.document.readyState === 'loading') window.document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  }

  return { createDemoRuntime, isAllowedSocketMessage, simulatedSocketReply, makeObservation, rewriteStageFeedback, selectDemoPath, parseDemoEntry, install };
});
