/** Stable geometry for the collaboration canvas. No relationships are inferred here. */
export interface CanvasNode { id: string; x: number; y: number; width: number; height: number }
export interface CanvasSessionNode extends CanvasNode { parentId: string | null; depth: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasView { x: number; y: number; scale: number }
export interface CanvasPoint { x: number; y: number }

const MARGIN = 36;
const SESSION_WIDTH = 246;
const SESSION_HEIGHT = 124;
const ROLE_WIDTH = 222;
const ROLE_HEIGHT = 82;
const COLUMN_GAP = 30;
const ROW_GAP = 24;
export const MIN_CANVAS_SCALE = 0.08;
export const MAX_CANVAS_SCALE = 2;

/** A compact grid: child executions are hidden until their parent is selected. */
export function layoutOverview(ids: string[], viewportWidth = Number.POSITIVE_INFINITY) {
  const targetWidth = Math.max(SESSION_WIDTH + MARGIN * 2, viewportWidth - 24);
  const widthColumns = Math.max(1, Math.floor((targetWidth - MARGIN * 2 + COLUMN_GAP) / (SESSION_WIDTH + COLUMN_GAP)));
  const columns = Math.min(4, widthColumns, Math.max(1, Math.ceil(Math.sqrt(ids.length))));
  const rows = Math.max(1, Math.ceil(ids.length / columns));
  const width = MARGIN * 2 + columns * SESSION_WIDTH + (columns - 1) * COLUMN_GAP;
  const top = 132;
  const nodes: CanvasNode[] = ids.map((id, index) => ({
    id, x: MARGIN + (index % columns) * (SESSION_WIDTH + COLUMN_GAP),
    y: top + Math.floor(index / columns) * (SESSION_HEIGHT + ROW_GAP),
    width: SESSION_WIDTH, height: SESSION_HEIGHT,
  }));
  return { nodes, hub: { id: 'workspace', x: (width - 188) / 2, y: 28, width: 188, height: 58 },
    width, height: top + rows * SESSION_HEIGHT + (rows - 1) * ROW_GAP + MARGIN };
}

/** Resolve only unambiguous, recorded creation edges. Handoffs are not ancestry. */
export function resolveSessionParents(ids: string[], relations: ReadonlyArray<{ fromExecutionId: string; toExecutionId: string; kind: string }>): Map<string, string> {
  const known = new Set(ids);
  const candidates = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.kind !== "dispatch" || relation.fromExecutionId === relation.toExecutionId
      || !known.has(relation.fromExecutionId) || !known.has(relation.toExecutionId)) continue;
    const parents = candidates.get(relation.toExecutionId) ?? new Set<string>();
    parents.add(relation.fromExecutionId);
    candidates.set(relation.toExecutionId, parents);
  }
  const parents = new Map<string, string>();
  for (const [id, choices] of candidates) if (choices.size === 1) parents.set(id, [...choices][0]);
  // Corrupt/legacy records must not create a cycle or an arbitrary parent in the UI.
  for (const id of ids) {
    const path: string[] = [];
    let current: string | undefined = id;
    while (current && parents.has(current)) {
      const cycleStart = path.indexOf(current);
      if (cycleStart !== -1) {
        for (const cyclic of path.slice(cycleStart)) parents.delete(cyclic);
        break;
      }
      path.push(current);
      current = parents.get(current);
    }
  }
  return parents;
}

/** Each recorded family is contiguous; unrelated roots retain their own column. */
export function layoutSessionHierarchy(ids: string[], recordedParents: ReadonlyMap<string, string>, viewportWidth = Number.POSITIVE_INFINITY) {
  const parents = resolveSessionParents(ids, [...recordedParents].map(([child, parent]) => ({ fromExecutionId: parent, toExecutionId: child, kind: "dispatch" })));
  if (parents.size === 0) {
    const scene = layoutOverview(ids, viewportWidth);
    return { ...scene, nodes: scene.nodes.map(node => ({ ...node, parentId: null, depth: 0 } as CanvasSessionNode)) };
  }
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = parents.get(id);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const roots = ids.filter(id => !parents.has(id));
  const families = roots.map(root => {
    const family: { id: string; depth: number }[] = [];
    const pending = [{ id: root, depth: 0 }];
    while (pending.length) {
      const member = pending.pop()!;
      family.push(member);
      for (const child of [...(children.get(member.id) ?? [])].reverse()) pending.push({ id: child, depth: member.depth + 1 });
    }
    return family;
  });
  const indent = viewportWidth < 500 ? 20 : 36;
  const familyWidth = SESSION_WIDTH + Math.max(...families.map(family => Math.max(...family.map(member => member.depth)))) * indent;
  const targetWidth = Math.max(familyWidth + MARGIN * 2, viewportWidth - 24);
  const columns = Math.min(3, roots.length, Math.max(1, Math.floor((targetWidth - MARGIN * 2 + COLUMN_GAP) / (familyWidth + COLUMN_GAP))));
  const width = MARGIN * 2 + columns * familyWidth + (columns - 1) * COLUMN_GAP;
  const laneBottoms = Array.from({ length: columns }, () => 132);
  const nodes: CanvasSessionNode[] = [];
  for (const family of families) {
    const lane = laneBottoms.indexOf(Math.min(...laneBottoms));
    const top = laneBottoms[lane];
    family.forEach((member, index) => nodes.push({
      id: member.id, parentId: parents.get(member.id) ?? null, depth: member.depth,
      x: MARGIN + lane * (familyWidth + COLUMN_GAP) + member.depth * indent,
      y: top + index * (SESSION_HEIGHT + ROW_GAP), width: SESSION_WIDTH, height: SESSION_HEIGHT,
    }));
    laneBottoms[lane] += family.length * (SESSION_HEIGHT + ROW_GAP) + 12;
  }
  return { nodes, hub: { id: 'workspace', x: (width - 188) / 2, y: 28, width: 188, height: 58 }, width, height: Math.max(...laneBottoms) - ROW_GAP - 12 + MARGIN };
}

