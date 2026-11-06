import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchAgentCanvas } from '../ResearchAgentCanvas.js';
import type { ResearchExecution } from '../research-projection.js';

function makeClusters(count = 16) {
  return Array.from({length: count}, (_, i) => {
    const parent: ResearchExecution = {id:`p-${i}`,kind:'pi-session',status:'idle',source:'observation',evidence:[],prompt:`会话 ${i} 的任务`};
    const children = Array.from({length: 8}, (_, j): ResearchExecution => ({id:`c-${i}-${j}`,kind:'native-subagent',parentExecutionId:parent.id,role:`role-${j}`,status:j===0?'running':'completed',source:'observation',evidence:[]}));
    return {sessionExec:parent,title:`研究会话 ${i}`,workflowDuty:parent.prompt,roleObj:{name:`session-${i}`,skills:[]},isCaptain:i===0,childSubs:children,childRoleGroups:children.map(c=>({roleName:c.role!,roleObj:{name:c.role!,skills:[]},executions:[c],latest:c}))};
  });
}
const label = (name: string) => name;
afterEach(cleanup);
describe('research collaboration canvas', () => {
  it('shows a compact overview and opens only the chosen session’s children', () => {
    const clusters=makeClusters(),onAgent=vi.fn();
    render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
    expect(screen.getByText('会话 4 的任务')).toBeTruthy();
    expect(screen.queryAllByTestId('canvas-role-node')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:/聚焦研究会话 4/}));
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(4);
    expect(screen.queryAllByTestId('canvas-session-node')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:/查看 role-3 详情/}));
    expect(onAgent).toHaveBeenCalledWith(clusters[4].childRoleGroups[3].roleObj,clusters[4].childRoleGroups[3].latest);
    fireEvent.click(screen.getByRole('button',{name:'下一组角色'}));
    expect(screen.getByRole('button',{name:/查看 role-7 详情/})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/查看 role-3 详情/})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'返回全部会话'}));
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
  });
  it('keeps recorded dispatch edges without exposing internal ids, evidence or debug explanations', () => {
    const clusters=makeClusters(2),onAgent=vi.fn();
    const relations = [
      {id:'dispatch-debug-id',fromExecutionId:'p-0',toExecutionId:'p-1',kind:'dispatch' as const,evidence:{source:'native-status' as const,eventId:'event-debug-id'}},
      {id:'missing-endpoint',fromExecutionId:'p-0',toExecutionId:'missing-session',kind:'dispatch' as const,evidence:{source:'native-status' as const,eventId:'missing-event'}},
    ];
    const view=render(<ResearchAgentCanvas clusters={clusters} relations={relations} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-relation-edge')).toHaveLength(1);
    expect(screen.queryByTestId('canvas-relation-evidence')).toBeNull();
    expect(view.container.textContent).not.toMatch(/p-0|p-1|dispatch-debug-id|event-debug-id|native-status|实际派发|虚线仅表示|紫色边仅来自/);
    expect(Array.from(view.container.querySelectorAll('[title]')).map(node=>node.getAttribute('title')).join(' ')).not.toMatch(/p-0|p-1|native-status|event-debug-id/);
    expect(screen.getByText('研究会话 0')).toBeTruthy();
    expect(screen.getByText('研究会话 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:/聚焦研究会话 0/}));
    expect(view.container.textContent).not.toMatch(/实线表示已记录|p-0|p-1|native-status/);
    fireEvent.click(screen.getByRole('button',{name:'会话详情与纠偏'}));
    expect(onAgent).toHaveBeenCalledWith(clusters[0].roleObj,clusters[0].sessionExec);
  });
  it('filters many sessions using their title or recorded task', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(16)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    fireEvent.change(screen.getByRole('searchbox',{name:'搜索会话'}),{target:{value:'会话 14 的任务'}});
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:/聚焦研究会话 14/}));
    fireEvent.click(screen.getByRole('button',{name:'返回全部会话'}));
    expect(screen.getAllByTestId('canvas-session-node')).toHaveLength(16);
    expect((screen.getByRole('searchbox',{name:'搜索会话'}) as HTMLInputElement).value).toBe('');
  });
  it('keeps ordinary scrolling available while modifier-wheel zooms the canvas', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(2)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport=screen.getByTestId('research-canvas-viewport');
    const before=viewport.getAttribute('data-scale');
    fireEvent.wheel(viewport,{deltaY:-120});
    expect(viewport.getAttribute('data-scale')).toBe(before);
    fireEvent.wheel(viewport,{deltaY:-120,ctrlKey:true,clientX:80,clientY:80});
    expect(viewport.getAttribute('data-scale')).not.toBe(before);
  });
  it('lets keyboard users pan the focused canvas without moving the page', () => {
    render(<ResearchAgentCanvas clusters={makeClusters(2)} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
    const viewport=screen.getByTestId('research-canvas-viewport');
    const world=viewport.firstElementChild as HTMLElement;
    const before=world.getAttribute('style');fireEvent.keyDown(viewport,{key:'ArrowRight'});
    expect(world.getAttribute('style')).not.toBe(before);
  });
  it('exposes zoom controls and preserves focus across refreshes', () => {
    const clusters=makeClusters(2),onAgent=vi.fn();
    const view=render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    const viewport=screen.getByTestId('research-canvas-viewport');
    const before=viewport.getAttribute('data-scale');fireEvent.click(screen.getByRole('button',{name:'放大画布'}));
    expect(viewport.getAttribute('data-scale')).not.toBe(before);
    fireEvent.click(screen.getByRole('button',{name:/聚焦研究会话 1/}));
    view.rerender(<ResearchAgentCanvas clusters={makeClusters(2)} stale={true} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
    expect(screen.getAllByTestId('canvas-role-node')).toHaveLength(4);
    expect(screen.getAllByText(/观测已过期/).length).toBeGreaterThan(0);
  });
});

