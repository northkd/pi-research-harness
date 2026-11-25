var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/exec.ts
import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  exec as nodeExec,
  execFile as nodeExecFile,
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn
} from "node:child_process";
function withHide(opts) {
  const hide = opts?.windowsHide ?? true;
  return { ...opts ?? {}, windowsHide: hide };
}
function execFile(file, args, optionsOrCallback, maybeCallback) {
  if (typeof optionsOrCallback === "function") {
    return nodeExecFile(file, args ?? [], withHide(void 0), optionsOrCallback);
  }
  return nodeExecFile(file, args ?? [], withHide(optionsOrCallback), maybeCallback);
}
function spawn(command, args, options) {
  return nodeSpawn(command, args ?? [], withHide(options));
}
function settle(resolve2, reject) {
  return (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr }));
    else resolve2({ stdout, stderr });
  };
}
function execFileAsync(file, args, options) {
  return new Promise((resolve2, reject) => {
    execFile(file, args ?? [], { encoding: "utf8", ...options }, settle(resolve2, reject));
  });
}
var init_exec = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/exec.ts"() {
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/errors.ts
var DocConverterError;
var init_errors = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/errors.ts"() {
    DocConverterError = class extends Error {
      code;
      stderr;
      exitCode;
      constructor(init) {
        super(init.message);
        this.name = "DocConverterError";
        this.code = init.code;
        this.stderr = init.stderr;
        this.exitCode = init.exitCode;
      }
    };
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/engine.ts
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
function buildArgv(cfg, mounts) {
  const argv = [cfg.dockerBin ?? "docker", "run", "--rm", "-i"];
  for (const [target, { source, mode }] of mounts) {
    argv.push("-v", mode === "ro" ? `${source}:${target}:ro` : `${source}:${target}`);
  }
  for (const key of cfg.passEnv ?? ["GEMINI_API_KEY"]) {
    if (process.env[key] !== void 0) argv.push("-e", key);
  }
  argv.push(cfg.image);
  return argv;
}
function modeFor(req) {
  const apply = req.apply !== false;
  switch (req.command) {
    case "convertToMarkdown":
      return { writeKeys: /* @__PURE__ */ new Set(), othersRo: true };
    case "renderPdf":
      return { writeKeys: /* @__PURE__ */ new Set(["output"]), othersRo: true };
    case "renderDocx":
      return { writeKeys: /* @__PURE__ */ new Set(["output", "cacheDir"]), othersRo: false };
    case "extractForEdit":
    case "mergeBack":
      return { writeKeys: /* @__PURE__ */ new Set(["output"]), othersRo: false };
    case "fillFrontmatter":
    case "profileTables":
      return apply ? { writeKeys: /* @__PURE__ */ new Set(["paths"]), othersRo: false } : { writeKeys: /* @__PURE__ */ new Set(), othersRo: true };
    default:
      return { writeKeys: /* @__PURE__ */ new Set(), othersRo: false };
  }
}
async function realpathLoose(p) {
  let cur = resolve(p);
  const rest = [];
  for (; ; ) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}
