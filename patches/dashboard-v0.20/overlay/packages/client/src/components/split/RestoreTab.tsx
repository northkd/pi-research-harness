/**
 * Rotated vertical restore tab — the shared collapse/restore idiom for the
 * collapsed chat/editor pane peeks and the collapsed session rail. In-flow
 * (Fluent SplitView "inline"): a flex sibling that PUSHES content aside, never
 * an overlay, so it can never clip a narrow pane. This is the structural fix
 * for the maximized-window overlap bug — the tab lives in the flex flow, so it
 * has no way to float over a pane's content.
 *
 * See change: redesign-split-layout-controls.
 */

interface RestoreTabProps {
  /** Which edge the tab anchors to (drives the border side). */
  side: "left" | "right";
  /** Upright caption text (rotated by the vertical writing mode). */
  label: string;
  /** Directional chevron glyph, kept horizontal inside the rotated tab. */
  chevron: string;
  onClick: () => void;
  title: string;
  "data-testid"?: string;
}

export function RestoreTab({ side, label, chevron, onClick, title, "data-testid": testId }: RestoreTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid={testId}
      style={{ writingMode: "vertical-rl" }}
      className={`group flex w-[36px] shrink-0 cursor-pointer items-center justify-center gap-2 bg-[var(--bg-secondary)] text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent-text)] ${
        side === "left"
          ? "border-r border-[var(--border-primary)]"
          : "border-l border-[var(--border-primary)]"
      }`}
    >
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--tint-blue-border)] bg-[var(--tint-blue-bg)] text-[14px] font-bold leading-none text-[var(--accent-text)] [writing-mode:horizontal-tb] transition-colors group-hover:border-[var(--accent-primary)]">
        {chevron}
      </span>
      {label}
    </button>
  );
}
