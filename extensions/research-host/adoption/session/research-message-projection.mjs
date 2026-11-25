function projectResearchMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || !["user", "assistant"].includes(entry.message.role)) continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
    if (text.trim()) messages.push({ entryId: typeof entry.id === "string" ? entry.id : void 0, timestamp: typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : void 0, role: entry.message.role, text });
  }
  return messages;
}
export {
  projectResearchMessages
};
