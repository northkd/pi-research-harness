import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchAgentCanvas, type CanvasSessionCluster } from '../ResearchAgentCanvas.js';
import type { ResearchExecution } from '../research-projection.js';
import type { CollaborationPlan } from '../use-research-collaboration.js';

function makeClusters(count = 16): CanvasSessionCluster[] {
  return Array.from({ length: count }, (_, i) => {
    const parent: ResearchExecution = { id: `p-${i}`, kind: 'pi-session', sessionId: `s-${i}`, status: 'idle', source: 'observation', evidence: [], prompt: `会话 ${i} 的任务` };
    const children = Array.from({ length: 8 }, (_, j): ResearchExecution => ({
      id: `c-${i}-${j}`, kind: 'native-subagent', parentExecutionId: parent.id, role: `role-${j}`, status: j === 0 ? 'running' : 'completed', source: 'observation', evidence: [],
    }));
    return {
      sessionExec: parent,
      title: `研究会话 ${i}`,
      workflowDuty: parent.prompt,
      roleObj: { name: `session-${i}`, skills: [] },
      isCaptain: i === 0,
      childSubs: children,
      childRoleGroups: children.map(c => ({ roleName: c.role!, roleObj: { name: c.role!, skills: [] }, executions: [c], latest: c })),
    };
  });
}

const label = (name: string) => name;
afterEach(cleanup);

