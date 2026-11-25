/**
 * Detached spawn tray for folder groups in the sidebar.
 *
 * Renders two spawn buttons in a Create tray positioned OUTSIDE the directory
 * card's bordered surface (a sibling below the card — see
 * `SessionList.renderGroup`):
 *   - `+ New Session` (`--tint-green-*`) — always rendered.
 *   - `+ New Worktree` (`--tint-orange-*`) — rendered only when `showWorktree` holds.
 *
 * A responsive grid: two columns when the worktree button shows, collapsing to
 * a single column at the mobile breakpoint. Props + `data-testid`s unchanged.
 *
 * See change: elevate-folder-spawn-buttons; redesign-directory-card (D3);
 * align-ui-with-theme-tokens (identity tints, D2).
 */

import { mdiPlus, mdiSourceBranchPlus } from "@mdi/js";
import { Icon } from "@mdi/react";
import { t as i18nT } from "../../lib/i18n/i18n.js";
import { AgentSpawnPicker } from "../AgentSpawnPicker.js";

interface Props {
  /** The folder this tray spawns into (keys the remembered agent). */
  cwd?: string;
  /** Disables `+ New Session` while a session is being spawned in this folder. */
  spawningDisabled?: boolean;
  /**
   * Whether to render `+ New Worktree`. Caller computes
   * `isGitRepo && gitWorktreeEnabled && !!onSpawnWorktree`.
   */
  showWorktree: boolean;
  /** `agent` = configured ACP agent id; absent → pi (today's call, byte-identical). */
  onSpawnSession: (agent?: string) => void;
  onSpawnWorktree?: () => void;
}

export function FolderSessionSpawnButton({
  cwd = "",
  spawningDisabled,
  onSpawnSession,
}: {
  cwd?: string;
  spawningDisabled?: boolean;
  onSpawnSession: (agent?: string) => void;
}) {
  return (
    /* Agent picker: renders THIS plain icon button unchanged when no ACP agent is configured.
        See change: add-acp-session-driver (D16). */
    <AgentSpawnPicker
      cwd={cwd}
      compact
      onSpawn={onSpawnSession}
      disabled={spawningDisabled}
      testId="folder-spawn-session-btn"
      className={`focus-ring inline-flex items-center justify-center w-6 h-6 rounded-md border ${
        spawningDisabled
          ? "border-transparent text-[var(--text-secondary)] opacity-50 cursor-not-allowed"
          : "border-transparent text-[var(--text-secondary)] hover:text-[var(--accent-text)] hover:bg-[var(--bg-hover)]"
      }`}
      title={i18nT("session.newPiSession", undefined, "New pi session")}
    >
      <Icon path={mdiPlus} size={0.58} />
      <span className="sr-only">{i18nT("session.newSession2", undefined, "New Session")}</span>
    </AgentSpawnPicker>
  );
}

export function FolderWorktreeSpawnButton({
  onSpawnWorktree,
}: {
  onSpawnWorktree: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSpawnWorktree(); }}
      data-testid="folder-spawn-worktree-btn"
      aria-label={i18nT("worktree.newWorktree2", undefined, "New Worktree")}
      className="focus-ring inline-flex items-center justify-center w-6 h-6 rounded-md border border-transparent text-[var(--text-secondary)] hover:text-[var(--accent-text)] hover:bg-[var(--bg-hover)]"
      title={i18nT("git.newPiSessionInAGit", undefined, "New pi session in a git worktree")}
    >
      <Icon path={mdiSourceBranchPlus} size={0.55} />
      <span className="sr-only">{i18nT("worktree.newWorktree2", undefined, "New Worktree")}</span>
    </button>
  );
}

export function FolderSpawnButtons({
  cwd = "",
  spawningDisabled,
  showWorktree,
  onSpawnSession,
  onSpawnWorktree,
}: Props) {
  return (
    <div className="inline-flex items-center gap-0.5 shrink-0">
      {showWorktree && onSpawnWorktree && (
        <FolderWorktreeSpawnButton onSpawnWorktree={onSpawnWorktree} />
      )}
      <FolderSessionSpawnButton
        cwd={cwd}
        spawningDisabled={spawningDisabled}
        onSpawnSession={onSpawnSession}
      />
    </div>
  );
}
