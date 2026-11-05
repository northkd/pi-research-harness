import type { ChatMessage } from "../../lib/chat/event-reducer.js";

/** Ordinary execution records may fold; errors and user questions stay reachable. */
export function isAttentionTool(message: ChatMessage): boolean {
  return message.role === "toolResult" && (message.toolStatus === "error" || message.toolName === "ask_user");
}
