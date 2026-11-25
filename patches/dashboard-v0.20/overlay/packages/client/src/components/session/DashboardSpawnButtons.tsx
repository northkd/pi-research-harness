/**
 * Elevated dashboard-scope spawn-button stack for the sidebar.
 *
 * Renders full-width stacked line buttons mirroring `FolderSpawnButtons`:
 *   - `+ Add Folder` (`--tint-blue-*`) — always rendered; pins a top-level folder
 *     (dashboard scope) or adds a folder to a workspace (workspace scope).
 *   - `+ New Workspace` (neutral) — rendered only when `onNewWorkspace` is
 *     provided.
 *
 * Dashboard scope: rendered as the first item in the scroll list.
 * Workspace scope: rendered Add-Folder-only at the bottom of each expanded
 * workspace body.
 *
 * See change: elevate-dashboard-add-buttons; align-ui-with-theme-tokens (tints,
 * 12 px text, 44/32 px targets, focus-ring).
 */

import { mdiFolderPlus, mdiViewGridPlus } from "@mdi/js";
import { Icon } from "@mdi/react";
import { t as i18nT } from "../../lib/i18n/i18n.js";

interface Props {
  /** Disables `+ Add Folder` (e.g. while a pin is in flight). */
  addFolderDisabled?: boolean;
  onAddFolder: () => void;
  /** When provided, renders the `+ New Workspace` button below Add Folder. */
  onNewWorkspace?: () => void;
  /** `data-testid` for the Add Folder button. Defaults to dashboard scope. */
  addFolderTestId?: string;
}

export function DashboardSpawnButtons({
  addFolderDisabled,
  onAddFolder,
  onNewWorkspace,
  addFolderTestId = "dashboard-add-folder-btn",
}: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onAddFolder(); }}
        disabled={addFolderDisabled}
        data-testid={addFolderTestId}
        className={`focus-ring flex-1 min-w-0 h-7 text-[11px] font-medium px-2 py-0.5 rounded-lg border flex items-center justify-center gap-1 whitespace-nowrap transition-colors ${
          addFolderDisabled
            ? "border-[var(--border-subtle)] text-[var(--text-secondary)] opacity-50 cursor-not-allowed"
            : "border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-primary)]"
        }`}
        title={i18nT("folders.addAFolder", undefined, "Add a folder")}
      >
        <Icon path={mdiFolderPlus} size={0.55} className="text-[var(--accent-text)] shrink-0" />
        <span className="truncate">{i18nT("folders.addFolder", undefined, "Add Folder")}</span>
      </button>

      {onNewWorkspace && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNewWorkspace(); }}
          data-testid="dashboard-new-workspace-btn"
          className="focus-ring flex-1 min-w-0 h-7 text-[11px] font-medium px-2 py-0.5 rounded-lg border flex items-center justify-center gap-1 whitespace-nowrap transition-colors border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-primary)]"
          title={i18nT("folders.newWorkspace3", undefined, "New workspace")}
        >
          <Icon path={mdiViewGridPlus} size={0.55} className="text-[var(--text-secondary)] shrink-0" />
          <span className="truncate">{i18nT("folders.newWorkspace2", undefined, "New Workspace")}</span>
        </button>
      )}
    </div>
  );
}
