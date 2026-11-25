function isDriveLetterForm(value) {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}
function driveLetterPrefix(value) {
  const m = value.match(/^([A-Za-z]:)(?![\\/])/);
  return m ? m[1] : null;
}
function getRoot(p, platform) {
  if (platform === "win32") {
    const unc = p.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/);
    if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`;
    const drive = p.match(/^([A-Za-z]:)[\\/]/);
    if (drive) return `${drive[1]}\\`;
    return "";
  }
  return p.startsWith("/") ? "/" : "";
}
function normalizeSegments(rest, sep) {
  const split = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  const out = [];
  for (const seg of split) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}
function normalizePath(p, platform = process.platform) {
  if (!p) return p;
  if (platform === "win32") {
    if (isDriveLetterForm(p)) {
      const prefix = driveLetterPrefix(p);
      const rest = p.slice(prefix.length);
      if (!rest) return prefix + "\\";
      return normalizePath(prefix + "\\" + rest, "win32");
    }
    const root2 = getRoot(p, "win32");
    if (root2) {
      const rest = p.slice(root2.length);
      const segments3 = normalizeSegments(rest, "\\");
      if (segments3.length === 0) return root2;
      return root2 + segments3.join("\\");
    }
    const segments2 = normalizeSegments(p, "\\");
    return segments2.join("\\");
  }
  const root = getRoot(p, platform);
  if (root) {
    const segments2 = normalizeSegments(p.slice(root.length), "/");
    if (segments2.length === 0) return root;
    return root + segments2.join("/");
  }
  const segments = normalizeSegments(p, "/");
  return segments.join("/");
}
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return a === b;
  const na = normalizePath(a, platform);
  const nb = normalizePath(b, platform);
  if (platform === "linux") return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}
function parsePathInput(value, platform = process.platform) {
  if (!value) return { parent: platform === "win32" ? "" : "/", partial: "" };
  if (platform === "win32") {
    if (/^[A-Za-z]:$/.test(value)) {
      return { parent: value[0] + ":\\", partial: "" };
    }
    if (isDriveLetterForm(value)) {
      const prefix = driveLetterPrefix(value);
      return { parent: prefix + "\\", partial: value.slice(prefix.length) };
    }
    const lastBackslash = value.lastIndexOf("\\");
    const lastForward = value.lastIndexOf("/");
    const lastSep2 = Math.max(lastBackslash, lastForward);
    if (lastSep2 < 0) {
      return { parent: "", partial: value };
    }
    if (lastSep2 === value.length - 1) {
      const parent3 = value.slice(0, lastSep2);
      if (/^[A-Za-z]:$/.test(parent3)) return { parent: parent3 + "\\", partial: "" };
      return { parent: normalizePath(parent3, "win32"), partial: "" };
    }
    const parent2 = value.slice(0, lastSep2);
    const partial2 = value.slice(lastSep2 + 1);
    const normalizedParent = /^[A-Za-z]:$/.test(parent2) ? parent2 + "\\" : normalizePath(parent2, "win32");
    return { parent: normalizedParent, partial: partial2 };
  }
  if (value === "/") return { parent: "/", partial: "" };
  if (value.endsWith("/")) {
    const parent2 = value.slice(0, -1) || "/";
    return { parent: parent2, partial: "" };
  }
  const lastSep = value.lastIndexOf("/");
  if (lastSep < 0) return { parent: "/", partial: value };
  const parent = value.slice(0, lastSep) || "/";
  const partial = value.slice(lastSep + 1);
  return { parent, partial };
}
function withTrailingSep(p, platform = process.platform) {
  if (!p) return p;
  const sep = platform === "win32" ? "\\" : "/";
  if (p.endsWith("\\") || p.endsWith("/")) return p;
  return p + sep;
}
function joinForDisplay(parent, child, platform = process.platform) {
  if (!parent) return child;
  if (!child) return parent;
  const sep = platform === "win32" ? "\\" : "/";
  const parentTrimmed = parent.replace(/[\\/]+$/, "");
  const childTrimmed = child.replace(/^[\\/]+/, "");
  if (platform === "win32" && /^[A-Za-z]:$/.test(parentTrimmed)) {
    return parentTrimmed + "\\" + childTrimmed;
  }
  if (parentTrimmed === "") return sep + childTrimmed;
  return parentTrimmed + sep + childTrimmed;
}
function caseInsensitiveFilesystem(platform = process.platform) {
  return platform === "darwin" || platform === "win32";
}
function isFilesystemRoot(resolved, platform = process.platform) {
  if (!resolved) return false;
  if (platform === "win32") {
    if (/^[A-Za-z]:[\\/]$/.test(resolved)) return true;
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(resolved)) return true;
    if (resolved === "/" || resolved === "\\") return true;
    return false;
  }
  return resolved === "/";
}
function sunPathMax(platform = process.platform) {
  return platform === "darwin" ? 104 : 108;
}
function supportsUnixSocketTransport(platform = process.platform) {
  return platform !== "win32";
}
function splitAbs(p) {
  const unc = p.match(/^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/);
  if (unc) return { root: `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`, segs: lexSegments(unc[3]) };
  const drive = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) return { root: `${drive[1].toLowerCase()}:`, segs: lexSegments(drive[2]) };
  if (p.startsWith("/")) return { root: "/", segs: lexSegments(p) };
  return { root: "", segs: [] };
}
function lexSegments(rest) {
  const out = [];
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out;
}
function isAbsolutePath(p) {
  return splitAbs(p).root !== "";
}
function relativePath(from, to) {
  const a = splitAbs(from);
  const b = splitAbs(to);
  if (a.root === "" || b.root === "" || a.root !== b.root) return to;
  let i = 0;
  while (i < a.segs.length && i < b.segs.length && a.segs[i] === b.segs[i]) i++;
  const up = a.segs.slice(i).map(() => "..");
  const rel = [...up, ...b.segs.slice(i)].join("/");
  return rel === "" ? "." : rel;
}
function isOutside(base, target) {
  const rel = relativePath(base, target);
  return rel === ".." || rel.startsWith("../") || isAbsolutePath(rel);
}
export {
  caseInsensitiveFilesystem,
  isAbsolutePath,
  isFilesystemRoot,
  isOutside,
  joinForDisplay,
  normalizePath,
  parsePathInput,
  relativePath,
  samePath,
  sunPathMax,
  supportsUnixSocketTransport,
  withTrailingSep
};
