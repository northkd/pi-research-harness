import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
function splitTranscriptLines(raw) {
  return raw.trim().split("\n");
}
function loadSessionEntries(filePath) {
  if (!existsSync(filePath)) return [];
  return parseSessionEntries(splitTranscriptLines(readFileSync(filePath, "utf-8")));
}
function parseSessionEntries(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
    }
  }
  if (entries.length === 0) return [];
  const header = entries[0];
  if (header.type !== "session" || typeof header.id !== "string") return [];
  const byId = /* @__PURE__ */ new Map();
  let leafId;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (entry.id) {
      byId.set(entry.id, entry);
      leafId = entry.id;
    }
  }
  for (const entry of entries) {
    if (entry.type === "leaf" && typeof entry.entryId === "string") {
      leafId = entry.entryId;
    }
  }
  if (leafId && byId.size > 0) {
    const branch = [];
    const seen = /* @__PURE__ */ new Set();
    let cyclic = false;
    let current = byId.get(leafId);
    while (current) {
      const id = current.id;
      if (id !== void 0) {
        if (seen.has(id)) {
          cyclic = true;
          break;
        }
        seen.add(id);
      }
      branch.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : void 0;
    }
    if (!cyclic && branch.length > 0) return branch;
  }
  return entries.filter((e) => e.type !== "session");
}
function findSessionToolCallPayload(filePath, toolCallId) {
  if (!toolCallId) return null;
  const entries = loadSessionEntries(filePath);
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (!c || c.type !== "toolCall" || c.id !== toolCallId) continue;
      const a = c.arguments ?? c.args ?? {};
      const out = {};
      if (typeof a.content === "string") out.content = a.content;
      if (Array.isArray(a.edits)) out.edits = a.edits;
      return out;
    }
  }
  return null;
}
function findSessionCustomEntry(filePath, entryId) {
  if (!entryId) return null;
  const entries = loadSessionEntries(filePath);
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.id !== entryId) continue;
    return { customType: entry.customType, data: entry.data };
  }
  return null;
}
function createBranchedSessionFile(sessionFilePath, targetEntryId) {
  if (!existsSync(sessionFilePath)) {
    throw new Error(`Session file not found: ${sessionFilePath}`);
  }
  const content = readFileSync(sessionFilePath, "utf-8");
  const allLines = content.trim().split("\n").filter((l) => l.trim());
  const allEntries = [];
  for (const line of allLines) {
    try {
      allEntries.push(JSON.parse(line));
    } catch {
    }
  }
  if (allEntries.length === 0) throw new Error("Empty session file");
  const header = allEntries[0];
  if (header.type !== "session") throw new Error("Invalid session file: missing header");
  const byId = /* @__PURE__ */ new Map();
  for (const entry of allEntries) {
    if (entry.type === "session") continue;
    if (entry.id) byId.set(entry.id, entry);
  }
  if (!byId.has(targetEntryId)) {
    throw new Error(`Entry ID not found in session: ${targetEntryId}`);
  }
  const branch = [];
  let current = byId.get(targetEntryId);
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : void 0;
  }
  const newHeader = { ...header, id: randomUUID(), parentSession: sessionFilePath };
  const lines = [JSON.stringify(newHeader)];
  for (let i = 0; i < branch.length; i++) {
    const entry = { ...branch[i], parentId: i === 0 ? null : branch[i - 1].id };
    lines.push(JSON.stringify(entry));
  }
  const dir = dirname(sessionFilePath);
  mkdirSync(dir, { recursive: true });
  const newPath = join(dir, `${newHeader.id}.jsonl`);
  writeFileSync(newPath, lines.join("\n") + "\n", "utf-8");
  return newPath;
}
export {
  createBranchedSessionFile,
  findSessionCustomEntry,
  findSessionToolCallPayload,
  loadSessionEntries,
  parseSessionEntries,
  splitTranscriptLines
};
