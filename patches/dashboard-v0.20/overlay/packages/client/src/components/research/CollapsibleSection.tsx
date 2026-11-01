import { mdiChevronDown, mdiChevronRight } from "@mdi/js";
import { Icon } from "@mdi/react";
import { type ReactNode, useEffect, useState } from "react";

interface CollapsibleSectionProps {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  isUpdating?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  badge,
  isUpdating = false,
  defaultOpen = true,
  children,
  className = "mt-4 min-w-0 win11-card overflow-hidden transition-all",
  testId,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (isUpdating) {
      setIsOpen(true);
    }
  }, [isUpdating]);

  return (
    <section id={id} data-testid={testId ?? id} className={className}>
      {/* WinUI 3 Expander Header */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsOpen((prev) => !prev);
          }
        }}
        className="flex cursor-pointer select-none flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14px] font-semibold tracking-tight text-[var(--text-primary)]">
              {title}
            </h2>
            {isUpdating && (
              <span
                className="tint-action-green inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
                title="当前有活跃任务或实时数据正在更新"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-green)] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-green)]" />
                </span>
                实时更新中
              </span>
            )}
          </div>
          {subtitle && (
            <div className="mt-0.5 text-xs text-[var(--text-secondary)] leading-relaxed">
              {subtitle}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {badge}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen((prev) => !prev);
            }}
            className="win11-btn px-2.5 py-1 text-xs text-[var(--text-secondary)]"
            title={isOpen ? "点击收起面板" : "点击展开面板"}
            aria-label={isOpen ? "收起" : "展开"}
          >
            <span className="text-[11px]">{isOpen ? "收起" : "展开"}</span>
            <Icon
              path={isOpen ? mdiChevronDown : mdiChevronRight}
              size={0.65}
              className="shrink-0 text-[var(--text-secondary)]"
            />
          </button>
        </div>
      </div>

      {/* WinUI 3 Expander Content Drawer */}
      {isOpen && (
        <div className="min-w-0 border-t border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-4">
          {children}
        </div>
      )}
    </section>
  );
}
