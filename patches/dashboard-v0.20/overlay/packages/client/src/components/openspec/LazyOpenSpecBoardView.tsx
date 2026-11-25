import { lazy, Suspense } from "react";
import { t as i18nT } from "../../lib/i18n/i18n.js";
import type { OpenSpecBoardViewProps } from "./OpenSpecBoardView.js";

const OpenSpecBoardView = lazy(() =>
  import("./OpenSpecBoardView.js").then((m) => ({ default: m.OpenSpecBoardView })),
);

/** Board loading must not suspend the surrounding shell or frozen underlay. */
export function LazyOpenSpecBoardView(props: OpenSpecBoardViewProps) {
  return (
    <Suspense fallback={
      <div role="status" className="flex flex-1 min-h-0 items-center justify-center text-sm text-[var(--text-tertiary)]">
        {i18nT("common.loading2", undefined, "Loading…")}
      </div>
    }>
      <OpenSpecBoardView {...props} />
    </Suspense>
  );
}
