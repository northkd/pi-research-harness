/**
 * Research workbench as an editor-pane tab.
 *
 * Padding-free wrapper: the pane already owns the tab strip and chrome, so the
 * page renders with `embedded` (no duplicate back button) and closes its own
 * tab when the in-page back control is used.
 */
import { scienceArtifactTabPath } from "@blackbelt-technology/pi-dashboard-shared/science-paths.js";
import type { ViewerProps } from "../editor-pane/types.js";
import { useSplitWorkspace } from "../split/SplitWorkspaceContext.js";
import { ResearchPipelinePage } from "./ResearchPipelinePage.js";
import { ResearchSourceViewer } from "./ResearchSourceViewer.js";

export function ResearchTabViewer({ cwd, path }: ViewerProps) {
  const { sessionId, paneState, dispatch, openInSplit, openScience, researchChangeSignal, connectionGeneration, resyncWatch } = useSplitWorkspace();
  const close = () => {
    const index = paneState.openFiles.findIndex((f) => f.path === path);
    if (index >= 0) dispatch({ type: "closeTab", index });
  };
  if (path !== "research:") return <ResearchSourceViewer cwd={cwd} path={path} />;
  return (
    <div data-testid="research-workspace-pane" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ResearchPipelinePage
        cwd={cwd}
        onBack={close}
        embedded
        activeSessionId={sessionId}
        refreshSignal={researchChangeSignal}
        connectionGeneration={connectionGeneration}
        resyncWatch={resyncWatch}
        onOpenArtifact={openInSplit}
        onOpenScience={openScience}
        onOpenScienceArtifact={(taskId, artifactId) => dispatch({ type: "openFile", path: scienceArtifactTabPath(taskId, artifactId), viewer: "science" })}
        onOpenSource={(adoptionId, sourceId) => dispatch({ type: "openFile", path: `research:source/${adoptionId}/${sourceId}`, viewer: "research" })}
      />
    </div>
  );
}