async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
function notAllowed(path2, why, roots) {
  return new DocConverterError({
    code: "PATH_NOT_ALLOWED",
    message: `path not allowed: ${path2} (${why}). Configured roots: ${roots.join(", ") || "(none)"}. Pass \`mounts:[dir]\` or \`workspaceRoot\` to admit files outside the workspace.`
  });
}
async function planMounts(cfg, req) {
  const configured = [...cfg.writable ?? [], ...cfg.mounts ?? [], cfg.workspaceRoot ?? process.cwd()];
  for (const w of cfg.writable ?? []) await mkdir(w, { recursive: true });
  const roots = [];
  for (const r of configured) {
    const real = await realpathLoose(r);
    if (real === sep || resolve(r) === sep) throw notAllowed(r, "`/` cannot be a root", configured);
    roots.push(real);
  }
  const home = homedir();
  const deny = [];
  for (const d of [...DENYLIST, ...HOME_DENYLIST.map((h) => join(home, h))]) {
    deny.push([.../* @__PURE__ */ new Set([d, await realpathLoose(d)])]);
  }
  const plan = /* @__PURE__ */ new Map();
  const addMount = (target, source, mode) => {
    const prev = plan.get(target);
    plan.set(target, { source, mode: prev?.mode === "rw" ? "rw" : mode });
  };
  for (const w of cfg.writable ?? []) addMount(resolve(w), await realpathLoose(w), "rw");
  const { writeKeys, othersRo } = modeFor(req);
  const check = async (p, mode) => {
    if (!isAbsolute(p)) return;
    if (p.split(/[\\/]/).includes("..")) throw notAllowed(p, "`..` segment", configured);
    if (p.includes(":")) throw notAllowed(p, "`:` breaks the bind-mount spec", configured);
    const lexical = resolve(p);
    const globAt = lexical.search(/[*?[]/);
    let target;
    if (globAt >= 0) target = dirname(lexical.slice(0, globAt + 1));
    else if (await isDir(lexical)) target = lexical;
    else target = dirname(lexical);
    const realPath = await realpathLoose(lexical.slice(0, globAt >= 0 ? globAt : void 0));
    const source = await realpathLoose(target);
    const containing = roots.filter((r) => isUnder(realPath, r) && isUnder(source, r));
    if (containing.length === 0) throw notAllowed(p, "outside every configured root", configured);
    for (const variants of deny) {
      const hit = variants.some((d) => isUnder(source, d) || isUnder(realPath, d) || globAt >= 0 && isUnder(d, source));
      if (!hit) continue;
      const optedIn = containing.some((r) => variants.some((d) => isUnder(r, d)));
      if (!optedIn) throw notAllowed(p, `sensitive directory ${variants[0]}`, configured);
    }
    addMount(target, source, mode);
  };
  for (const [k, v] of Object.entries(req)) {
    if (k === "command") continue;
    const mode = writeKeys.has(k) || !othersRo ? "rw" : "ro";
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === "string") await check(item, mode);
    }
  }
  for (const { source, mode } of plan.values()) {
    if (mode === "rw" && !await isDir(source)) await mkdir(source, { recursive: true });
  }
  return plan;
}
async function runEngine(cfg, req) {
  const runner = cfg.runner ?? defaultRunner;
  const argv = buildArgv(cfg, await planMounts(cfg, req));
  const { stdout, stderr, exitCode } = await runner(argv, JSON.stringify(req));
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new DocConverterError({
      code: exitCode === 0 ? "BAD_RESPONSE" : "ENGINE_NONZERO",
      message: exitCode === 0 ? "engine returned non-JSON output" : `engine exited ${exitCode}`,
      stderr: stderr || stdout,
      exitCode
    });
  }
  if (parsed.ok === false) {
    const { code, message, stderr: estderr } = parsed.error;
    throw new DocConverterError({
      code: mapEngineCode(code),
      message,
      stderr: estderr ?? stderr,
      exitCode
    });
  }
  if (exitCode !== 0) {
    throw new DocConverterError({
      code: "ENGINE_NONZERO",
      message: `engine exited ${exitCode} despite ok envelope`,
      stderr,
      exitCode
    });
  }
  const { ok: _ok, ...rest } = parsed;
  return rest;
}
function mapEngineCode(code) {
  switch (code) {
    case "INPUT_NOT_FOUND":
      return "INPUT_NOT_FOUND";
    case "OCR_ENGINE_UNKNOWN":
      return "OCR_ENGINE_UNKNOWN";
    case "INGEST_FAILED":
    case "DOCLING_UNAVAILABLE":
      return "INGEST_FAILED";
    case "MMDC_UNAVAILABLE":
      return "MMDC_UNAVAILABLE";
    case "PRODUCE_FAILED":
    case "MMDC_FAILED":
      return "PRODUCE_FAILED";
    case "FILL_FAILED":
      return "FILL_FAILED";
    case "PROFILE_FAILED":
      return "PROFILE_FAILED";
    default:
      return "INTERNAL";
  }
}
var defaultRunner, DENYLIST, HOME_DENYLIST, isUnder;
var init_engine = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/engine.ts"() {
    init_exec();
    init_errors();
    defaultRunner = (argv, stdin) => new Promise((resolve2, reject) => {
      const [bin, ...args] = argv;
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      if (!child.stdout || !child.stderr || !child.stdin) {
        reject(
          new DocConverterError({
            code: "DOCKER_UNAVAILABLE",
            message: `spawned ${bin} without piped stdio`
          })
        );
        return;
      }
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => stdout += d.toString());
      child.stderr.on("data", (d) => stderr += d.toString());
      child.on("error", (err) => {
        reject(
          new DocConverterError({
            code: "DOCKER_UNAVAILABLE",
            message: `failed to spawn ${bin}: ${err.message}`
          })
        );
      });
      child.on("close", (code) => resolve2({ stdout, stderr, exitCode: code ?? -1 }));
      child.stdin.end(stdin);
    });
    DENYLIST = ["/etc", "/root", "/var/run", "/proc", "/sys", "/dev"];
    HOME_DENYLIST = [".ssh", ".aws", ".gnupg", ".config", ".pi", ".docker", ".kube"];
    isUnder = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/ocr.ts
