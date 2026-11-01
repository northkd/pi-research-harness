import { lazy } from "react";
import type { ViewerProps } from "../editor-pane/types.js";
import { ScienceViewer } from "./ScienceViewer.js";

const ScienceArtifactViewer = lazy(() => import("./ScienceArtifactViewer.js").then(module => ({ default: module.ScienceArtifactViewer })));

/** Built-in pseudo-tab: no PluginTabHost or Pi session is required. */
export function ScienceTabViewer({ cwd, path }: ViewerProps) {
  if (path.startsWith("science:artifact:")) return <ScienceArtifactViewer cwd={cwd} path={path} />;
  return <ScienceViewer cwd={cwd} path={path} />;
}
