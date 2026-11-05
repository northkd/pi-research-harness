import { useState, useCallback } from "react";

const WIDTH_KEY = "dashboard:sidebar-width";
const COLLAPSED_KEY = "dashboard:sidebar-collapsed";
const DEFAULT_WIDTH = 248;
const MIN_WIDTH = 180;
const MAX_WIDTH = 500;

function clamp(value: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

export interface SidebarState {
  width: number;
  collapsed: boolean;
  setWidth: (w: number) => void;
  toggleCollapse: () => void;
}

export function useSidebarState(): SidebarState {
  const [width, setWidthRaw] = useState(() => clamp(readNumber(WIDTH_KEY, DEFAULT_WIDTH)));
  const [collapsed, setCollapsed] = useState(() => readBoolean(COLLAPSED_KEY, false));

  const setWidth = useCallback((w: number) => {
    const clamped = clamp(w);
    setWidthRaw(clamped);
    try { localStorage.setItem(WIDTH_KEY, String(clamped)); } catch { /* noop */ }
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  return { width, collapsed, setWidth, toggleCollapse };
}

// Exported for testing
export { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, WIDTH_KEY, COLLAPSED_KEY };
