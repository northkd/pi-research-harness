import fs from "node:fs";
import path from "node:path";
const getDashboardConfigDir = () => {
  throw new Error("question-directory-required");
};
const QUESTION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
function isQuestionFile(v, id) {
  if (!v || typeof v !== "object") return false;
  const f = v;
  return f.version === 1 && f.id === id && typeof f.sessionId === "string" && typeof f.promptId === "string" && typeof f.askedAt === "number" && typeof f.briefStatus === "string" && !!f.snapshot && typeof f.snapshot === "object";
}
function createQuestionFileStore(opts = {}) {
  const dir = opts.dir ?? path.join(getDashboardConfigDir(), "questions");
  const pathOf = (id) => path.join(dir, `${id}.json`);
  function remove(id) {
    if (!QUESTION_ID_RE.test(id)) return;
    try {
      fs.unlinkSync(pathOf(id));
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[questions] remove ${id} failed:`, err.message);
    }
  }
  return {
    dir,
    loadAll() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const out = [];
      for (const name of names) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!QUESTION_ID_RE.test(id)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(pathOf(id), "utf8"));
          if (isQuestionFile(parsed, id)) out.push(parsed);
          else console.error(`[questions] ignoring malformed question file ${name}`);
        } catch (err) {
          console.error(`[questions] ignoring unreadable question file ${name}:`, err.message);
        }
      }
      return out;
    },
    write(file) {
      if (!QUESTION_ID_RE.test(file.id)) throw new Error(`invalid question id: ${file.id}`);
      fs.mkdirSync(dir, { recursive: true, mode: 448 });
      fs.chmodSync(dir, 448);
      const tmp = `${pathOf(file.id)}.${process.pid}.tmp`;
      try {
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, JSON.stringify(file), { mode: 384, flag: "wx" });
        fs.renameSync(tmp, pathOf(file.id));
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
        }
        throw err;
      }
    },
    remove,
    sweep(presence) {
      const deleted = [];
      for (const file of this.loadAll()) {
        if (presence(file.sessionId) !== "present") {
          remove(file.id);
          deleted.push(file.id);
        }
      }
      return deleted;
    }
  };
}
export {
  createQuestionFileStore
};
