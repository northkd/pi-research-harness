import { MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, sha } from "./chunker.js";
const NEGATED = "!";
const ADOC_EXT_RE = /\.(adoc|asciidoc)$/i;
const TITLE_RE = /^(={1,6})\s+(\S.*?)\s*$/;
const ATTR_RE = /^:(!?)([A-Za-z0-9_][A-Za-z0-9_-]*)(!?):(?:[ \t]+(.*?))?[ \t]*$/;
function delimiterOf(line) {
  const t = line.replace(/[ \t]+$/, "");
  if (/^\/{4,}$/.test(t)) return "////";
  if (/^-{4,}$/.test(t)) return "----";
  if (/^\.{4,}$/.test(t)) return "....";
  if (/^={4,}$/.test(t)) return "====";
  if (/^\*{4,}$/.test(t)) return "****";
  if (/^_{4,}$/.test(t)) return "____";
  if (/^\+{4,}$/.test(t)) return "++++";
  if (/^\|={3,}$/.test(t)) return "|===";
  if (t === "--") return "--";
  return null;
}
const bodyOf = (s) => s.bodyLines.map((l) => l + "\n").join("");
function parseHeader(lines) {
  const first = lines[0] ?? "";
  const m = first.match(/^=[ \t]+(\S.*?)[ \t]*$/);
  if (!m) return { doctitle: null, attributes: null, bodyStart: 0 };
  const attributes = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    const a = line.match(ATTR_RE);
    if (!a) break;
    const negated = a[1] === "!" || a[3] === "!";
    attributes[a[2].toLowerCase()] = negated ? NEGATED : a[4] ?? "";
  }
  return { doctitle: m[1], attributes, bodyStart: i };
}
const XREF_MAX = 256;
const XREF_MACRO_RE = new RegExp(String.raw`xref:([^\[\s]{1,${XREF_MAX}})\[`, "g");
const XREF_ANGLE_RE = new RegExp(String.raw`<<([^>,\s]{1,${XREF_MAX}})(?:,[^>]{0,${XREF_MAX}})?>>`, "g");
function extractXrefs(text) {
  const out = [];
  const take = (raw) => {
    const file = raw.split("#")[0].trim();
    if (file && ADOC_EXT_RE.test(file)) out.push(file);
  };
  for (const m of text.matchAll(XREF_MACRO_RE)) take(m[1]);
  for (const m of text.matchAll(XREF_ANGLE_RE)) take(m[1]);
  return out;
}
function safeGroups(bodyLines, lineNos) {
  const groups = [];
  let cur = { lines: [], nos: [] };
  let open = null;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const d = delimiterOf(line);
    if (open) {
      if (d === open) open = null;
    } else if (d) {
      open = d;
    } else if (line.trim() === "") {
      if (cur.lines.length) groups.push(cur);
      cur = { lines: [], nos: [] };
      continue;
    }
    cur.lines.push(line);
    cur.nos.push(lineNos[i]);
  }
  if (cur.lines.length) groups.push(cur);
  return groups;
}
function chunkAsciiDoc(input) {
  const docType = input.docType ?? "doc";
  const norm = input.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = norm.split("\n");
  const fileTitle = (input.path.split("/").pop() ?? input.path).replace(ADOC_EXT_RE, "");
  const { doctitle, attributes, bodyStart } = parseHeader(lines);
  const rootTitle = doctitle ?? fileTitle;
  const raw = [];
  const stack = [];
  if (doctitle) stack.push({ level: 0, title: doctitle, chunkOrdinal: -1 });
  let cur = null;
  let open = null;
  let ordinal = 0;
  const flush = () => {
    if (!cur || !bodyOf(cur).trim()) return;
    raw.push(cur);
    if (cur.slot) cur.slot.chunkOrdinal = cur.ordinal;
  };
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const d = delimiterOf(line);
    if (open) {
      if (d === open) open = null;
    } else if (d) {
      open = d;
    } else {
      const tm = line.match(TITLE_RE);
      if (tm) {
        flush();
        const level = tm[1].length;
        const title = tm[2];
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parentOrdinal = stack.length ? stack[stack.length - 1].chunkOrdinal : -1;
        const slot = { level, title, chunkOrdinal: -1 };
        stack.push(slot);
        cur = {
          headingPath: stack.map((s) => s.title).join(" > "),
          heading: title,
          level,
          parentOrdinal,
          headingLine: lineNo,
          ordinal,
          slot,
          bodyLines: [],
          lineNos: []
        };
        ordinal++;
        continue;
      }
    }
    if (!cur) {
      cur = { headingPath: rootTitle, heading: rootTitle, level: 0, parentOrdinal: -1, headingLine: lineNo, ordinal, slot: doctitle ? stack[0] : null, bodyLines: [], lineNos: [] };
      ordinal++;
    }
    cur.bodyLines.push(line);
    cur.lineNos.push(lineNo);
  }
  flush();
  const merged = [];
  for (const c of raw) {
    if (bodyOf(c).trim().length < MIN_CHUNK_CHARS && merged.length) {
      const prev = merged[merged.length - 1];
      prev.bodyLines.push("", c.heading, ...c.bodyLines);
      prev.lineNos.push(c.headingLine, c.headingLine, ...c.lineNos);
    } else merged.push(c);
  }
  const sized = [];
  for (const c of merged) {
    if (bodyOf(c).length <= MAX_CHUNK_CHARS) {
      sized.push(c);
      continue;
    }
    const groups = safeGroups(c.bodyLines, c.lineNos);
    let buf = { lines: [], nos: [] };
    const emit = () => {
      if (buf.lines.length) sized.push({ ...c, bodyLines: buf.lines, lineNos: buf.nos });
      buf = { lines: [], nos: [] };
    };
    for (const g of groups) {
      const glen = g.lines.reduce((n, l) => n + l.length + 1, 0);
      const blen = buf.lines.reduce((n, l) => n + l.length + 1, 0);
      if (blen && blen + glen > MAX_CHUNK_CHARS) emit();
      buf.lines.push(...g.lines, "");
      buf.nos.push(...g.nos, g.nos[g.nos.length - 1]);
    }
    emit();
  }
  const fileSha = sha(input.path);
  const indexByOrdinal = /* @__PURE__ */ new Map();
  sized.forEach((c, i) => {
    if (!indexByOrdinal.has(c.ordinal)) indexByOrdinal.set(c.ordinal, i);
  });
  const chunks = sized.map((c, i) => {
    const body = bodyOf(c);
    const anchors = realAnchors(c);
    return {
      root: input.root,
      path: input.path,
      chunkId: `${fileSha.slice(0, 8)}:${i}`,
      headingPath: c.headingPath,
      heading: c.heading,
      level: c.level,
      parentChunkId: parentIdOf(c, i),
      docType,
      body: body.trimEnd(),
      bodyHash: sha(body.trim()),
      startLine: anchors.startLine,
      endLine: anchors.endLine
    };
  });
  function parentIdOf(c, ownIndex) {
    const idx = indexByOrdinal.get(c.parentOrdinal);
    if (idx === void 0 || idx === ownIndex) return null;
    return `${fileSha.slice(0, 8)}:${idx}`;
  }
  const frontmatter = attributes ? { ...attributes, ...doctitle ? { title: doctitle } : {} } : null;
  return { chunks, attributes, doctitle, frontmatter, wikilinks: [], mdLinks: extractXrefs(norm), parseFailed: false };
}
function realAnchors(c) {
  let first = 0;
  let last = c.bodyLines.length - 1;
  while (first < c.bodyLines.length && c.bodyLines[first].trim() === "") first++;
  while (last >= 0 && c.bodyLines[last].trim() === "") last--;
  if (first > last) return { startLine: c.headingLine, endLine: c.headingLine };
  return { startLine: c.lineNos[first], endLine: c.lineNos[last] };
}
export {
  NEGATED,
  chunkAsciiDoc,
  extractXrefs
};
