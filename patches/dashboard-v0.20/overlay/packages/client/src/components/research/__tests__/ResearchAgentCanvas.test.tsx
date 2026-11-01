import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchAgentCanvas } from '../ResearchAgentCanvas.js';
import type { ResearchExecution } from '../research-projection.js';

function makeClusters(count = 16) {
  return Array.from({length: count}, (_, i) => {
    const parent: ResearchExecution = {id:`p-${i}`,kind:'pi-session',status:'idle',source:'observation',evidence:[],prompt:`会话 ${i} 的任务`};
    const children = Array.from({length: 8}, (_, j): ResearchExecution => ({id:`c-${i}-${j}`,kind:'native-subagent',parentExecutionId:parent.id,role:`role-${j}`,status:j===0?'running':'completed',source:'observation',evidence:[]}));
    return {sessionExec:parent,title:`研究会话 ${i}`,roleObj:{name:`session-${i}`,skills:[]},isCaptain:i===0,childSubs:children,childRoleGroups:children.map(c=>({roleName:c.role!,roleObj:{name:c.role!,skills:[]},executions:[c],latest:c}))};
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