describe('recorded hierarchy and inline spreading', () => {
 it('shows nested collaborators beneath their real creator, with parent navigation', () => {
  const clusters=makeClusters(3),relations=[
   {id:'a',fromExecutionId:'p-0',toExecutionId:'p-1',kind:'dispatch' as const,evidence:{source:'explicit-record' as const,eventId:'spawn-a'}},
   {id:'b',fromExecutionId:'p-1',toExecutionId:'p-2',kind:'dispatch' as const,evidence:{source:'explicit-record' as const,eventId:'spawn-b'}},
  ];
  render(<ResearchAgentCanvas clusters={clusters} relations={relations} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
  expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(2);
  expect(screen.getByRole('button',{name:'聚焦研究会话 2'}).getAttribute('data-depth')).toBe('2');
  expect(screen.getByRole('button',{name:'聚焦研究会话 2'}).textContent).toContain('创建者：研究会话 1');
  fireEvent.click(screen.getByRole('button',{name:'聚焦研究会话 2'}));
  fireEvent.click(screen.getByRole('button',{name:'返回创建者 研究会话 1'}));
  expect(screen.getByRole('button',{name:'查看 研究会话 1 会话详情'})).toBeTruthy();
 });
 it('uses explicit execution parents and keeps an unloaded creator distinct from user-created roots', () => {
  const clusters=makeClusters(3);
  clusters[1].sessionExec.parentExecutionId='p-0';
  clusters[2].sessionExec.parentExecutionId='unloaded-parent';
  render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={vi.fn()} statusLabel={label} roleLabel={label} />);
  expect(screen.getAllByTestId('canvas-parent-edge')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'聚焦研究会话 1'}).getAttribute('data-parent-id')).toBe('p-0');
  const detached=screen.getByRole('button',{name:'聚焦研究会话 2'});
  expect(detached.textContent).toContain('父会话未载入');
  expect(detached.textContent).not.toContain('我创建的');
 });
 it('spreads repeated runs inside the existing canvas, keeps details and collapses with Escape', () => {
  const clusters=makeClusters(1), group=clusters[0].childRoleGroups[0], onAgent=vi.fn();
  group.executions=[group.latest,{...group.latest,id:'earlier-run',status:'completed',prompt:'Earlier independent work'}];
  render(<ResearchAgentCanvas clusters={clusters} stale={false} onAgent={onAgent} statusLabel={label} roleLabel={label} />);
  fireEvent.click(screen.getByRole('button',{name:'聚焦研究会话 0'}));
  const role=screen.getByRole('button',{name:/展开 role-0 的 2 轮执行/});
  expect(role.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(role);
  const viewport=screen.getByTestId('research-canvas-viewport');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(within(viewport).getAllByRole('button',{name:/查看 role-0 第 .* 轮详情/})).toHaveLength(2);
  expect(role.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(within(viewport).getByRole('button',{name:'查看 role-0 第 1 轮详情'}));
  expect(onAgent).toHaveBeenLastCalledWith(group.roleObj,group.executions[1]);
  fireEvent.keyDown(role,{key:'Escape'});
  expect(role.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(role);
  expect(within(viewport).queryByRole('button',{name:'查看 role-0 第 1 轮详情'})).toBeNull();
  fireEvent.click(role);fireEvent.click(screen.getByRole('button',{name:'收起执行卡片'}));
  expect(role.getAttribute('aria-expanded')).toBe('false');
 });
});
