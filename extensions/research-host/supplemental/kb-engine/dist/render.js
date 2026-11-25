const SNIPPET_MAX = 160;
function leafHeading(headingPath) {
  const parts = headingPath.split(" > ");
  return parts[parts.length - 1] || headingPath;
}
function verdictText(v) {
  if (!v) return null;
  return `${v.label} (${v.counts.checked} of ${v.counts.total} subject${v.counts.total === 1 ? "" : "s"} checked)`;
}
function renderHits(hits, opts) {
  const { leading, parentGlyph, multiline } = opts;
  return hits.map((h, i) => {
    const lead = leading === "rank" ? String(i + 1) : h.score.toFixed(2);
    const head = `${lead}  ${h.path}  ::  ${leafHeading(h.headingPath)}`;
    const marks = [];
    if (h.akaPaths?.length) marks.push(`(+${h.akaPaths.length} dup)`);
    const sup = h.suppressedSections ?? 0;
    if (sup > 0) marks.push(`(+${sup} more section${sup === 1 ? "" : "s"})`);
    const vt = verdictText(h.verdict);
    if (vt) marks.push(vt);
    if (h.docType === "agents" || h.docType === "source-md") marks.push(`[${h.docType}]`);
    const dup = marks.join(" ");
    const snippet = h.snippet.replace(/\s+/g, " ").slice(0, SNIPPET_MAX);
    if (multiline) {
      const lines = [head];
      if (dup) lines.push(`   ${dup}`);
      if (h.parent) lines.push(`   ${parentGlyph}${h.parent.headingPath}`);
      lines.push(`   ${snippet}`);
      return lines.join("\n");
    }
    const dupInline = dup ? `  ${dup}` : "";
    const parentInline = h.parent ? `  ${parentGlyph}${h.parent.headingPath}]` : "";
    return `${head}${dupInline}${parentInline}
      ${snippet}`;
  }).join("\n");
}
export {
  renderHits
};
