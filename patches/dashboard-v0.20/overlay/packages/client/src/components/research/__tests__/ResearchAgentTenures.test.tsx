import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchAgentCanvas, type CanvasCollaborationState, type CanvasSessionCluster } from '../ResearchAgentCanvas.js';
import type { ResearchExecution } from '../research-projection.js';

afterEach(cleanup);
const label = (value: string) => value;
const props = { stale:false, onAgent:vi.fn(), statusLabel:label, roleLabel:label };
function cluster(id: string, parentId?: string, model = 'provider/model-recorded'): CanvasSessionCluster {
  const sessionExec: ResearchExecution = { id:`session-${id}`, sessionId:id, kind:'pi-session', role:'analysis', status:'running', source:'observation', evidence:[], observedModel:model,
    ...(parentId ? { parentExecutionId:`session-${parentId}` } : {}) };
  return { sessionExec, title:`任务 ${id}`, roleObj:{name:'analysis',skills:[]}, isCaptain:false, childSubs:[], childRoleGroups:[], origin:parentId?'lead-agent-created':'user-created' };
}
function sub(parent: CanvasSessionCluster, id: string, startedAt?: string) {
  const execution: ResearchExecution = { id, parentExecutionId:parent.sessionExec.id, kind:'native-subagent', role:'verification', status:'completed', source:'observation', evidence:[], observedModel:'provider/sub-model', startedAt };
  parent.childSubs.push(execution); parent.childRoleGroups.push({roleName:execution.role!, roleObj:{name:execution.role!,skills:[]}, executions:[execution], latest:execution});
  return execution;
}
function state(): CanvasCollaborationState {
  return { currentTenureId:'t-2', tenures:[
    {id:'t-1',mainSessionId:'old',status:'historical',sessionIds:['old','old-child'],startedAt:'2026-11-15T00:00:00.000Z',endedAt:'2026-11-16T00:00:00.000Z',snapshots:{ old:{title:'历史研究',model:'provider/frozen-model',status:'ended'}, 'old-child':{model:'provider/frozen-worker',status:'completed'} }},
    {id:'t-2',mainSessionId:'lead',status:'current',sessionIds:['lead','m1','m2','m3','m4'],startedAt:'2026-11-16T00:00:00.000Z'},
  ] };
}
describe('authoritative lead tenures', () => {
  it('shows compact cards with real models and creation provenance, not sibling dispatch', () => {
    const clusters = [cluster('lead'), ...['m1','m2','m3','m4'].map(id => cluster(id,'lead'))];
    sub(clusters[2], 'sub-2'); sub(clusters[3], 'sub-3');
    render(<ResearchAgentCanvas {...props} clusters={clusters} collaboration={{...state(),tenures:state().tenures.slice(1)}} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    expect(viewport.getAttribute('data-scale')).toBe('1.000');
    expect(within(viewport).getAllByTestId('canvas-agent-model')).toHaveLength(7);
    const peerEdges = Array.from(viewport.querySelectorAll('[data-testid="canvas-parent-edge"]')).filter(edge => edge.getAttribute('data-to')!.startsWith('session-m'));
    expect(peerEdges).toHaveLength(4);
    expect(peerEdges.every(edge => edge.getAttribute('data-from') === 'session-lead')).toBe(true);
    expect(within(viewport).getAllByText('来源：主 Agent 派发')).toHaveLength(4);
    expect(within(viewport).getByText('来源：Multi-agent · 任务 m2')).toBeTruthy();
    expect(viewport.textContent).toContain('provider/sub-model');
  });
  it('keeps archived families independent and puts the real queue between current and history', () => {
    const clusters = [cluster('lead'),cluster('m1','lead'),cluster('old'),cluster('old-child','old')];
    const view = render(<ResearchAgentCanvas {...props} clusters={clusters} collaboration={state()} afterCurrent={<div data-testid="queue-slot">真实队列</div>} />);
    expect(screen.getByText('第 1 任期 · 历史研究')).toBeTruthy();
    const current = screen.getByTestId('research-canvas-viewport'), historical = screen.getByTestId('historical-canvas-viewport');
    expect(current.textContent).not.toContain('old-child'); expect(historical.textContent).not.toContain('任务 lead');
    expect(historical.textContent).toContain('provider/frozen-model');
    expect(view.container.textContent!.indexOf('真实队列')).toBeLessThan(view.container.textContent!.indexOf('历史主 Agent'));
    const toggle = screen.getByText('第 1 任期 · 历史研究').closest('summary')!;
    expect(toggle.parentElement?.hasAttribute('open')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.parentElement?.hasAttribute('open')).toBe(false);
  });
  it('shows removal only for Main and Multi, passes raw session id and tenure, and preserves details', () => {
    const main = cluster('lead'), worker = cluster('m1','lead'), child = sub(worker,'native-child');
    const onDetach = vi.fn(), onAgent = vi.fn();
    render(<ResearchAgentCanvas {...props} onAgent={onAgent} clusters={[main,worker]} collaboration={{...state(),tenures:state().tenures.slice(1)}} onDetach={onDetach} />);
    expect(screen.getAllByRole('button',{name:/更多操作/})).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'更多操作：任务 m1'}));
    fireEvent.click(screen.getByRole('menuitem',{name:'移出 res-workflow'}));
    expect(onDetach).toHaveBeenCalledWith('m1','t-2');
    fireEvent.click(screen.getByRole('button',{name:'查看 verification Subagent详情'}));
    expect(onAgent).toHaveBeenCalledWith(worker.childRoleGroups[0].roleObj,child);
  });
  it('does not infer historic parentage or borrow a later model when the same session is reused', () => {
    const reused = cluster('lead',undefined,'provider/new-model');
    sub(reused,'old-run','2026-11-15T12:00:00.000Z'); sub(reused,'new-run','2026-11-16T12:00:00.000Z');
    const collaboration = state(); collaboration.tenures[0].mainSessionId = 'lead'; collaboration.tenures[0].sessionIds = ['lead']; collaboration.tenures[0].snapshots = undefined;
    render(<ResearchAgentCanvas {...props} clusters={[reused]} collaboration={collaboration} />);
    const current = screen.getByTestId('research-canvas-viewport'), historical = screen.getByTestId('historical-canvas-viewport');
    expect(current.textContent).toContain('provider/new-model'); expect(historical.textContent).not.toContain('provider/new-model');
    expect(within(current).getAllByTestId('canvas-role-node')).toHaveLength(1); expect(within(historical).getAllByTestId('canvas-role-node')).toHaveLength(1);
    expect(within(historical).getByText('模型未记录')).toBeTruthy();
  });
  it('does not resurrect removed tenures, and leaves unrelated joined conversations unclassified', () => {
    const collaboration = state(); collaboration.tenures[0].status = 'removed';
    render(<ResearchAgentCanvas {...props} clusters={[cluster('lead'),cluster('old'),cluster('unrelated')]} collaboration={collaboration} />);
    expect(screen.queryByLabelText('历史主 Agent')).toBeNull();
    expect(screen.queryByTestId('historical-canvas-viewport')).toBeNull();
    expect(screen.getByText(/其他已接入会话 · 1/)).toBeTruthy();
    expect(within(screen.getByTestId('tenure-network')).getByTestId('research-canvas-viewport').textContent).not.toContain('unrelated');
  });
  it('excludes explicitly removed descendants from an archived tenure without erasing other history', () => {
    const collaboration = state(); collaboration.tenures[0].detachedSessionIds = ['old-child'];
    render(<ResearchAgentCanvas {...props} clusters={[cluster('lead'),cluster('old'),cluster('old-child','old')]} collaboration={collaboration} />);
    const historical = screen.getByTestId('historical-canvas-viewport');
    expect(historical.textContent).toContain('历史研究'); expect(historical.textContent).not.toContain('任务 old-child');
    expect(within(historical).queryAllByTestId('canvas-parent-edge')).toHaveLength(0);
  });
  it('uses a frozen historical parent instead of a later relationship for the same session', () => {
    const collaboration = state();
    collaboration.tenures[0].snapshots!['old-child'] = { title:'历史复核', model:'provider/frozen-worker', parentSessionId:'old', origin:'agent-dispatch' };
    const reusedChild = cluster('old-child','lead');
    render(<ResearchAgentCanvas {...props} clusters={[cluster('lead'),cluster('old'),reusedChild]} collaboration={collaboration} />);
    const history = screen.getByTestId('historical-canvas-viewport');
    const edge = within(history).getByTestId('canvas-parent-edge');
    expect(edge.getAttribute('data-from')).toBe('session-old');
    expect(edge.getAttribute('data-to')).toBe('session-old-child');
    expect(history.textContent).toContain('来源：主 Agent 派发');
    expect(history.textContent).not.toContain('任务 lead');
  });
  it('does not reconstruct historical dispatch from current metadata when its receipt is absent', () => {
    render(<ResearchAgentCanvas {...props} clusters={[cluster('lead'),cluster('old'),cluster('old-child','old')]} collaboration={state()} />);
    const history = screen.getByTestId('historical-canvas-viewport');
    expect(within(history).queryAllByTestId('canvas-parent-edge')).toHaveLength(0);
    expect(history.textContent).toContain('来源未记录');
    expect(history.textContent).not.toContain('主 Agent 派发');
  });
  it('resets the active viewport and operation menu when the same session begins a new tenure', () => {
    const collaboration = { ...state(), tenures:state().tenures.slice(1) };
    const view = render(<ResearchAgentCanvas {...props} clusters={[cluster('lead')]} collaboration={collaboration} onDetach={vi.fn()} />);
    fireEvent.click(screen.getByRole('button',{name:'放大画布'}));
    fireEvent.click(screen.getByRole('button',{name:'更多操作：任务 lead'}));
    expect(screen.getByTestId('research-canvas-viewport').getAttribute('data-scale')).toBe('1.250');
    expect(screen.getByRole('menuitem',{name:'移出 res-workflow'})).toBeTruthy();
    const next = { ...collaboration, currentTenureId:'t-3', tenures:[
      {...collaboration.tenures[0], status:'historical', endedAt:'2026-11-17T00:00:00Z'},
      {...collaboration.tenures[0], id:'t-3', status:'current', startedAt:'2026-11-17T00:00:00Z'},
    ] };
    view.rerender(<ResearchAgentCanvas {...props} clusters={[cluster('lead')]} collaboration={next} onDetach={vi.fn()} />);
    expect(screen.getByTestId('research-canvas-viewport').getAttribute('data-scale')).toBe('1.000');
    expect(screen.queryByRole('menuitem',{name:'移出 res-workflow'})).toBeNull();
  });
  it('retains readable cards, zoom, ordinary page scroll and explicit no-match feedback', () => {
    render(<ResearchAgentCanvas {...props} clusters={[cluster('lead')]} collaboration={{...state(),tenures:state().tenures.slice(1)}} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    fireEvent.wheel(viewport,{deltaY:-120}); expect(viewport.getAttribute('data-scale')).toBe('1.000');
    fireEvent.click(screen.getByRole('button',{name:'放大画布'})); expect(viewport.getAttribute('data-scale')).toBe('1.250');
    fireEvent.click(screen.getByRole('button',{name:'返回全部会话'})); expect(viewport.getAttribute('data-scale')).toBe('1.000');
    fireEvent.change(screen.getByRole('searchbox',{name:'搜索会话'}),{target:{value:'not-a-model'}});
    expect(screen.getByText('没有匹配的会话')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'全屏查看协作图'}));
    expect(screen.getByTestId('tenure-network').classList.contains('is-maximized')).toBe(true);
    fireEvent.keyDown(document,{key:'Escape'}); expect(screen.getByTestId('tenure-network').classList.contains('is-maximized')).toBe(false);
  });
});
