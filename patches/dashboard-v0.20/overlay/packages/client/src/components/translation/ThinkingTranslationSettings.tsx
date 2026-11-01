import { Dialog } from "@blackbelt-technology/pi-dashboard-client-utils/Dialog";
import type { TranslationModelRef } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useEffect, useRef, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { fetchJson } from "../../lib/api/fetch-json.js";
import { getResWorkflowModels } from "../../lib/api/res-workflow-api.js";
import { useI18n } from "../../lib/i18n/i18n.js";
import { ModelSelector } from "../settings/ModelSelector.js";

interface SettingsState {
  success: boolean;
  sessionId: string;
  enabled: boolean;
  model: TranslationModelRef | null;
  runtime: "pending-safe-load" | "disabled" | "ready" | "blocked";
}
const buttonClass = "focus-ring min-h-9 rounded-md border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50";

export function ThinkingTranslationSettings({ sessionId, cwd }: { sessionId?: string; cwd?: string }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === "zh-CN" ? zh : en;
  const apiBase = useApiBase();
  const [state, setState] = useState<SettingsState | null>(null);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  useEffect(() => {
    const current = ++scope.current;
    const controller = new AbortController();
    setState(null); setOpen(false); setConsent(false); setError(null); setPending(false); setSelected("");
    if (sessionId) void fetchJson<SettingsState>(`${apiBase}/api/thinking-translation/settings?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted && scope.current === current && value.sessionId === sessionId) setState(value);
    }).catch(() => { if (!controller.signal.aborted && scope.current === current) setError(text("无法读取翻译设置。", "Could not read translation settings.")); });
    return () => { controller.abort(); scope.current++; };
  }, [apiBase, sessionId]);
  useEffect(() => {
    if (!open || !cwd) return;
    const controller = new AbortController();
    setModels([]);
    void getResWorkflowModels(cwd, controller.signal).then((value) => {
      if (!controller.signal.aborted) setModels(value);
    }).catch(() => { if (!controller.signal.aborted) setError(text("翻译模型目录不可用；不会改用默认模型。", "Translation model catalogue unavailable; no default model will be used.")); });
    return () => controller.abort();
  }, [open, cwd]);
  const save = async (enabled: boolean) => {
    const model = models.find((item) => `${item.provider}/${item.id}` === selected);
    if (!sessionId || (enabled && (!model || !consent))) return;
    const current = scope.current;
    setPending(true); setError(null);
    try {
      const value = await fetchJson<SettingsState>(`${apiBase}/api/thinking-translation/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, enabled, ...(enabled && model ? { model: { provider: model.provider, id: model.id }, consent: true } : {}) }),
      });
      if (scope.current !== current || value.sessionId !== sessionId) return;
      setState(value); setOpen(false); setConsent(false);
    } catch {
      if (scope.current === current) setError(text("翻译设置未保存。请检查所选模型和会话权限；不会调用替代模型。", "Translation settings were not saved. Check the selected model and session access; no substitute model is used."));
    } finally { if (scope.current === current) setPending(false); }
  };
  return (
    <section data-testid="thinking-translation-settings" className="min-w-0 space-y-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{text("思考译文 · Pi + Dashboard", "Thinking translation · Pi + Dashboard")}</h3>
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{text("默认关闭，仅翻译本会话模型已经提供的可见思考。不改写原文，不保存译文，也不改变主模型的思考语言。接入分析的授权不能代替翻译授权。", "Off by default. Translates only visible thinking supplied by this session's model. Does not rewrite the original, save translations, or change the main model's thinking language. Import-analysis consent does not authorize translation.")}</p>
      {!sessionId || !cwd ? <p className="text-xs text-[var(--text-secondary)]">{text("请先选择一个 Pi 会话，再为该会话授权翻译。", "Select a Pi session before authorizing translation for it.")}</p> : <>
        <p className="break-words text-xs text-[var(--text-secondary)]" role="status">
          {state?.enabled ? text("本会话已授权", "Authorized for this session") : text("本会话未启用", "Off for this session")}
          {state?.model ? ` · ${state.model.provider}/${state.model.id}` : ""}
          {state?.runtime === "pending-safe-load" ? text(" · 插件待安全加载；不会重载正在运行的会话", " · Plugin pending safe load; running sessions are not reloaded") : ""}
          {state?.runtime === "blocked" ? text(" · 翻译受阻，原回答不受影响", " · Translation blocked; the original response is unaffected") : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={pending || !state} onClick={() => { setSelected(state?.model ? `${state.model.provider}/${state.model.id}` : ""); setConsent(false); setError(null); setOpen(true); }}>{text("选择模型并授权", "Choose model and authorize")}</button>
          {state?.enabled && <button type="button" className={buttonClass} disabled={pending} onClick={() => void save(false)}>{text("停用翻译", "Disable translation")}</button>}
        </div>
      </>}
      {error && <p role="alert" className="text-xs text-[var(--severity-warning-fg)]">{error}</p>}
      <Dialog open={open} onClose={() => { if (!pending) { setOpen(false); setConsent(false); } }} title={text("授权本会话的思考翻译", "Authorize thinking translation for this session")} size="lg" testId="thinking-translation-consent">
        <div className="min-w-0 space-y-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{text("仅发送本会话模型已经提供的可见思考，可能含未公开研究信息。接收方是下方明确选择的 provider/model，仅用于生成临时简体中文译文。", "Only visible thinking supplied by this session's model is sent; it may contain unpublished research. The recipient is the explicitly selected provider/model below, solely to produce temporary Simplified Chinese translation.")}</p>
          <ModelSelector models={models} current={selected || undefined} onSelect={(value) => { setSelected(value); setConsent(false); }} allowRoles={false} placeholder={text("选择明确的翻译模型", "Choose an explicit translation model")} />
          {selected && <p className="break-words text-xs text-[var(--text-primary)]">{text("接收方：", "Recipient: ")}{selected}</p>}
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{text("不发送用户输入、最终回答、工具参数或全量历史。模型无工具执行能力；不可用时只报错，不切换 provider、默认模型或 @fast。译文约 30 秒后清除，不写入聊天、Pi session、未来上下文或 compaction。", "User input, final answers, tool arguments and full history are excluded. The translator has no tools. An unavailable model causes an error, never fallback to another provider, default model or @fast. Translations expire after about 30 seconds and are excluded from chat, Pi sessions, future context and compaction.")}</p>
          <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]"><input type="checkbox" className="mt-1 shrink-0" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={!selected || pending} /><span>{text("我同意将上述范围的可见思考发送给所选模型，仅用于本会话的临时中文翻译。", "I authorize sending visible thinking within the stated scope to the selected model, only for temporary Chinese translation in this session.")}</span></label>
          {error && <p role="alert" className="text-xs text-[var(--severity-warning-fg)]">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2"><button type="button" className={buttonClass} disabled={pending} onClick={() => { setOpen(false); setConsent(false); }}>{text("取消", "Cancel")}</button><button type="button" className={buttonClass} disabled={!consent || !models.some((m) => `${m.provider}/${m.id}` === selected) || pending} onClick={() => void save(true)}>{pending ? text("保存中…", "Saving…") : text("确认授权", "Confirm authorization")}</button></div>
        </div>
      </Dialog>
    </section>
  );
}
