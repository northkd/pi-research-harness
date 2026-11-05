/** Browser-local presentation only. Never changes server folder/session state. */
export type SessionNavigationDensity = "compact" | "comfortable";

export interface SessionNavigationPreferences {
  density: SessionNavigationDensity;
  utilitiesOpen: boolean;
  expandedProjectTools: string[];
}

const STORAGE_KEY = "pi-dashboard-session-navigation";

export function readSessionNavigationPreferences(): SessionNavigationPreferences {
  const defaults: SessionNavigationPreferences = { density: "compact", utilitiesOpen: false, expandedProjectTools: [] };
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return defaults;
    return {
      density: value.density === "comfortable" ? "comfortable" : "compact",
      utilitiesOpen: value.utilitiesOpen === true,
      expandedProjectTools: Array.isArray(value.expandedProjectTools)
        ? value.expandedProjectTools.filter((cwd: unknown): cwd is string => typeof cwd === "string")
        : [],
    };
  } catch {
    return defaults;
  }
}

export function writeSessionNavigationPreferences(prefs: SessionNavigationPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable in private/embedded contexts; the current
    // in-memory preference still works and never blocks session navigation.
  }
}
