import { type ComponentProps, lazy, Suspense } from "react";
import { t as i18nT } from "../../lib/i18n/i18n.js";

type Props = ComponentProps<typeof import("./DirectorySettings.js").DirectorySettings>;

const DirectorySettings = lazy(() =>
  import("./DirectorySettings.js").then((m) => ({ default: m.DirectorySettings })),
);

/** Keep loading inside the settings surface in every shell layout. */
export function LazyDirectorySettings(props: Props) {
  return (
    <Suspense fallback={
      <div role="status" className="flex flex-1 min-h-0 items-center justify-center text-sm text-[var(--text-tertiary)]">
        {i18nT("common.loading2", undefined, "Loading…")}
      </div>
    }>
      <DirectorySettings {...props} />
    </Suspense>
  );
}
