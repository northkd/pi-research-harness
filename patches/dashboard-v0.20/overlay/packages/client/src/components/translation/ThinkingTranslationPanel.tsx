import { useThinkingTranslation } from "../../hooks/useThinkingTranslation.js";
import { useI18n } from "../../lib/i18n/i18n.js";

export function ThinkingTranslationPanel({ sessionId, ws, connected }: { sessionId?: string; ws: WebSocket | null; connected: boolean }) {
  const { language } = useI18n();
  const { snapshot, blocked } = useThinkingTranslation(sessionId, ws, connected);
  const text = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  if (!snapshot && !blocked) return null;
  return (
    <section data-testid="thinking-translation-panel" aria-label={text("思考译文", "Thinking translation")} className="min-w-0 shrink-0 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1 px-3 py-2 text-xs">
        <h3 className="font-semibold">{text("思考译文", "Thinking translation")}</h3>
        <span className="text-[var(--text-secondary)]">{text("临时 · 仅可见思考 · 不进入历史", "Temporary · visible thinking only · not saved")}</span>
      </div>
      {blocked ? (
        <p role="status" className="px-3 pb-2 text-xs text-[var(--text-secondary)]">{text("译文暂不可用，原始回答继续。请在设置中核对翻译授权与模型。", "Translation unavailable; the original response continues. Check translation authorization and model in Settings.")}</p>
      ) : snapshot && (
        <div className="max-h-[24vh] min-w-0 space-y-3 overflow-y-auto overscroll-contain px-3 pb-3 text-sm leading-relaxed">
          {snapshot.blocks.map((block) => (
            <div key={`${block.messageId}:${block.blockId}`} className="min-w-0 space-y-1">
              <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{block.translation}</p>
              <details className="text-xs text-[var(--text-secondary)]">
                <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-2">{text("查看原文对照", "Compare original")}</summary>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{block.original}</p>
              </details>
            </div>
          ))}
          <p className="text-[11px] text-[var(--text-secondary)]">{text("仅显示最近的有限片段；长内容可能截断，约 30 秒后清除。", "Recent bounded excerpts only; long content may be truncated. Cleared after about 30 seconds.")}</p>
        </div>
      )}
    </section>
  );
}
