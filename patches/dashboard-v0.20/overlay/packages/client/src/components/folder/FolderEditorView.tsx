/**
 * Folder-scoped internal Monaco editor pane.
 *
 * Replaces the removed external `EditorView` (code-server iframe). Mounts the
 * in-browser `EditorPane` rooted at a folder `cwd` instead of a session, by
 * wrapping it in a `FolderSplitProvider` (`SplitWorkspaceProvider` keyed by `folderPaneId(cwd)`).
 *
 * It deliberately omits the session-bound wiring: no `onWatchFiles`
 * (changed-on-disk banner), no `fileResults`, no `changedFiles`. There is no
 * session WS to attach a server file-watch to in folder scope, so the banner
 * simply never appears; a manual Refresh reloads a tab's content (Non-Goal v1).
 *
 * It IS the folder-level terminal surface (replacing the removed `TerminalsView`):
 * `autoSurfaceTerminals` opens a `term:<id>` tab for every non-ephemeral terminal
 * at the folder cwd. See change: terminals-in-tabbed-panes.
 *
 * See change: remove-external-editor-integration.
 */

import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { saveSplitState } from "../../lib/layout/split-state.js";
import { buildFolderHomeUrl } from "../../lib/nav/route-builders.js";
import { EditorPane } from "../editor-pane/EditorPane.js";
import { useSplitWorkspace } from "../split/SplitWorkspaceContext.js";
import { WorkspaceNavigation, WorkspaceTools } from "../split/WorkspaceNavigation.js";
import { FolderSplitProvider } from "./FolderSplitProvider.js";

interface Props {
  cwd: string;
  onClose?: () => void;
  /** cwd-scoped terminals (ephemeral filtered in the pane). */
  terminals?: TerminalSession[];
  onCreateTerminal?: (cwd: string) => void;
  onKillTerminal?: (terminalId: string) => void;
  onRenameTerminal?: (terminalId: string, title: string) => void;
  onTerminalTitle?: (terminalId: string, title: string) => void;
  /** One-shot terminal-focused entry from `?focus=terminal`. See change:
   *  fix-terminals-action-opens-terminal. */
  focusTerminal?: boolean;
  /** Terminal snapshot applied (`snapshotGeneration > 0`) — the readiness gate. */
  terminalsReady?: boolean;
  /** Fired once the one-shot is honoured (URL param consumption). */
  onFocusConsumed?: () => void;
  /** Open the research tab once on mount (mobile `/folder/:cwd/research`). */
  openResearch?: boolean;
}

/** One-shot research open under the folder provider. */
function ResearchOpenOnce() {
  const { openResearch } = useSplitWorkspace();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    openResearch();
  }, [openResearch]);
  return null;
}

function FolderWorkspaceView({ onOpenConversation }: { onOpenConversation: () => void }) {
  const { sessionId, cwd, split, setMode } = useSplitWorkspace();
  const revealed = useRef(false);
  // A direct editor route is an explicit reveal, even if the same folder's
  // home page last stored a chat-only layout.
  useEffect(() => { setMode("full"); }, [cwd, setMode]);
  useEffect(() => {
    if (split.mode !== "closed") revealed.current = true;
    else if (revealed.current) {
      // Toolbar/Layout close also leaves this route. Commit before navigation:
      // the receiving folder provider can mount before this provider's effects.
      saveSplitState(sessionId, split);
      onOpenConversation();
    }
  }, [sessionId, split, onOpenConversation]);
  return <div className="workspace-shell flex min-h-0 min-w-0 flex-1 flex-col h-full">
    <WorkspaceNavigation folder onOpenConversation={onOpenConversation} />
    <EditorPane workspaceChrome />
    <WorkspaceTools />
  </div>;
}

export function FolderEditorView({
  cwd,
  terminals,
  onCreateTerminal,
  onKillTerminal,
  onRenameTerminal,
  onTerminalTitle,
  focusTerminal,
  terminalsReady,
  onFocusConsumed,
  openResearch = false,
}: Props) {
  const [, navigate] = useLocation();
  return (
    <FolderSplitProvider
      cwd={cwd}
      terminals={terminals}
      onCreateTerminal={onCreateTerminal}
      onKillTerminal={onKillTerminal}
      onRenameTerminal={onRenameTerminal}
      onTerminalTitle={onTerminalTitle}
      focusTerminal={focusTerminal}
      terminalsReady={terminalsReady}
      onFocusConsumed={onFocusConsumed}
    >
      {openResearch && <ResearchOpenOnce />}
      <FolderWorkspaceView onOpenConversation={() => navigate(buildFolderHomeUrl(cwd))} />
    </FolderSplitProvider>
  );
}
