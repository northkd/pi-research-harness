import type { SessionEntry } from "./session-file-reader.js";

export interface ResearchMessage {
  entryId?: string;
  timestamp?: string;
  role: "user" | "assistant";
  text: string;
}

/** Normal branch messages only: never thinking, tools, custom entries or compaction. */
export function projectResearchMessages(entries: SessionEntry[]): ResearchMessage[] {
  const messages: ResearchMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || !["user", "assistant"].includes(entry.message.role)) continue;
    const content: unknown = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
    if (text.trim()) messages.push({ entryId: typeof entry.id === "string" ? entry.id : undefined, timestamp: typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : undefined, role: entry.message.role, text });
  }
  return messages;
}
