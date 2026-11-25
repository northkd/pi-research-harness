function stripComment(s) {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const close = t.indexOf(t[0], 1);
    return close > 0 ? t.slice(0, close + 1) : t;
  }
  const idx = t.indexOf(" #");
  return (idx >= 0 ? t.slice(0, idx) : t).trim();
}
function coerceScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2 || s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}
function parseInlineArray(s) {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((e) => {
    const t = e.trim();
    const unq = t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
    return unq.trim();
  }).filter((e) => e.length > 0);
}
const isIndented = (line) => /^\s/.test(line);
const isBlank = (line) => line.trim() === "";
function parseFrontmatter(text) {
  const norm = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = norm.split("\n");
  if (lines[0] !== "---") return { body: norm, fm: null, parseFailed: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { body: norm, fm: null, parseFailed: false };
  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const fm = {};
  let parseFailed = false;
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlank(line) || line.trim().startsWith("#")) continue;
    if (isIndented(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.\/-]+):(.*)$/);
    if (!m) {
      parseFailed = true;
      continue;
    }
    const key = m[1];
    const rest = stripComment(m[2]);
    if (key === "kb") {
      while (i + 1 < fmLines.length && (isIndented(fmLines[i + 1]) || isBlank(fmLines[i + 1]))) i++;
      continue;
    }
    if (rest === "") {
      const items = [];
      while (i + 1 < fmLines.length && /^\s*-\s+/.test(fmLines[i + 1])) {
        i++;
        items.push(stripComment(fmLines[i].replace(/^\s*-\s+/, "")).replace(/^["']|["']$/g, ""));
      }
      if (items.length) {
        fm[key] = items.filter((e) => e.length > 0);
      } else if (i + 1 < fmLines.length && /^\s+\S/.test(fmLines[i + 1])) {
        while (i + 1 < fmLines.length && (isIndented(fmLines[i + 1]) || isBlank(fmLines[i + 1]))) i++;
      } else {
        fm[key] = "";
      }
      continue;
    }
    if (rest === "|" || rest === ">") {
      while (i + 1 < fmLines.length && (isIndented(fmLines[i + 1]) || isBlank(fmLines[i + 1]))) i++;
      continue;
    }
    if (rest.startsWith("[")) {
      fm[key] = parseInlineArray(rest);
      continue;
    }
    fm[key] = coerceScalar(rest);
  }
  return { body, fm, parseFailed };
}
const DEFAULT_SEARCHABLE_KEYS = ["title", "description", "aliases", "keywords"];
const DEFAULT_FACET_KEYS = [
  { key: "tags" },
  { key: "status" },
  { key: "author" },
  { key: "category" },
  { key: "date", type: "date" }
];
function strictNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function strictDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = /* @__PURE__ */ new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function buildMeta(fm, searchableKeys) {
  const title = searchableKeys.includes("title") && fm.title != null ? String(Array.isArray(fm.title) ? fm.title.join(" ") : fm.title) : null;
  const parts = [];
  for (const key of searchableKeys) {
    if (key === "title" || key === "tags") continue;
    const v = fm[key];
    if (v == null) continue;
    parts.push(Array.isArray(v) ? v.join(" ") : String(v));
  }
  return { title, body: parts.join(" ").trim() };
}
function buildProperties(fm, facetKeys) {
  const rows = [];
  for (const { key, type } of facetKeys) {
    const v = fm[key];
    if (v == null) continue;
    const elems = Array.isArray(v) ? v : [v];
    const seen = /* @__PURE__ */ new Set();
    for (const e of elems) {
      const raw = String(e);
      const value = raw.toLowerCase().trim();
      if (value === "" || seen.has(value)) continue;
      seen.add(value);
      rows.push({
        key,
        value,
        valueNum: type === "number" ? strictNumber(e) : null,
        valueDate: type === "date" ? strictDate(raw) : null,
        valueRaw: raw
      });
    }
  }
  return rows;
}
export {
  DEFAULT_FACET_KEYS,
  DEFAULT_SEARCHABLE_KEYS,
  buildMeta,
  buildProperties,
  parseFrontmatter,
  strictDate,
  strictNumber
};