export interface CanvasExpandedRole { roleId: string; executionIds: string[] }
const EXECUTION_HEIGHT = 154;

/** Expanded rounds participate in the same scene geometry and never cover a role. */
export function layoutFocusedSession(parentId: string, roleIds: string[], viewportWidth = Number.POSITIVE_INFINITY, expanded?: CanvasExpandedRole) {
  const expansion = expanded && roleIds.includes(expanded.roleId) ? expanded : undefined;
  const margin = 24;
  const executions: CanvasNode[] = [];
  if (viewportWidth < 500) {
    const width = 228 + margin * 2;
    const parent: CanvasNode = { id: parentId, x: margin, y: margin, width: 228, height: SESSION_HEIGHT };
    let top = parent.y + parent.height + 48;
    const children: CanvasNode[] = [];
    for (const id of roleIds) {
      children.push({ id, x: (width - ROLE_WIDTH) / 2, y: top, width: ROLE_WIDTH, height: ROLE_HEIGHT });
      top += ROLE_HEIGHT + 18;
      if (expansion?.roleId === id) {
        for (const executionId of expansion.executionIds) {
          executions.push({ id: executionId, x: (width - ROLE_WIDTH) / 2, y: top, width: ROLE_WIDTH, height: EXECUTION_HEIGHT });
          top += EXECUTION_HEIGHT + 18;
        }
        top += 12;
      }
    }
    const height = roleIds.length ? top - 18 + margin : parent.y + parent.height + margin;
    return { parent, children, executions, width, height, direction: "vertical" as const };
  }
  const childAreaHeight = roleIds.length ? roleIds.length * ROLE_HEIGHT + (roleIds.length - 1) * 18 : SESSION_HEIGHT;
  const executionColumns = viewportWidth >= 1200 ? 2 : 1;
  const executionRows = Math.ceil((expansion?.executionIds.length ?? 0) / executionColumns);
  const executionAreaHeight = executionRows ? executionRows * EXECUTION_HEIGHT + (executionRows - 1) * 18 : 0;
  const height = Math.max(220, childAreaHeight + margin * 2, executionAreaHeight + margin * 2);
  const parent: CanvasNode = { id: parentId, x: margin, y: (height - SESSION_HEIGHT) / 2, width: 228, height: SESSION_HEIGHT };
  const startX = parent.x + parent.width + 52;
  const children: CanvasNode[] = roleIds.map((id, index) => ({
    id, x: startX, y: (height - childAreaHeight) / 2 + index * (ROLE_HEIGHT + 18), width: ROLE_WIDTH, height: ROLE_HEIGHT,
  }));
  expansion?.executionIds.forEach((id, index) => executions.push({
    id, x: startX + ROLE_WIDTH + 52 + (index % executionColumns) * (ROLE_WIDTH + COLUMN_GAP),
    y: (height - executionAreaHeight) / 2 + Math.floor(index / executionColumns) * (EXECUTION_HEIGHT + 18),
    width: ROLE_WIDTH, height: EXECUTION_HEIGHT,
  }));
  const width = executions.length ? Math.max(...executions.map(node => node.x + node.width)) + margin
    : roleIds.length ? startX + ROLE_WIDTH + margin : parent.x + parent.width + margin;
  return { parent, children, executions, width, height, direction: "horizontal" as const };
}

export function fitGraph(scene: CanvasSize, viewport: CanvasSize, padding = 28): CanvasView {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const scale = Math.min(1.1, Math.max(MIN_CANVAS_SCALE, Math.min(
    Math.max(1, width - padding * 2) / Math.max(1, scene.width),
    Math.max(1, height - padding * 2) / Math.max(1, scene.height),
  )));
  return { scale, x: (width - scene.width * scale) / 2, y: (height - scene.height * scale) / 2 };
}

/** Zoom about the pointer, preserving the same world point under it. */
export function zoomGraphAt(view: CanvasView, point: CanvasPoint, factor: number): CanvasView {
  const scale = Math.min(MAX_CANVAS_SCALE, Math.max(MIN_CANVAS_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}