function mapOcrCodes(langs, engine) {
  if (engine === "rapidocr") return [];
  return langs.map((raw) => {
    const name = raw.trim().toLowerCase();
    const entry = LANG_CODES[name];
    const code = entry?.[engine];
    if (!code) {
      throw new DocConverterError({
        code: "OCR_LANG_UNSUPPORTED",
        message: `language "${raw}" is not supported by OCR engine "${engine}"`
      });
    }
    return code;
  });
}
var LANG_CODES, SUPPORTED_LANGUAGES;
var init_ocr = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/ocr.ts"() {
    init_errors();
    LANG_CODES = {
      english: { easyocr: "en", tesseract: "eng", ocrmac: "en-US" },
      hungarian: { easyocr: "hu", tesseract: "hun", ocrmac: "hu-HU" },
      german: { easyocr: "de", tesseract: "deu", ocrmac: "de-DE" },
      french: { easyocr: "fr", tesseract: "fra", ocrmac: "fr-FR" },
      spanish: { easyocr: "es", tesseract: "spa", ocrmac: "es-ES" },
      italian: { easyocr: "it", tesseract: "ita", ocrmac: "it-IT" }
    };
    SUPPORTED_LANGUAGES = Object.keys(LANG_CODES);
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/provenance.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
async function sha256File(path2) {
  const buf = await readFile(path2);
  return createHash("sha256").update(buf).digest("hex");
}
function buildProvenance(input) {
  const prov = {
    source_path: input.sourcePath,
    sha256: input.sha256,
    doc_type: input.docType,
    converted_at: input.convertedAt ?? (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.page !== void 0) prov.page = input.page;
  if (input.slide !== void 0) prov.slide = input.slide;
  return prov;
}
function provenanceKeys(prov) {
  const lines = ["provenance:"];
  lines.push(`  source_path: ${yamlScalar(prov.source_path)}`);
  lines.push(`  sha256: ${prov.sha256}`);
  lines.push(`  doc_type: ${prov.doc_type}`);
  lines.push(`  converted_at: ${yamlScalar(prov.converted_at)}`);
  if (prov.page !== void 0) lines.push(`  page: ${prov.page}`);
  if (prov.slide !== void 0) lines.push(`  slide: ${prov.slide}`);
  return lines.join("\n");
}
function provenanceFrontmatter(prov) {
  return `---
${provenanceKeys(prov)}
---
`;
}
function stampProvenance(markdown, prov) {
  if (!markdown.startsWith("---\n")) {
    return `${provenanceFrontmatter(prov)}${markdown}`;
  }
  return `---
${provenanceKeys(prov)}
${markdown.slice(4)}`;
}
function yamlScalar(value) {
  if (/^[\w./@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
var init_provenance = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/provenance.ts"() {
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/routing.ts
import { extname } from "node:path";
function docTypeOf(path2) {
  const ext = extname(path2).toLowerCase();
  const t = EXT_TO_DOCTYPE[ext];
  if (!t) {
    throw new DocConverterError({
      code: "UNSUPPORTED_FORMAT",
      message: `unsupported file extension: ${ext || "(none)"}`
    });
  }
  return t;
}
function isIngestable(path2) {
  const ext = extname(path2).toLowerCase();
  const t = EXT_TO_DOCTYPE[ext];
  return t !== void 0 && INGESTABLE.has(t);
}
function ingestDocType(path2) {
  const t = docTypeOf(path2);
  if (!INGESTABLE.has(t)) {
    throw new DocConverterError({
      code: "UNSUPPORTED_FORMAT",
      message: `cannot ingest ${t} to Markdown`
    });
  }
  return t;
}
var EXT_TO_DOCTYPE, INGESTABLE;
var init_routing = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/routing.ts"() {
    init_errors();
    EXT_TO_DOCTYPE = {
      ".pdf": "pdf",
      ".docx": "docx",
      ".pptx": "pptx",
      ".xlsx": "xlsx",
      ".md": "md",
      ".markdown": "md",
      ".mdx": "md"
    };
    INGESTABLE = /* @__PURE__ */ new Set(["pdf", "docx", "pptx", "xlsx"]);
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/types.ts
var init_types = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/types.ts"() {
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/index.ts
var src_exports = {};
__export(src_exports, {
  DocConverterError: () => DocConverterError,
  SUPPORTED_LANGUAGES: () => SUPPORTED_LANGUAGES,
  buildProvenance: () => buildProvenance,
  createDocumentConverter: () => createDocumentConverter,
  docTypeOf: () => docTypeOf,
  ingestDocType: () => ingestDocType,
  isIngestable: () => isIngestable,
  mapOcrCodes: () => mapOcrCodes,
  provenanceFrontmatter: () => provenanceFrontmatter,
  sha256File: () => sha256File,
  stampProvenance: () => stampProvenance
});
import { mkdir as mkdir2, writeFile } from "node:fs/promises";
import { basename as basename2, join as join2 } from "node:path";
function createDocumentConverter(config) {
  const engineCfg = (extraMounts = []) => ({
    image: config.image,
    writable: [config.stagingDir],
    mounts: [...config.mounts ?? [], ...extraMounts],
    workspaceRoot: config.workspaceRoot,
    ...config.engine
  });
  return {
    /** Ingest any supported format -> provenance-stamped Markdown for kb. */
    async convertToMarkdown(input, opts = {}) {
      const docType = ingestDocType(input);
      const ocr = opts.ocr ?? {};
      const engine = ocr.engine ?? "easyocr";
      const codes = ocr.lang ? mapOcrCodes(ocr.lang, engine) : [];
      const { markdown } = await runEngine(engineCfg(), {
        command: "convertToMarkdown",
        input,
        ocr: { mode: ocr.mode ?? "auto", engine, codes },
        tables: opts.tables ?? "on"
      });
      const sha256 = await sha256File(input);
      const provenance = buildProvenance({ sourcePath: input, sha256, docType });
      const body = stampProvenance(markdown, provenance);
      await mkdir2(config.stagingDir, { recursive: true });
      const output = opts.output ?? join2(config.stagingDir, replaceExt(basename2(input), ".md"));
      await writeFile(output, body, "utf-8");
      return { output, provenance };
    },
    /** Markdown -> templated DOCX (TOC, cover, diagrams from frontmatter). */
    async renderDocx(input, opts) {
      return runEngine(engineCfg(), {
        command: "renderDocx",
        input,
        output: opts.output,
        template: opts.template,
        templatesDir: opts.templatesDir,
        language: opts.language,
        nano_banana: opts.nanoBanana,
        cacheDir: opts.cacheDir
      });
    },
    /** Markdown|DOCX -> PDF (pandoc/Gotenberg path). */
    async renderPdf(input, opts) {
      return runEngine(engineCfg(), {
        command: "renderPdf",
        input,
        output: opts.output,
        pageSize: opts.pageSize,
        template: opts.template
      });
    },
    /** DOCX -> editable Markdown + `document_meta.xml` for round-trip. */
    async extractForEdit(input, output) {
      return runEngine(engineCfg(), {
        command: "extractForEdit",
        input,
        output
      });
    },
    /** Merge edited Markdown back into a DOCX, preserving formatting. */
    async mergeBack(original, edited, opts) {
      return runEngine(engineCfg(), {
        command: "mergeBack",
        original,
        edited,
        output: opts.output,
        meta: opts.meta
      });
    },
    /** Fill/refresh YAML frontmatter across Markdown files. */
    async fillFrontmatter(paths, opts = {}) {
      await runEngine(engineCfg(), {
        command: "fillFrontmatter",
        paths,
        mode: opts.mode,
        config: opts.config,
        language: opts.language,
        set: opts.set,
        apply: opts.apply ?? true
      });
    },
    /** Inject `table_profiles:` width ratios into frontmatter. */
    async profileTables(paths, opts = {}) {
      await runEngine(engineCfg(), {
        command: "profileTables",
        paths,
        apply: opts.apply ?? true,
        percentile: opts.percentile,
        smoothing: opts.smoothing
      });
    }
  };
}
function replaceExt(name, ext) {
  return name.replace(/\.[^.]+$/, "") + ext;
}
var init_src = __esm({
  "dashboard/node_modules/@blackbelt-technology/pi-dashboard-document-converter/src/index.ts"() {
    init_engine();
    init_ocr();
    init_provenance();
    init_routing();
    init_errors();
    init_ocr();
    init_provenance();
    init_routing();
    init_types();
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/office-preview.ts
import { createHash as createHash2 } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/file-kind.ts
var MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
var DIGEST_CEILING_BYTES = 256 * 1024 * 1024;
var OFFICE_SIZE_CAPS = {
  docx: 40 * 1024 * 1024,
  pptx: 100 * 1024 * 1024,
  sheet: 50 * 1024 * 1024
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/office-preview.ts
init_exec();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/purify.ts
import { createRequire } from "node:module";
var nativeRequire = createRequire(import.meta.url);
var cached = null;
async function loadPurify() {
  if (cached) return cached;
  const mod = nativeRequire("isomorphic-dompurify");
  const purify = mod.default ?? mod;
  if (typeof purify?.sanitize !== "function") {
    throw new Error("DOMPurify unavailable: sanitize() missing (jsdom failed to initialise)");
  }
  if (purify.isSupported !== true) {
    throw new Error("DOMPurify unavailable: no DOM support (jsdom failed to initialise)");
  }
  cached = purify;
  return purify;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/office-preview.ts
var OFFICE_CAPS = {
  // Size caps are shared with the client (too-large notice names the real
  // limit). Decks run large; download is the escape hatch (design P5).
  docxSizeCap: OFFICE_SIZE_CAPS.docx,
  pptxSizeCap: OFFICE_SIZE_CAPS.pptx,
  sheetSizeCap: OFFICE_SIZE_CAPS.sheet,
  imageCap: 20,
  htmlByteCap: 2 * 1024 * 1024,
  rowCap: 500,
  rowCapMax: 5e3,
  colCap: 100
};
function hyperlinkGuard(doc) {
  const walk = (n) => {
    if (!n) return;
    if (n.type === "hyperlink" && n.href == null && n.anchor == null) n.href = "";
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(doc);
  return doc;
}
function applyImageCap(html, imageCount, caps) {
  const over = imageCount > caps.imageCap || Buffer.byteLength(html, "utf8") > caps.htmlByteCap;
  if (!over) return { html, truncated: false };
  const stripped = html.replace(
    /<img\b[^>]*>/gi,
    '<span class="preview-image-placeholder" data-preview-stripped="1">[image removed \u2014 download for full document]</span>'
  );
  return { html: stripped, truncated: true };
}
function pdfCacheDir() {
  return path.join(os.tmpdir(), "pi-dashboard-docx-pdf");
}
function pdfCachePath(resolved, mtimeMs, size) {
  const key = createHash2("sha256").update(`${resolved}\0${mtimeMs}\0${size}`).digest("hex");
  return path.join(pdfCacheDir(), `${key}.pdf`);
}
function createDefaultDocxPdfEngine(opts) {
  const image = opts?.image ?? process.env.PI_DOC_ENGINE_IMAGE ?? "pi-doc-engine";
  const ttlMs = opts?.ttlMs ?? 3e4;
  let cached2 = null;
  return {
    async available() {
      const now = Date.now();
      if (cached2 && now - cached2.at < ttlMs) return cached2.ok;
      let ok = false;
      try {
        await execFileAsync("docker", ["image", "inspect", image], { timeout: 5e3 });
        ok = true;
      } catch {
        ok = false;
      }
      cached2 = { at: now, ok };
      return ok;
    },
    async toPdf(docxPath, outPath) {
      const { createDocumentConverter: createDocumentConverter2 } = await Promise.resolve().then(() => (init_src(), src_exports));
      const dc = createDocumentConverter2({
        image,
        stagingDir: path.dirname(outPath),
        mounts: [path.dirname(docxPath)],
        engine: { passEnv: [], runner: opts?.runner }
      });
      const { output } = await dc.renderPdf(docxPath, { output: outPath });
      if (output !== outPath) await fs.copyFile(output, outPath);
    }
  };
}
async function renderDocx(resolved, stat2, opts) {
  const { mode, engine, caps } = opts;
  if (mode !== "html") {
    try {
      if (await engine.available()) {
        const out = pdfCachePath(resolved, stat2.mtimeMs, stat2.size);
        await fs.mkdir(pdfCacheDir(), { recursive: true });
        try {
          await fs.access(out);
        } catch {
          await engine.toPdf(resolved, out);
        }
        return { success: true, mode: "pdf" };
      }
    } catch {
    }
  }
  try {
    const buffer = await fs.readFile(resolved);
    const mammoth = (await import("mammoth")).default ?? await import("mammoth");
    let imageCount = 0;
    const convertImage = mammoth.images.imgElement(
      (img) => img.read("base64").then((data) => {
        imageCount += 1;
        return { src: `data:${img.contentType};base64,${data}` };
      })
    );
    const result = await mammoth.convertToHtml(
      { buffer },
      { transformDocument: hyperlinkGuard, convertImage }
    );
    const DOMPurify = await loadPurify();
    const clean = DOMPurify.sanitize(result.value ?? "", {
      FORBID_TAGS: ["script", "style"]
    });
    const { html, truncated } = applyImageCap(clean, imageCount, caps);
    return {
      success: true,
      mode: "html",
      html,
      truncated,
      imageCount,
      ...truncated ? { note: "Images trimmed \u2014 download for the full document." } : {}
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "failed to render docx" };
  }
}
async function renderPptx(resolved, stat2, opts) {
  try {
    if (await opts.engine.available()) {
      const out = pdfCachePath(resolved, stat2.mtimeMs, stat2.size);
      await fs.mkdir(pdfCacheDir(), { recursive: true });
      try {
        await fs.access(out);
      } catch {
        await opts.engine.toPdf(resolved, out);
      }
      return { success: true, mode: "pdf" };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "failed to render pptx" };
  }
  return { success: false, error: "presentation rendering requires the document engine" };
}
function pickCsvEncoding(ranking, margin = 3) {
  if (ranking.length === 0) return "UTF-8";
  const top = ranking[0];
  const LATIN1 = /* @__PURE__ */ new Set(["ISO-8859-1", "windows-1252"]);
  const LATIN2 = /* @__PURE__ */ new Set(["ISO-8859-2", "windows-1250"]);
  if (LATIN1.has(top.name)) {
    const alt = ranking.find(
      (c) => LATIN2.has(c.name) && c.confidence >= top.confidence - margin
    );
    if (alt) return alt.name;
  }
  return top.name;
}
function resolveRowLimit(limit, caps) {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return caps.rowCap;
  return Math.min(Math.floor(limit), caps.rowCapMax);
}
function toCells(matrix, rowLimit, colCap) {
  const totalRows = Math.max(0, matrix.length - 1);
  let totalCols = 0;
  for (const r of matrix) totalCols = Math.max(totalCols, r.length);
  const cap = Math.min(totalCols, colCap);
  const norm = (r) => {
    const out = [];
    for (let i = 0; i < cap; i++) out.push(r[i] == null ? "" : String(r[i]));
    return out;
  };
  const header = matrix.length > 0 ? norm(matrix[0]) : [];
  const bodyAll = matrix.slice(1);
  const rows = bodyAll.slice(0, rowLimit).map(norm);
  return {
    name: "",
    header,
    rows,
    totalRows,
    totalCols,
    truncated: bodyAll.length > rowLimit
  };
}
async function parseSheet(buffer, ext, opts) {
  try {
    const XLSX = (await import("xlsx")).default ?? await import("xlsx");
    let encoding;
    let wb;
    if (ext === ".csv") {
      const chardet = (await import("chardet")).default ?? await import("chardet");
      const ranking = chardet.analyse(buffer);
      const detected = pickCsvEncoding(ranking);
      encoding = detected;
      const iconv = (await import("iconv-lite")).default ?? await import("iconv-lite");
      const decoded = iconv.decode(buffer, detected);
      wb = XLSX.read(decoded, { type: "string" });
    } else {
      wb = XLSX.read(buffer, { type: "buffer" });
    }
    const sheets = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
      const data = toCells(matrix, opts.rowLimit, opts.colCap);
      data.name = name;
      return data;
    });
    if (sheets.length === 0) return { success: false, error: "no sheets found" };
    return { success: true, sheets, activeSheet: 0, ...encoding ? { encoding } : {} };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "failed to parse spreadsheet" };
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/eml.ts
import fs2 from "node:fs/promises";
import { simpleParser } from "mailparser";
var EML_SIZE_CAP = 25 * 1024 * 1024;
var CACHE_MAX = 8;
var parseCache = [];
function cacheKey(absPath, stat2) {
  return `${absPath}|${stat2.dev}|${stat2.ino}|${stat2.mtimeMs}|${stat2.ctimeMs}|${stat2.size}`;
}
async function parseEmlBuffer(buf) {
  return simpleParser(buf);
}
async function loadParsedEml(absPath, stat2, prefetched) {
  const key = cacheKey(absPath, stat2);
  if (prefetched) {
    const parsed2 = await parseEmlBuffer(prefetched);
    rememberParsed(key, parsed2);
    return parsed2;
  }
  const hitIdx = parseCache.findIndex((e) => e.key === key);
  if (hitIdx >= 0) {
    const [hit] = parseCache.splice(hitIdx, 1);
    parseCache.unshift(hit);
    return hit.parsed;
  }
  const parsed = await parseEmlBuffer(await fs2.readFile(absPath));
  rememberParsed(key, parsed);
  return parsed;
}
function rememberParsed(key, parsed) {
  const hitIdx = parseCache.findIndex((e) => e.key === key);
  if (hitIdx >= 0) parseCache.splice(hitIdx, 1);
  parseCache.unshift({ key, parsed });
  if (parseCache.length > CACHE_MAX) parseCache.length = CACHE_MAX;
}
function stripAngle(id) {
  if (!id) return null;
  return id.replace(/^<|>$/g, "");
}
function isRemoteRef(value) {
  return value.toLowerCase().split(",").some((part) => {
    const p = part.trim();
    return p.startsWith("http://") || p.startsWith("https://") || p.startsWith("//");
  });
}
var CSS_URL_RE = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
var CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;
function neutralizeCssUrls(css, allowRemote) {
  let found = false;
  let out = css.replace(CSS_URL_RE, (match, _quote, ref) => {
    if (!isRemoteRef(ref)) return match;
    found = true;
    return allowRemote ? match : "url(about:blank)";
  });
  out = out.replace(CSS_IMPORT_RE, (match, quote, ref) => {
    if (!isRemoteRef(ref)) return match;
    found = true;
    return allowRemote ? match : `@import ${quote}about:blank${quote}`;
  });
  return { css: out, found };
}
var REF_ATTRS = ["src", "srcset", "background", "poster"];
async function sanitizeBody(rawHtml, opts) {
  if (!rawHtml) return { html: "", hasRemote: false };
  const DOMPurify = await loadPurify();
  const bodyEl = DOMPurify.sanitize(rawHtml, {
    RETURN_DOM: true,
    WHOLE_DOCUMENT: false,
    // FORCE_BODY keeps a leading `<style>` from being hoisted to <head> + dropped.
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target"]
  });
  let hasRemote = false;
  const elements = [bodyEl, ...Array.from(bodyEl.querySelectorAll("*"))];
  for (const el of elements) {
    for (const attr of REF_ATTRS) {
      const v = el.getAttribute?.(attr);
      if (v && isRemoteRef(v)) {
        hasRemote = true;
        if (!opts.allowRemote) {
          el.removeAttribute(attr);
          el.setAttribute(`data-blocked-${attr}`, v);
        }
      }
    }
    const style = el.getAttribute?.("style");
    if (style) {
      const { css, found } = neutralizeCssUrls(style, opts.allowRemote);
      if (found) {
        hasRemote = true;
        if (!opts.allowRemote) el.setAttribute("style", css);
      }
    }
  }
  for (const styleEl of Array.from(bodyEl.querySelectorAll("style"))) {
    const { css, found } = neutralizeCssUrls(styleEl.textContent || "", opts.allowRemote);
    if (found) {
      hasRemote = true;
      if (!opts.allowRemote) styleEl.textContent = css;
    }
  }
  return { html: bodyEl.innerHTML, hasRemote };
}
function deinlineCidImages(html, attachments) {
  let out = html;
  for (const a of attachments || []) {
    const cid = stripAngle(a.contentId);
    if (!cid || !a.content) continue;
    const dataUri = `data:${a.contentType || "application/octet-stream"};base64,${a.content.toString("base64")}`;
    out = out.split(dataUri).join(`cid:${cid}`);
  }
  return out;
}
async function toParseResult(parsed, opts) {
  const rawHtml = deinlineCidImages(parsed.html || "", parsed.attachments);
  const { html, hasRemote } = await sanitizeBody(rawHtml, opts);
  const attachments = (parsed.attachments || []).map((a, index) => ({
    index,
    filename: a.filename || `attachment-${index}`,
    mimeType: a.contentType || "application/octet-stream",
    size: a.size ?? a.content?.length ?? 0,
    contentId: stripAngle(a.contentId),
    isInline: Boolean(a.related) || a.contentDisposition === "inline"
  }));
  return {
    headers: {
      from: parsed.from?.text || "",
      to: Array.isArray(parsed.to) ? parsed.to.map((x) => x.text).join(", ") : parsed.to?.text || "",
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((x) => x.text).join(", ") : parsed.cc?.text || "",
      subject: parsed.subject || "",
      date: parsed.date ? parsed.date.toISOString() : ""
    },
    html,
    text: parsed.text || "",
    attachments,
    hasRemote
  };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/markup-repair/asciidoc.ts
var A1_RE = /^\[mermaid(,[^\]]*)?\][ \t]*$/;
var PRELUDE_RE = /^(\.[^.\s].*|\[\[.*\]\]|\[#.*\]|\[.*\])$/;
var LISTING_RE = /^(-{4,}|\.{4,})$/;
var VERBATIM_RE = /^(-{4,}|\.{4,}|\/{4,}|\+{4,})$/;
var STRUCTURAL_RE = /^(={4,}|\*{4,}|_{4,}|--|[|,:!]={3,})$/;
var SECTION_RE = /^={1,6}[ \t]+\S/;
var BLANK_RE = /^[ \t]*$/;
function splitLines(src) {
  const out = [];
  const re = /[^\n]*\n|[^\n]+$/g;
  for (const m of src.matchAll(re)) {
    const raw = m[0];
    const text = raw.replace(/\r?\n$/, "");
    out.push({ text, eol: raw.slice(text.length) });
  }
  return out;
}
var join3 = (lines) => lines.map((l) => l.text + l.eol).join("");
function a1Opener(lines, i) {
  if (!A1_RE.test(lines[i].text)) return -1;
  let j = i + 1;
  while (j < lines.length && PRELUDE_RE.test(lines[j].text)) j++;
  return j < lines.length && LISTING_RE.test(lines[j].text) ? j : -1;
}
function a2Fix(lines, i, t) {
  let boundary = -1;
  for (let x = i + 2; x < lines.length; x++) {
    if (SECTION_RE.test(lines[x].text) && BLANK_RE.test(lines[x - 1].text)) {
      boundary = x - 1;
      break;
    }
  }
  const limit = boundary === -1 ? lines.length : boundary;
  const ch = t[0];
  for (let x = i + 1; x < limit; x++) {
    const lt = lines[x].text;
    if (lt.length >= 4 && lt.length !== t.length && lt === ch.repeat(lt.length)) return { kind: "replace", at: x };
  }
  return boundary === -1 ? null : { kind: "insert", before: boundary };
}
function repairAsciiDoc(src) {
  const lines = splitLines(src);
  const n = lines.length;
  const out = [];
  const repairs = [];
  const stack = [];
  const copy = (from, to) => {
    for (let x = from; x < to; x++) out.push(lines[x]);
  };
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const t = line.text;
    if (a1Opener(lines, i) >= 0) {
      out.push({ text: `[source,${t.slice(1)}`, eol: line.eol });
      repairs.push({ rule: "A1", line: i + 1 });
      i++;
      continue;
    }
    if (VERBATIM_RE.test(t)) {
      let k = i + 1;
      while (k < n && lines[k].text !== t) k++;
      if (k < n) {
        copy(i, k + 1);
        i = k + 1;
        continue;
      }
      const nested = stack.length > 0 || i > 0 && lines[i - 1].text === "+";
      const fix = nested || !LISTING_RE.test(t) ? null : a2Fix(lines, i, t);
      if (!fix) {
        copy(i, n);
        break;
      }
      repairs.push({ rule: "A2", line: i + 1 });
      if (fix.kind === "replace") {
        copy(i, fix.at);
        out.push({ text: t, eol: lines[fix.at].eol });
        i = fix.at + 1;
      } else {
        copy(i, fix.before);
        out.push({ text: t, eol: line.eol });
        i = fix.before;
      }
      continue;
    }
    if (STRUCTURAL_RE.test(t)) {
      if (stack[stack.length - 1] === t) stack.pop();
      else stack.push(t);
    }
    out.push(line);
    i++;
  }
  return repairs.length === 0 ? { source: src, repairs } : { source: join3(out), repairs };
}
export {
  EML_SIZE_CAP,
  OFFICE_CAPS,
  createDefaultDocxPdfEngine,
  loadParsedEml,
  loadPurify,
  parseSheet,
  pdfCachePath,
  renderDocx,
  renderPptx,
  repairAsciiDoc,
  resolveRowLimit,
  toParseResult
};
