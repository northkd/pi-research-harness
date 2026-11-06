import { useEffect, useRef, useState } from "react";

export function ResearchStartGuide({
  cwd,
  objective,
  hasHistory = false,
  compact = false,
}: {
  cwd: string;
  objective?: string | null;
  hasHistory?: boolean;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<"continue" | "start">(hasHistory ? "continue" : "start");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const generation = useRef(0);
  const draft = useRef<HTMLTextAreaElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => { generation.current++; }, []);

  const instructions = mode === "continue" ? [
    `请接续本目录已接入的研究：${JSON.stringify(cwd)}。`,
    "先读取已经确认的接入草案、冻结目标、成功标准、现有成果、证据、未解决问题和正在运行的任务，核对当前阶段。",
    "保持原目标、证据和已完成进度，推进下一项可核验的研究工作；已在运行的工作先检查状态，不重复派发或重跑已完成实验。",
    "研究阶段是否已登记，以研究记录为准；先核对正在运行的任务。research_loop 的 run 会从 Stage 1 新启动，不能把它当作历史恢复；需要新工作流时先说明范围。",
    "按照当前访问权限和任务约束推进；检查实际用量与已有成果，持续记录证据和结论。",
    "本次发送确认在已有材料、模型和资源授权范围内接续研究；超出原授权的外部调用或资源另行申请。返回实际执行或阻塞状态。",
  ].join("\n\n") : [
    `请在本目录启动新的研究工作流：${JSON.stringify(cwd)}。`,
    objective?.trim() ? `使用已经冻结的研究目标：${objective.trim()}` : "研究目标：[填写你的研究问题]。成功标准：[填写可核验标准]。数据与约束：[填写范围]。",
    "先核对已有课题和运行任务，保持已有目标、证据和进度；若已有研究，应先说明新启动与接续的区别。",
    "按照当前访问权限和任务约束执行，持续记录实际用量、实验依据和阶段进度。",
    "本次发送确认在已有材料、模型和资源授权范围内启动；新工作流会从 Stage 1 开始，模型调用可能产生费用。超出原授权的调用另行申请。",
    "由主 Agent 使用现有研究工作流派发并返回实际启动回执，不能仅以计划或启动回执宣称研究已经完成。",
  ].join("\n\n");

  async function copy() {
    const token = ++generation.current;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(instructions);
      if (generation.current === token) setCopyStatus("copied");
    } catch {
      if (generation.current === token) {
        setCopyStatus("failed");
        if (details.current) details.current.open = true;
        draft.current?.focus();
        draft.current?.select();
      }
    }
  }

  return (
    <section
      data-testid="research-start-guide"
      className="win11-card min-w-0 space-y-3.5 p-5 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">查看或接续当前研究</h3>
        <div className="win11-card-subtle flex flex-wrap gap-1 p-1" role="group" aria-label="选择研究执行方式">
          <button
            type="button"
            className={mode === "continue" ? "win11-btn-accent px-3 py-1.5 text-xs" : "win11-btn px-3 py-1.5 text-xs"}
            data-testid="research-continue-choice"
            aria-pressed={mode === "continue"}
            onClick={() => {
              generation.current++;
              setMode("continue");
              setCopyStatus("idle");
            }}
          >
            接续已有研究
          </button>
          <button
            type="button"
            className={mode === "start" ? "win11-btn-accent px-3 py-1.5 text-xs" : "win11-btn px-3 py-1.5 text-xs"}
            data-testid="research-start-choice"
            aria-pressed={mode === "start"}
            onClick={() => {
              generation.current++;
              setMode("start");
              setCopyStatus("idle");
            }}
          >
            新启动工作流
          </button>
        </div>
      </div>

      <p className="leading-relaxed text-[var(--text-secondary)]">
        先检查本页实际执行记录和本目录 Pi 会话中正在运行的任务。需要推进下一步时，选择上方方式，复制指令，检查后发送；新的执行可能产生模型费用。
      </p>
      <p className="text-[var(--text-secondary)]">
        {mode === "continue"
          ? "先核对当前任务、阶段和已完成成果，再推进下一步；已有任务先查看状态，避免重复派发。"
          : "新启动会从调研阶段开始。已有成果时，可先选择“接续已有研究”。"}
      </p>

      <details ref={details} open={!compact} className="win11-card-subtle p-3">
        <summary className="focus-ring cursor-pointer font-medium text-[var(--text-primary)]">
          {mode === "continue" ? "查看接续指令" : "查看启动指令"}
        </summary>
        <textarea
          ref={draft}
          data-testid="research-start-instructions"
          aria-label={mode === "continue" ? "接续研究指令" : "启动研究指令"}
          readOnly
          value={instructions}
          rows={7}
          className="mt-2.5 w-full min-w-0 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 font-mono text-xs leading-relaxed text-[var(--text-primary)]"
        />
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="research-copy-instructions"
          className="win11-btn-accent px-3.5 py-2 text-xs"
          disabled={copyStatus === "copying"}
          onClick={() => void copy()}
        >
          {copyStatus === "copying" ? "正在复制…" : "复制指令，到左侧聊天确认"}
        </button>
        <span role="status" aria-live="polite" className="text-[var(--text-secondary)]">
          {copyStatus === "copied"
            ? "已复制，请在本目录 Pi 会话检查后发送。"
            : copyStatus === "failed"
            ? "无法自动复制，指令已选中，可手动复制。"
            : "复制只准备文字，不会启动研究。"}
        </span>
      </div>

      <p className="text-[11px] text-[var(--text-tertiary)]">
        /research-loop 斜杠命令只查看状态。有正在运行的任务时先查看状态，保留已有任务、成果和证据，避免重复启动。
      </p>
    </section>
  );
}
