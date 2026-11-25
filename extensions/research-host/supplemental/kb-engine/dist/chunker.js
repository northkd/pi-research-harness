import { createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter.js";
const MIN_CHUNK_CHARS = 100;
const MAX_CHUNK_CHARS = 4e3;
const sha = (s) => createHash("sha256").update(s).digest("hex");
function scanWikilinks(text) {
  const out = [];
  let close = -1;
  let i = text.indexOf("[[");
  while (i !== -1) {
    if (close < i + 2) {
      close = text.indexOf("]", i + 2);
      if (close === -1) break;
    }
    if (close > i + 2 && text[close + 1] === "]") {
      out.push(text.slice(i + 2, close).trim());
      i = text.indexOf("[[", close + 2);
    } else {
      i = text.indexOf("[[", i + 1);
    }
  }
  return out;
}
function scanMdLinks(text) {
  const out = [];
  let close = -1;
  let i = text.indexOf("](");
  while (i !== -1) {
    if (close < i + 2) {
      close = text.indexOf(")", i + 2);
      if (close === -1) break;
    }
    const len = close - (i + 2);
    if (len >= 4 && text.endsWith(".md", close) || len >= 5 && text.endsWith(".mdx", close)) {
      out.push(text.slice(i + 2, close).trim());
      i = text.indexOf("](", close + 1);
    } else {
      i = text.indexOf("](", i + 1);
    }
  }
  return out;
}
function chunkMarkdown(input) {
  const docType = input.docType ?? "doc";
  const { body: text, fm, parseFailed } = parseFrontmatter(input.text);
  const lines = text.split("\n");
  const fileTitle = input.path.split("/").pop().replace(/\.(md|mdx|markdown)$/i, "");
  const raw = [];
  const stack = [];
  let cur = null;
  let inFence = false;
  let fenceCh = "";
  let ordinal = 0;
  const flush = () => {
    if (cur && cur.body.trim()) raw.push(cur);
  };
  for (const line of lines) {
    const t = line.trimStart();
    const fm2 = t.match(/^(```+|~~~+)/);
    if (fm2) {
      if (!inFence) {
        inFence = true;
        fenceCh = fm2[1][0];
      } else if (t.startsWith(fenceCh)) {
        inFence = false;
      }
      if (cur) cur.body += line + "\n";
      continue;
    }
    const hm = !inFence && line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flush();
      const level = hm[1].length;
      const title = hm[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parentOrdinal = stack.length ? stack[stack.length - 1].chunkOrdinal : -1;
      stack.push({ level, title, chunkOrdinal: ordinal });
      cur = {
        headingPath: stack.map((s) => s.title).join(" > "),
        heading: title,
        level,
        parentChunkId: parentOrdinal >= 0 ? String(parentOrdinal) : null,
        body: ""
      };
      ordinal++;
    } else {
      if (!cur) {
        cur = { headingPath: fileTitle, heading: fileTitle, level: 0, parentChunkId: null, body: "" };
        ordinal++;
      }
      cur.body += line + "\n";
    }
  }
  flush();
  const merged = [];
  for (const c of raw) {
    if (c.body.trim().length < MIN_CHUNK_CHARS && merged.length) {
      merged[merged.length - 1].body += "\n" + c.heading + "\n" + c.body;
    } else merged.push(c);
  }
  const sized = [];
  for (const c of merged) {
    if (c.body.length <= MAX_CHUNK_CHARS) {
      sized.push(c);
      continue;
    }
    const paras = c.body.split(/\n\s*\n/);
    let buf = "";
    for (const p of paras) {
      if ((buf + p).length > MAX_CHUNK_CHARS && buf) {
        sized.push({ ...c, body: buf });
        buf = "";
      }
      buf += p + "\n\n";
    }
    if (buf.trim()) sized.push({ ...c, body: buf });
  }
  const fileSha = sha(input.path);
  const chunks = sized.map((c, i) => ({
    root: input.root,
    path: input.path,
    chunkId: `${fileSha.slice(0, 8)}:${i}`,
    headingPath: c.headingPath,
    heading: c.heading,
    level: c.level,
    parentChunkId: c.parentChunkId ? `${fileSha.slice(0, 8)}:${c.parentChunkId}` : null,
    docType,
    body: c.body.trimEnd(),
    bodyHash: sha(c.body.trim())
  }));
  const wikilinks = scanWikilinks(input.text);
  const mdLinks = scanMdLinks(input.text);
  return { chunks, frontmatter: fm, wikilinks, mdLinks, parseFailed };
}
export {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  chunkMarkdown,
  sha
};
