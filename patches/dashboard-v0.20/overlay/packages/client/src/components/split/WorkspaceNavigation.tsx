/** Task-oriented navigation over the existing pane state. No parallel sessions,
 * editor instances or plugin registries are created by a view change. */
import { mdiAccountGroupOutline, mdiChevronDown, mdiConsoleLine, mdiFileDocumentOutline, mdiFlaskOutline, mdiFolderOutline, mdiMessageOutline, mdiViewDashboardOutline, mdiWeb } from "@mdi/js";
import { Icon } from "@mdi/react";
import { useShellSessionOrNull } from "@blackbelt-technology/dashboard-plugin-runtime";
import { SpeedIndicator } from "@blackbelt-technology/pi-dashboard-speed-plugin";
import { Link } from "wouter";
import { useEffect, useRef, type RefObject } from "react";
import { useI18n } from "../../lib/i18n/i18n.js";
import { saveSplitState } from "../../lib/layout/split-state.js";
import { LayoutModeSwitch } from "./LayoutModeSwitch.js";
import { useSplitWorkspace } from "./SplitWorkspaceContext.js";

type View = "chat" | "workbench" | "agents" | "files" | "science";

function useDismissDetails(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ref.current?.open) return;
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
      event.stopPropagation();
    };
    const onOutside = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onOutside); };
  }, [ref]);
}

