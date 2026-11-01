/** Stable geometry for the collaboration canvas. No relationships are inferred here. */
export interface CanvasNode { id: string; x: number; y: number; width: number; height: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasView { x: number; y: number; scale: number }
export interface CanvasPoint { x: number; y: number }

const MARGIN = 36;
const SESSION_WIDTH = 246;
const SESSION_HEIGHT = 108;
const ROLE_WIDTH = 222;
const ROLE_HEIGHT = 82;
const COLUMN_GAP = 30;
const ROW_GAP = 24;
export const MIN_CANVAS_SCALE = 0.08;
export const MAX_CANVAS_SCALE = 2;

/** A compact grid: child executions are hidden until their parent is selected. */
export function layoutOverview(ids: string[], viewportWidth = Number.POSITIVE_INFINITY) {
  const targetWidth = Math.max(SESSION_WIDTH + MARGIN * 2, (viewportWidth - 24) / 0.8);
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

/** Only the selected parent's observed role groups are laid out. */
export function layoutFocusedSession(parentId: string, roleIds: string[], viewportWidth = Number.POSITIVE_INFINITY) {
  if (viewportWidth < 500) {
    const margin = 24, width = 228 + margin * 2;
    const parent: CanvasNode = { id: parentId, x: margin, y: margin, width: 228, height: SESSION_HEIGHT };
    const top = parent.y + parent.height + 48;
    const children: CanvasNode[] = roleIds.map((id, index) => ({
      id, x: (width - ROLE_WIDTH) / 2, y: top + index * (ROLE_HEIGHT + 18), width: ROLE_WIDTH, height: ROLE_HEIGHT,
    }));
    const height = roleIds.length ? top + roleIds.length * ROLE_HEIGHT + (roleIds.length - 1) * 18 + margin : parent.y + parent.height + margin;
    return { parent, children, width, height, direction: "vertical" as const };
  }
  const columns = 1;
  const rows = roleIds.length;
  const margin = 24;
  const childAreaHeight = rows ? rows * ROLE_HEIGHT + (rows - 1) * 18 : SESSION_HEIGHT;
  const height = Math.max(220, childAreaHeight + margin * 2);
  const parent: CanvasNode = { id: parentId, x: margin, y: (height - SESSION_HEIGHT) / 2, width: 228, height: SESSION_HEIGHT };
  const startX = parent.x + parent.width + 52;
  const children: CanvasNode[] = roleIds.map((id, index) => ({
    id, x: startX + (index % columns) * (ROLE_WIDTH + COLUMN_GAP),
    y: (height - childAreaHeight) / 2 + Math.floor(index / columns) * (ROLE_HEIGHT + 18),
    width: ROLE_WIDTH, height: ROLE_HEIGHT,
  }));
  const width = roleIds.length ? startX + ROLE_WIDTH + margin : parent.x + parent.width + margin;
  return { parent, children, width, height, direction: "horizontal" as const };
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