describe('research collaboration canvas', () => {
  it('starts at 100%, preserves chosen zoom across updates and expands inline without switching scenes', () => {
    const props = { stale: false, onAgent: vi.fn(), statusLabel: label, roleLabel: label };
    const view = render(<ResearchAgentCanvas clusters={makeClusters()} {...props} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    expect(viewport.getAttribute('data-scale')).toBe('1.000');
    expect(screen.getByTestId('research-canvas-zoom').textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: '放大画布' }));
    expect(viewport.getAttribute('data-scale')).toBe('1.250');
    view.rerender(<ResearchAgentCanvas clusters={makeClusters(17)} {...props} stale />);
    expect(viewport.getAttribute('data-scale')).toBe('1.250');
    fireEvent.click(screen.getByRole('button', { name: '展开 研究会话 4 下属节点' }));
    expect(viewport.getAttribute('data-scale')).toBe('1.250');
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(17);
    fireEvent.click(screen.getByRole('button', { name: '收起执行卡片' }));
    expect(screen.queryAllByTestId('canvas-role-node')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '适应画布' }));
    expect(viewport.getAttribute('data-scale')).not.toBe('1.250');
  });

  it('distinguishes explicit user creation, agent dispatch and unrecorded historical origins', () => {
    const clusters: CanvasSessionCluster[] = makeClusters(3);
    clusters[0]!.origin = 'user-created';
    clusters[1]!.origin = 'lead-agent-created';
    clusters[1]!.creatorSessionId = 'p-0';
    clusters[1]!.sessionExec.parentExecutionId = 'p-0';
    render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const user = screen.getByRole('button', { name: '展开 研究会话 0 下属节点' });
    const agent = screen.getByRole('button', { name: '展开 研究会话 1 下属节点' });
    const unknown = screen.getByRole('button', { name: '展开 研究会话 2 下属节点' });
    const userOrigin = within(user).getByTestId('canvas-session-origin');
    const agentOrigin = within(agent).getByTestId('canvas-session-origin');
    expect(user.getAttribute('data-origin')).toBe('user-created');
    expect(userOrigin.textContent).toContain('用户创建');
    expect(agent.getAttribute('data-origin')).toBe('lead-agent-created');
    expect(agentOrigin.textContent).toContain('Agent 派生');
    expect(agentOrigin.closest('.research-fleet-footer')?.textContent).toContain('Subagent ×8');
    expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(1);
    expect(agent.textContent).not.toContain('创建者：');
    expect(agent.textContent).toContain('Multi-Agent');
    expect(agent.textContent).toContain('Subagent ×8');
    expect(unknown.getAttribute('data-origin')).toBe('unknown');
    expect(within(unknown).getByTestId('canvas-session-origin').textContent).toContain('来源未记录');
    expect(unknown.textContent).not.toContain('用户创建');
  });

  it('expands the chosen session subagents inline inside the topology without hiding sibling sessions', () => {
    const clusters = makeClusters(), onAgent = vi.fn();
    render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
    expect(screen.getByText('会话 4 的任务')).toBeTruthy();
    expect(screen.queryAllByTestId('canvas-role-node')).toHaveLength(0);
    const toggleBtn = screen.getByRole('button', { name: '展开 研究会话 4 下属节点' });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    // Sibling sessions remain visible in the topology! No scene switch.
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(8);
    expect(screen.queryByRole('button', { name: '返回全部会话' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /查看 role-3 详情/ }));
    expect(onAgent).toHaveBeenCalledWith(clusters[4]!.childRoleGroups[3]!.roleObj, clusters[4]!.childRoleGroups[3]!.latest);
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: '收起 研究会话 4 下属节点' }));
    expect(screen.queryAllByTestId('canvas-role-node')).toHaveLength(0);
  });

  it('keeps recorded dispatch edges without exposing internal ids, evidence or debug explanations', () => {
    const clusters = makeClusters(2), onAgent = vi.fn();
    const relations = [
      { id: 'dispatch-debug-id', fromExecutionId: 'p-0', toExecutionId: 'p-1', kind: 'dispatch' as const, evidence: { source: 'native-status' as const, eventId: 'event-debug-id' } },
      { id: 'missing-endpoint', fromExecutionId: 'p-0', toExecutionId: 'missing-session', kind: 'dispatch' as const, evidence: { source: 'native-status' as const, eventId: 'missing-event' } },
    ];
    const view = render(<ResearchAgentCanvas clusters={clusters} relations={relations} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-relation-edge')).toHaveLength(1);
    expect(screen.queryByTestId('canvas-relation-evidence')).toBeNull();
    expect(view.container.textContent).not.toMatch(/p-0|p-1|dispatch-debug-id|event-debug-id|native-status|实际派发|虚线仅表示|紫色边仅来自/);
    expect(Array.from(view.container.querySelectorAll('[title]')).map(node => node.getAttribute('title')).join(' ')).not.toMatch(/p-0|p-1|native-status|event-debug-id/);
    expect(screen.getByText('研究会话 0')).toBeTruthy();
    expect(screen.getByText('研究会话 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开 研究会话 0 下属节点' }));
    expect(view.container.textContent).not.toMatch(/实线表示已记录|p-0|p-1|native-status/);
    fireEvent.click(screen.getByRole('button', { name: '查看 研究会话 0 会话详情' }));
    expect(onAgent).toHaveBeenCalledWith(clusters[0]!.roleObj, clusters[0]!.sessionExec);
  });

  it('filters many sessions using their title or recorded task without dropping inline toggle', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(16)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索会话' }), { target: { value: '会话 14 的任务' } });
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '展开 研究会话 14 下属节点' }));
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(8);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索会话' }), { target: { value: '' } });
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
  });

  it('keeps ordinary scrolling available while modifier-wheel zooms the canvas', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(2)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    const before = viewport.getAttribute('data-scale');
    fireEvent.wheel(viewport, { deltaY: -120 });
    expect(viewport.getAttribute('data-scale')).toBe(before);
    fireEvent.wheel(viewport, { deltaY: -120, ctrlKey: true, clientX: 80, clientY: 80 });
    expect(viewport.getAttribute('data-scale')).not.toBe(before);
  });

  it('lets keyboard users pan the canvas without moving the page', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(2)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    const world = viewport.firstElementChild as HTMLElement;
    const before = world.getAttribute('style');
    fireEvent.keyDown(viewport, { key: 'ArrowRight' });
    expect(world.getAttribute('style')).not.toBe(before);
  });

  it('exposes zoom controls and preserves inline expansion across refreshes', () => {
    const clusters = makeClusters(2), onAgent = vi.fn();
    const view = render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    const before = viewport.getAttribute('data-scale');
    fireEvent.click(screen.getByRole('button', { name: '放大画布' }));
    expect(viewport.getAttribute('data-scale')).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: '展开 研究会话 1 下属节点' }));
    view.rerender(<ResearchAgentCanvas clusters={makeClusters(2)} stale={true} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(8);
    expect(screen.getAllByText(/观测已过期/).length).toBeGreaterThan(0);
  });
});

