/** Stable geometry for the collaboration canvas. No relationships are inferred here. */
export interface CanvasNode { id: string; x: number; y: number; width: number; height: number }
export interface CanvasSessionNode extends CanvasNode { parentId: string | null; depth: number; gridCol?: number; gridRow?: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasView { x: number; y: number; scale: number }
export interface CanvasPoint { x: number; y: number }

const MARGIN = 24;
const SESSION_WIDTH = 252;
const SESSION_HEIGHT = 112;
const ROLE_WIDTH = 244;
const ROLE_HEIGHT = 108;
const COLUMN_GAP = 20;
const ROW_GAP = 14;
const GRID_ROW_GAP = 18;
const GRID_COL_GAP = 20;
const LEVEL_GAP = 48;
export const MIN_CANVAS_SCALE = 0.08;
export const MAX_CANVAS_SCALE = 2;

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
  const familyWidth = SESSION_WIDTH + Math.max(0, ...families.flatMap(family => family.map(member => member.depth))) * indent;
  const targetWidth = Math.max(familyWidth + MARGIN * 2, viewportWidth - 24);
  const columns = Math.max(1, Math.min(3, roots.length, Math.floor((targetWidth - MARGIN * 2 + COLUMN_GAP) / (familyWidth + COLUMN_GAP))));
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
  return { nodes, hub: { id: 'workspace', x: (width - 188) / 2, y: 28, width: 188, height: 58 }, width, height: Math.max(132, Math.max(...laneBottoms) - ROW_GAP - 12 + MARGIN) };
}

/** Fit a fan-out group into a target world width: total (children-row) width must
 *  stay <= target so more siblings land per row when the canvas can show more.
 *  Clamped to [minCols, leaves.length] so a wide canvas still wraps sane groups.
 *  See change: canvas-topology-zoom-aware-columns. */
function fitLeafColumns(leaves: number, siblingWidth: number, targetWidth: number, minCols = 1): number {
  if (leaves <= 1) return 1;
  const perColumn = siblingWidth + GRID_COL_GAP;
  // Each additional column adds one siblingWidth of content; keep the row(s) within target.
  const maxCols = Math.max(1, Math.floor((Math.max(targetWidth, siblingWidth) + GRID_COL_GAP) / perColumn));
  return Math.max(minCols, Math.min(leaves, maxCols));
}

/** Keep each subtree contiguous. On horizontal trees wrap large leaf fan-outs into columns
 * so the graph stays compact and readable at 100% zoom without shrinking tiny cards.
 * `targetWidth` is the world-space width the caller can show at its current zoom;
 * sibling groups fill it column-by-column so a zoomed-out canvas shows more agents
 * per row instead of forcing a long vertical scroll. */
export function layoutSessionTree(ids: string[], parents: ReadonlyMap<string, string>, horizontal: boolean, viewportWidth = 960, targetWidth = viewportWidth) {
  const visible = new Set(ids);
  const children = new Map<string, string[]>();
  const roots = ids.filter(id => {
    const parent = parents.get(id);
    if (!parent || !visible.has(parent)) return true;
    const siblings = children.get(parent) ?? [];
    siblings.push(id);
    children.set(parent, siblings);
    return false;
  });
  const nodes: CanvasSessionNode[] = [];
  let cursorY = MARGIN;
  const place = (id: string, depth: number, parentId: string | null) => {
    const x = MARGIN + depth * (horizontal ? SESSION_WIDTH + LEVEL_GAP : 22);
    const descendants = children.get(id) ?? [];
    if (!horizontal || descendants.length === 0) {
      const y = cursorY;
      cursorY += SESSION_HEIGHT + ROW_GAP;
      nodes.push({ id, depth, parentId, x, y, width: SESSION_WIDTH, height: SESSION_HEIGHT });
      for (const child of descendants) place(child, depth + 1, id);
      return;
    }

    const idx = nodes.length;
    nodes.push({ id, depth, parentId, x, y: cursorY, width: SESSION_WIDTH, height: SESSION_HEIGHT });

    const leaves = descendants.filter(childId => (children.get(childId)?.length ?? 0) === 0);
    const branches = descendants.filter(childId => (children.get(childId)?.length ?? 0) > 0);
    if (leaves.length >= 2 && viewportWidth >= 620) {
      // Columns scale with the world width available at the current zoom, not a
      // fixed viewport breakpoint: zooming out widens the world viewport, so more
      // siblings fit per row and the whole fan-out stays visible. Large fan-outs
      // keep the historical 2-column floor at 100%; small ones start at 1 and
      // only fan out horizontally once the zoom-out gives them room.
      const minCols = leaves.length >= 5 ? 2 : 1;
      const leafCols = fitLeafColumns(leaves.length, SESSION_WIDTH, targetWidth - (x + SESSION_WIDTH + LEVEL_GAP), minCols);
      const childBaseX = x + SESSION_WIDTH + LEVEL_GAP;
      const gridStartY = cursorY;
      leaves.forEach((leafId, index) => {
        const col = index % leafCols;
        const rowIndex = Math.floor(index / leafCols);
        nodes.push({
          id: leafId,
          depth: depth + 1,
          parentId: id,
          x: childBaseX + col * (SESSION_WIDTH + GRID_COL_GAP),
          y: gridStartY + rowIndex * (SESSION_HEIGHT + GRID_ROW_GAP),
          width: SESSION_WIDTH,
          height: SESSION_HEIGHT,
          gridCol: col,
          gridRow: rowIndex,
        });
      });
      const leafRows = Math.ceil(leaves.length / leafCols);
      cursorY = gridStartY + leafRows * SESSION_HEIGHT + (leafRows - 1) * GRID_ROW_GAP + ROW_GAP;
      for (const child of branches) place(child, depth + 1, id);
    } else {
      for (const child of descendants) place(child, depth + 1, id);
    }

    const directChildren = descendants
      .map(childId => nodes.find(node => node.id === childId))
      .filter((child): child is CanvasSessionNode => Boolean(child));
    if (directChildren.length > 0) {
      const minChildY = Math.min(...directChildren.map(child => child.y));
      const maxChildY = Math.max(...directChildren.map(child => child.y));
      const parentY = descendants.length > 3
        ? minChildY
        : Math.round((minChildY + maxChildY) / 2);
      nodes[idx] = { ...nodes[idx], y: parentY };
      cursorY = Math.max(cursorY, parentY + SESSION_HEIGHT + ROW_GAP);
    }
  };
  for (const id of roots) place(id, 0, null);
  return {
    nodes,
    hub: null,
    width: (nodes.length ? Math.max(...nodes.map(node => node.x + node.width)) : SESSION_WIDTH) + MARGIN,
    height: (nodes.length ? Math.max(...nodes.map(node => node.y + node.height)) : SESSION_HEIGHT) + MARGIN,
  };
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