export function WorkspaceNavigation({ folder = false, onOpenConversation }: { folder?: boolean; onOpenConversation?: () => void }) {
  const ctx = useSplitWorkspace();
  const session = useShellSessionOrNull(ctx.sessionId);
  const { t } = useI18n();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const layoutRef = useRef<HTMLDetailsElement>(null);
  useDismissDetails(layoutRef);
  const activeTab = ctx.paneState.openFiles[ctx.paneState.activeIndex];
  const active: View = ctx.split.mode === "closed" ? "chat"
    : activeTab?.path === "research:" ? (ctx.researchSurface === "agents" ? "agents" : "workbench")
    : activeTab?.viewer === "science" ? "science" : "files";
  const items: Array<{ id: View; label: string; icon: string }> = [
    { id: "chat", label: folder ? t("workspace.start", undefined, "New conversation") : t("workspace.chat", undefined, "Chat"), icon: mdiMessageOutline },
    { id: "workbench", label: t("workspace.workbench", undefined, "Research workbench"), icon: mdiViewDashboardOutline },
    { id: "agents", label: t("workspace.agents", undefined, "Agents"), icon: mdiAccountGroupOutline },
    { id: "files", label: t("common.files", undefined, "Files"), icon: mdiFolderOutline },
    { id: "science", label: "Science", icon: mdiFlaskOutline },
  ];
  const select = (id: View) => {
    if (layoutRef.current) layoutRef.current.open = false;
    if (id === "chat") {
      ctx.setMode("closed");
      if (onOpenConversation) {
        // A route callback can unmount this provider before its persistence
        // effect runs. The destination must already see the conversation layout.
        saveSplitState(ctx.sessionId, { ...ctx.split, mode: "closed" });
        onOpenConversation();
      }
      return;
    }
    if (!ctx.cwd) return;
    if (id === "workbench" || id === "agents") ctx.openResearch(id);
    else if (id === "science") ctx.openScience();
    else ctx.openFiles?.();
    ctx.setMode("full");
  };
  return (
    <div className="workspace-navigation" data-testid="workspace-navigation">
      <div className="workspace-view-tabs" role="tablist" aria-label={t("workspace.views", undefined, "Workspace views")}>
        {items.map((item, index) => (
          <button key={item.id} ref={el => { refs.current[index] = el; }} type="button" role="tab"
            aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1}
            disabled={item.id !== "chat" && !ctx.cwd} data-testid={`workspace-view-${item.id}`}
            onClick={() => select(item.id)} onKeyDown={event => {
              let next: number | null = null;
              if (event.key === "ArrowRight") next = (index + 1) % items.length;
              if (event.key === "ArrowLeft") next = (index + items.length - 1) % items.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = items.length - 1;
              if (next !== null) { event.preventDefault(); refs.current[next]?.focus(); select(items[next].id); }
            }}>
            <Icon path={item.icon} size={0.68} /><span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="workspace-usage">
        {session && <SpeedIndicator sessionId={session.id} sessionStatus={session.status} costOnly align="right" />}
        <Link href="/settings/billing" className="workspace-billing-link" title={t("settings.billing", undefined, "Billing statistics")}>
          {t("workspace.billingReport", undefined, "Monthly usage")}
        </Link>
      </div>
      <details ref={layoutRef} className="workspace-layout-menu">
        <summary><span>{t("workspace.layout", undefined, "Layout")}</span><Icon path={mdiChevronDown} size={0.6} /></summary>
        <div className="workspace-layout-options">
          <LayoutModeSwitch />
          <span className="workspace-layout-hint">{t("workspace.splitHint", undefined, "Show chat beside the current view")}</span>
          <div className="workspace-ratios">
            {[0.65, 0.5, 0.35].map(ratio => <button key={ratio} type="button"
              onClick={() => ctx.updateSplit({ mode: "split", ratio })}
              aria-label={`${Math.round(ratio * 100)}:${Math.round((1 - ratio) * 100)}`}>
              {Math.round(ratio * 100)} : {Math.round((1 - ratio) * 100)}
            </button>)}
          </div>
        </div>
      </details>
    </div>
  );
}

/** Existing terminals and browser tabs remain owned by their original hosts. */
export function WorkspaceTools() {
  const ctx = useSplitWorkspace();
  const { t } = useI18n();
  const terminalMenuRef = useRef<HTMLDetailsElement>(null);
  useDismissDetails(terminalMenuRef);
  const browsers = ctx.paneState.openFiles.filter(file => file.viewer === "plugin" && file.path.startsWith("browser:"));
  const openBrowser = () => {
    const path = browsers[0]?.path;
    if (path && ctx.openPluginTab(path)) ctx.ensureRevealed();
  };
  return (
    <footer className="workspace-tools" data-testid="workspace-tools" aria-label={t("workspace.tools", undefined, "Workspace tools")}>
      <details ref={terminalMenuRef} className="workspace-terminal-menu">
        <summary><Icon path={mdiConsoleLine} size={0.62} />{t("workspace.terminal", undefined, "Terminal")}
          {ctx.terminal.terminals.length > 0 && <span className="workspace-tool-count">{ctx.terminal.terminals.length}</span>}
        </summary>
        <div className="workspace-terminal-options">
          {ctx.terminal.terminals.map(terminal => <button key={terminal.id} type="button"
            onClick={event => { ctx.terminal.openTerminal(terminal.id); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
            <Icon path={mdiConsoleLine} size={0.6} /><span>{terminal.title || terminal.shell?.split("/").pop() || terminal.id}</span>
          </button>)}
          <button type="button" disabled={!ctx.cwd} onClick={event => { ctx.terminal.createTerminal(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
            + {t("terminal.newTerminal", undefined, "New Terminal")}
          </button>
        </div>
      </details>
      <button type="button" onClick={openBrowser} disabled={!browsers.length}
        title={browsers.length ? t("workspace.browserRestore", undefined, "Restore an open browser tab") : t("workspace.browserEmpty", undefined, "No open tabs; use the session browser action when a browser is running") }>
        <Icon path={mdiWeb} size={0.62} />{t("workspace.browser", undefined, "Browser")}{browsers.length > 0 && <span className="workspace-tool-count">{browsers.length}</span>}
      </button>
      <button type="button" disabled={!ctx.cwd} onClick={() => ctx.openInSplit(".pi/research-loop/events.jsonl")}>
        <Icon path={mdiFileDocumentOutline} size={0.62} />{t("workspace.logs", undefined, "Research log")}
      </button>
      <span className="workspace-scope" title={ctx.cwd}>{ctx.cwd}</span>
    </footer>
  );
}