describe('recorded hierarchy, Plan L1 -> Multi-Agent L2 -> Subagent L3 topology and inline spreading', () => {
  it('does not select an arbitrary creator when loaded dispatch parents conflict', () => {
    const clusters = makeClusters(3);
    clusters[2]!.sessionExec.parentExecutionId = 'p-0';
    const relations = [{ id: 'conflict', fromExecutionId: 'p-1', toExecutionId: 'p-2', kind: 'dispatch' as const, evidence: { source: 'explicit-record' as const, eventId: 'spawn-conflict' } }];
    render(<ResearchAgentCanvas clusters={clusters} relations={relations} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const child = screen.getByRole('button', { name: '展开 研究会话 2 下属节点' });
    expect(screen.queryAllByTestId('canvas-parent-edge')).toHaveLength(0);
    expect(within(child).getByTestId('canvas-session-creator').textContent).toContain('父关系冲突');
    expect(child.textContent).not.toMatch(/创建者：研究会话 [01]|p-0（未载入）/);
  });

  it('shows nested collaborators beneath their real creator, with direct detail inspection', () => {
    const clusters = makeClusters(3), relations = [
      { id: 'a', fromExecutionId: 'p-0', toExecutionId: 'p-1', kind: 'dispatch' as const, evidence: { source: 'explicit-record' as const, eventId: 'spawn-a' } },
      { id: 'b', fromExecutionId: 'p-1', toExecutionId: 'p-2', kind: 'dispatch' as const, evidence: { source: 'explicit-record' as const, eventId: 'spawn-b' } },
    ];
    const onAgent = vi.fn();
    render(<ResearchAgentCanvas clusters={clusters} relations={relations} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(2);
    const leaf = screen.getByRole('button', { name: '展开 研究会话 2 下属节点' });
    expect(leaf.getAttribute('data-depth')).toBe('2');
    expect(leaf.getAttribute('data-parent-id')).toBe('p-1');
    expect(leaf.textContent).not.toContain('创建者：');
    fireEvent.click(screen.getByRole('button', { name: '查看 研究会话 1 会话详情' }));
    expect(onAgent).toHaveBeenCalledWith(clusters[1]!.roleObj, clusters[1]!.sessionExec);
  });

  it('shows English Ended and Queued status badges and wraps large fan-outs at 100% scale', () => {
    const clusters = makeClusters(12);
    clusters[1]!.sessionExec.status = 'ended';
    clusters[2]!.sessionExec.status = 'queued';
    for (let i = 1; i < clusters.length; i++) clusters[i]!.sessionExec.parentExecutionId = 'p-0';
    render(<ResearchAgentCanvas clusters={clusters} stale={false} layout="tree" onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    expect(viewport.getAttribute('data-scale')).toBe('1.000');
    expect(screen.getByText('Ended')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();

    const wraps = Array.from(viewport.querySelectorAll('.research-fleet-node-wrap')).map(el => ({
      x: Number.parseFloat((el as HTMLElement).style.left),
      y: Number.parseFloat((el as HTMLElement).style.top),
      w: Number.parseFloat((el as HTMLElement).style.width),
      h: Number.parseFloat((el as HTMLElement).style.height),
    }));
    expect(wraps).toHaveLength(12);
    expect(new Set(wraps.map(box => box.x)).size).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < wraps.length; i++) {
      for (let j = i + 1; j < wraps.length; j++) {
        const a = wraps[i]!, b = wraps[j]!;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('packs more siblings per row as the canvas zooms out, so agents stay visible', () => {
    const clusters = makeClusters(12);
    for (let i = 1; i < clusters.length; i++) clusters[i]!.sessionExec.parentExecutionId = 'p-0';
    render(<ResearchAgentCanvas clusters={clusters} stale={false} layout="tree" onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport = screen.getByTestId('research-canvas-viewport');
    const columnsAt = () => new Set(
      Array.from(viewport.querySelectorAll('.research-fleet-node-wrap')).map(el => (el as HTMLElement).style.left),
    ).size;
    const at100 = columnsAt();
    fireEvent.click(screen.getByRole('button', { name: '缩小画布' }));
    fireEvent.click(screen.getByRole('button', { name: '缩小画布' }));
    fireEvent.click(screen.getByRole('button', { name: '缩小画布' }));
    expect(columnsAt()).toBeGreaterThan(at100);
  });

  it('uses explicit execution parents and keeps an unloaded creator distinct from user-created roots', () => {
    const clusters = makeClusters(3);
    clusters[1]!.sessionExec.parentExecutionId = 'p-0';
    clusters[2]!.sessionExec.parentExecutionId = 'unloaded-parent';
    render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '展开 研究会话 1 下属节点' }).getAttribute('data-parent-id')).toBe('p-0');
    const detached = screen.getByRole('button', { name: '展开 研究会话 2 下属节点' });
    expect(detached.textContent).toContain('unloaded-parent（未载入）');
    expect(detached.textContent).not.toContain('我创建的');
  });

  it('spreads repeated Subagent runs inline inside the existing topology, preserves details and collapses with Escape', () => {
    const clusters = makeClusters(2), group = clusters[0]!.childRoleGroups[0]!, onAgent = vi.fn();
    group.executions = [group.latest, { ...group.latest, id: 'earlier-run', status: 'completed', prompt: 'Earlier independent work' }];
    render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    fireEvent.click(screen.getByRole('button', { name: '展开 研究会话 0 下属节点' }));
    const role = screen.getByRole('button', { name: /展开 role-0 的 2 次 Subagent 执行/ });
    expect(role.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(role);
    const viewport = screen.getByTestId('research-canvas-viewport');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(viewport).getAllByTestId('canvas-session-node')).toHaveLength(2);
    expect(within(viewport).getAllByRole('button', { name: /查看 role-0 第 .* 次详情/ })).toHaveLength(2);
    expect(role.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(viewport).getByRole('button', { name: '查看 role-0 第 1 次详情' }));
    expect(onAgent).toHaveBeenLastCalledWith(group.roleObj, group.executions[1]);
    fireEvent.keyDown(role, { key: 'Escape' });
    expect(role.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(role);
    expect(within(viewport).queryByRole('button', { name: '查看 role-0 第 1 次详情' })).toBeNull();
    fireEvent.click(role);
    fireEvent.click(screen.getByRole('button', { name: '收起执行卡片' }));
    expect(screen.queryAllByTestId('canvas-role-node')).toHaveLength(0);
  });

  it('places L1 Plan nodes directly beneath L0 Main Agent with 1:N Multi-Agent mapping and inline Plan/Subagent toggling', () => {
    const clusters = makeClusters(3);
    clusters[0]!.title = '研究主会话';
    clusters[1]!.title = '文献与实验执行';
    clusters[1]!.sessionExec.parentExecutionId = 'p-0';
    clusters[2]!.title = '统计复核';
    clusters[2]!.sessionExec.parentExecutionId = 'p-0';
    const plans: CollaborationPlan[] = [
      {
        id: 'plan-alpha',
        clientPlanId: 'exp-and-audit',
        parentSessionId: 's-0',
        revision: 2,
        tasks: [
          { id: 't-1', role: 'experiment', task: 'Run benchmark', status: 'running', sessionId: 's-1' },
          { id: 't-2', role: 'audit', task: 'Audit claim', status: 'completed', sessionId: 's-2', dependsOn: ['t-1'] },
          { id: 't-3', role: 'writing', task: 'Draft paper section', status: 'queued', waitingReason: 'capacity', queueRank: 1, dependsOn: ['t-2'] },
        ],
      },
    ];
    const onJumpPlanTask = vi.fn();
    render(
      <ResearchAgentCanvas
        clusters={clusters}
        plans={plans}
        mainSessionId="s-0"
        showPlanGate
        onJumpPlanTask={onJumpPlanTask}
        stale={false}
        onAgent={vi.fn()}
        statusLabel={label}
        roleLabel={label}
      />,
    );

    expect(screen.getByTestId('canvas-captain-plan-progress').textContent).toContain('Plan 进度 0/1');
    const planNode = screen.getByTestId('canvas-plan-node');
    expect(planNode.textContent).toContain('文献与实验执行');
    expect(planNode.textContent).toContain('1:3 Multi-Agent');
    expect(screen.getByTestId('canvas-queued-task-node')).toBeTruthy();
    expect(screen.getAllByTestId('canvas-dependency-edge')).toHaveLength(2);
    expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(4);

    // Click Multi-Agent expands L3 Subagent inline without hiding Plan or queued Multi-Agent!
    fireEvent.click(screen.getByRole('button', { name: '展开 文献与实验执行 下属节点' }));
    expect(screen.getByTestId('canvas-plan-node')).toBeTruthy();
    expect(screen.getByTestId('canvas-queued-task-node')).toBeTruthy();
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(8);

    // Jump start button on queued Multi-Agent invokes onJumpPlanTask cleanly
    fireEvent.click(screen.getByRole('button', { name: '优先启动' }));
    expect(onJumpPlanTask).toHaveBeenCalledWith('plan-alpha', 't-3', 2);

    // Collapsing Plan hides its L2 Multi-Agent subtree inline; re-expanding restores it
    fireEvent.click(planNode);
    expect(screen.queryByRole('button', { name: '展开 文献与实验执行 下属节点' })).toBeNull();
    expect(screen.queryByTestId('canvas-queued-task-node')).toBeNull();
    fireEvent.click(screen.getByTestId('canvas-plan-node'));
    expect(screen.getByRole('button', { name: '收起 文献与实验执行 下属节点' })).toBeTruthy();
  });

  it('highlights blocked/unfinished plan tasks directly on L2 Multi-Agent session cards and opens the queue modal', () => {
    const clusters = makeClusters(4);
    clusters[0]!.title = '07-数据分析后处理';
    clusters[1]!.title = 'Na4Sn3F10 验收';
    clusters[1]!.sessionExec.parentExecutionId = 'p-0';
    clusters[2]!.title = 'NaSbF4 验收';
    clusters[2]!.sessionExec.parentExecutionId = 'p-0';
    clusters[3]!.title = 'Na3Sb5F18 验收';
    clusters[3]!.sessionExec.parentExecutionId = 'p-0';
    const plans: CollaborationPlan[] = [
      {
        id: 'plan-fluorides',
        clientPlanId: 'three-fluorides-check',
        parentSessionId: 's-0',
        status: 'blocked',
        tasks: [
          { id: 'sn', role: 'audit-sn', task: 'Check Sn', status: 'blocked', sessionId: 's-1', summary: '抽核脚本被宿主拦截' },
          { id: 'sb', role: 'audit-sb', task: 'Check Sb', status: 'completed', sessionId: 's-2' },
          { id: 'sb5', role: 'audit-sb-five', task: 'Check Sb5', status: 'completed', sessionId: 's-3' },
        ],
      },
    ];
    const onCollapse = vi.fn();
    render(
      <ResearchAgentCanvas
        clusters={clusters}
        plans={plans}
        mainSessionId="s-0"
        onCollapse={onCollapse}
        stale={false}
        onAgent={vi.fn()}
        statusLabel={label}
        roleLabel={label}
      />,
    );

    const planNode = screen.getByTestId('canvas-plan-node');
    expect(planNode.textContent).toContain('2/3 (67%)');
    expect(planNode.textContent).toContain('受阻/未完成 1');
    expect(screen.queryByTestId('canvas-plan-open-todo')).toBeNull();

    const statusBadges = screen.getAllByTestId('canvas-session-plan-task-status');
    expect(statusBadges).toHaveLength(3);
    const blockedBadge = statusBadges.find(el => el.getAttribute('data-task-status') === 'blocked');
    expect(blockedBadge?.textContent).toContain('受阻 · 未完成');
    expect(blockedBadge?.closest('[data-testid="canvas-session-node"]')?.textContent).toContain('抽核脚本被宿主拦截');
    expect(statusBadges.filter(el => el.getAttribute('data-task-status') === 'completed')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '收起历史批次拓扑' }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });
});
