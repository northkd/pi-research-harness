import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * 提取用户消息文本原文
 */
function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
  }
  return "";
}

/**
 * 获取当前活动分支的条目列表（从 root 到 leaf 顺序）
 */
function getActiveBranchEntries(ctx: ExtensionCommandContext): any[] {
  if (typeof ctx.sessionManager.getBranch === "function") {
    const branch = ctx.sessionManager.getBranch();
    if (Array.isArray(branch)) {
      return branch;
    }
  }

  // 回退：通过 parentId 回溯
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  const leafId = ctx.sessionManager.getLeafId?.();
  if (!leafId || entries.length === 0) {
    return [];
  }

  const byId = new Map(entries.map((e: any) => [e.id, e]));
  const path: any[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/**
 * 判断条目是否为用户消息条目（Pi 核心在 navigateTree 中对此类条目会退至 parentId）
 */
function isUserEntry(entry: any): boolean {
  if (!entry) return false;
  if (entry.type === "message" && entry.message?.role === "user") {
    return true;
  }
  if (entry.type === "custom_message") {
    return true;
  }
  return false;
}

export default function undoLastExtension(pi: ExtensionAPI) {
  pi.registerCommand("undo-last", {
    description: "撤销上一条用户消息并把原文回填编辑器",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // 1) 必须空闲：不排队，避免停止后意外撤回消息
      if (!ctx.isIdle()) {
        ctx.ui.notify("请先停止模型和工具，再撤回消息", "warning");
        return;
      }

      // 2) 找到当前活动分支上的所有条目
      const branch = getActiveBranchEntries(ctx);

      // 3) 从 leaf 往回找最后一条 role === 'user' 的 message 条目 (U)
      let targetUserEntry: any = null;
      let targetUserIndex = -1;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message?.role === "user") {
          targetUserEntry = entry;
          targetUserIndex = i;
          break;
        }
      }

      // 找不到可撤销的用户消息 → notify 后 return，不调用 navigateTree
      if (!targetUserEntry) {
        ctx.ui.notify("没有可撤销的用户消息", "warning");
        return;
      }

      // 4) 提取用户消息原文
      const originalText = extractUserMessageText(targetUserEntry.message?.content);

      // 5) 判定边界与计算目标 targetId 与期望 newLeafId
      // 核心机制（PLAN-FIX-B）：
      // navigateTree 行为：
      // - targetEntry 为 user 消息时，newLeafId = targetEntry.parentId；
      // - targetEntry 为其它类型时，newLeafId = targetId；
      // - 若 targetId === oldLeafId，则提前返回，什么都不做。
      //
      // 设 U = targetUserEntry, P = parentId, leaf = 当前活动分支末端：
      // 判断 U 是否处于 leaf 位置：既包括当前物理 leafId === U.id，
      // 也包括 U 之后仅有系统自动追加的非消息元数据条目（如 thinking_level_change / model_change）。
      const currentLeafId = ctx.sessionManager.getLeafId?.() ?? null;
      const entriesAfterU = targetUserIndex >= 0 ? branch.slice(targetUserIndex + 1) : [];
      const hasMessagesAfterU = entriesAfterU.some(
        (e: any) => e.type === "message" || e.type === "custom_message"
      );
      const isULeaf = currentLeafId === targetUserEntry.id || !hasMessagesAfterU;

      const parentId = (targetUserEntry.parentId && typeof targetUserEntry.parentId === "string")
        ? targetUserEntry.parentId
        : null;

      let pEntry: any = null;
      if (parentId) {
        if (typeof (ctx.sessionManager as any).getEntry === "function") {
          pEntry = (ctx.sessionManager as any).getEntry(parentId);
        }
        if (!pEntry && typeof ctx.sessionManager.getEntries === "function") {
          const allEntries = ctx.sessionManager.getEntries() ?? [];
          pEntry = allEntries.find((e: any) => e.id === parentId);
        }
        if (!pEntry) {
          pEntry = branch.find((e: any) => e.id === parentId);
        }
      }

      // ① P === null 且 U.id === leaf: 无法回到根节点（命中提前返回），显式拒绝
      if (!parentId && isULeaf) {
        ctx.ui.notify("无法撤销第一条消息", "warning");
        return;
      }

      // ② P 是 user 条目（连续 user）: 传 P.id 会多退一层，传 U.id 会提前返回，显式拒绝
      if (parentId && isUserEntry(pEntry)) {
        ctx.ui.notify("上一条也是用户消息，无法安全撤销", "warning");
        return;
      }

      // 父条目如果找不到，无法判定其类型，安全起见拒绝
      if (parentId && !pEntry) {
        ctx.ui.notify("未找到上一条条目信息，无法安全撤销", "warning");
        return;
      }

      // ③ P 存在且不是 user 条目 且 U.id === leaf: 传 P.id，期望新 leaf = P.id
      // ④ U.id !== leaf: 直接传 U.id，期望新 leaf = P.id
      let targetId: string;
      const expectedLeafId = parentId; // null 或 parentId 字符串

      if (isULeaf) {
        // P 存在且不是 user 条目
        targetId = parentId!;
      } else {
        // U 不在 leaf 位置
        targetId = targetUserEntry.id;
      }

      let res: { cancelled: boolean };
      try {
        res = await ctx.navigateTree(targetId, { summarize: false });
      } catch (err: any) {
        // navigateTree 抛错 → notify 错误，不写成功标记
        ctx.ui.notify(`撤销失败: ${err?.message || String(err)}`, "error");
        return;
      }

      // navigateTree 被取消 → notify 警告，不写成功标记
      if (res.cancelled) {
        ctx.ui.notify("撤销操作已取消", "warning");
        return;
      }

      // 6) 调用后严格验证活动分支与 leaf 状态（A 且 B 必须同时成立）
      const newBranch = getActiveBranchEntries(ctx);
      const newLeafId = ctx.sessionManager.getLeafId?.() ?? null;

      // 断言 A：目标 user 消息已不在活动分支上
      const uStillInBranch = newBranch.some((e: any) => e.id === targetUserEntry.id);
      // 断言 B：新 leaf 恰好等于 P.id（即活动分支截断到 P）
      const leafMatches = newLeafId === expectedLeafId;

      if (uStillInBranch || !leafMatches) {
        const reasons: string[] = [];
        if (uStillInBranch) reasons.push("目标消息仍在活动分支");
        if (!leafMatches) reasons.push(`期望 leaf 为 ${expectedLeafId}，实际为 ${newLeafId}`);
        ctx.ui.notify(`撤销后验证失败: ${reasons.join("; ")}`, "error");
        return;
      }

      // 7) 只有验证通过才写成功标记
      pi.appendEntry("dashboard_undo_last", {
        text: originalText,
        undoneEntryId: targetUserEntry.id,
        cancelled: false,
      });

      // 8) TUI 下额外把文本放进编辑器（RPC/Dashboard 下这步无副作用）
      if (ctx.mode === "tui") {
        ctx.ui.setEditorText(originalText);
      }

      ctx.ui.notify("已撤销上一条用户消息", "info");
    },
  });
}
