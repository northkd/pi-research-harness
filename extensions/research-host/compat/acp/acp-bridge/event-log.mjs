import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
const LOG_NOTICE_TYPE = "acp-notice";
const FLUSH_DELAY_MS = 20;
function noticeEvent(dropped, now) {
  return {
    eventType: "custom_entry",
    timestamp: now,
    data: {
      customType: LOG_NOTICE_TYPE,
      data: `Earlier history was truncated to stay within the event-log size cap (${dropped} turn${dropped === 1 ? "" : "s"} dropped).`,
      acpDroppedTurns: dropped
    }
  };
}
const parseLine = (line) => {
  try {
    const v = JSON.parse(line);
    return typeof v?.eventType === "string" ? v : void 0;
  } catch {
    return void 0;
  }
};
const isNotice = (e) => e?.eventType === "custom_entry" && e.data?.customType === LOG_NOTICE_TYPE;
function createEventLog(opts) {
  const now = opts.now ?? Date.now;
  let onDisk = 0;
  let queue = [];
  let queuedBytes = 0;
  let timer;
  let chain = Promise.resolve();
  let ready;
  const init = () => {
    ready ??= fsp.mkdir(path.dirname(opts.file), { recursive: true, mode: 448 }).then(() => fsp.stat(opts.file)).then((st) => {
      onDisk = st.size;
    }).catch(() => {
      onDisk = 0;
    });
    return ready;
  };
  async function scan() {
    const unitEnds = [];
    let offset = 0;
    let notice;
    let first = true;
    const rl = readline.createInterface({ input: fs.createReadStream(opts.file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      offset += Buffer.byteLength(line) + 1;
      const ev = parseLine(line);
      if (first) {
        first = false;
        if (isNotice(ev)) {
          const dropped = Number(ev.data.acpDroppedTurns ?? 0);
          notice = { event: ev, dropped };
          unitEnds.push(offset);
          continue;
        }
      }
      if (ev?.eventType === "agent_settled") unitEnds.push(offset);
    }
    return { unitEnds, notice, total: offset };
  }
  async function truncate() {
    const { unitEnds, notice, total } = await scan();
    const target = Math.floor(opts.maxBytes * 0.5);
    const base = notice ? 1 : 0;
    const cuttable = unitEnds.slice(base);
    let cut = notice ? unitEnds[0] ?? 0 : 0;
    let droppedNow = 0;
    for (const end of cuttable) {
      if (total - cut <= target) break;
      cut = end;
      droppedNow += 1;
    }
    if (droppedNow === 0) return;
    const header = `${JSON.stringify(noticeEvent((notice?.dropped ?? 0) + droppedNow, now()))}
`;
    const tmp = `${opts.file}.tmp`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 384 });
      out.on("error", reject);
      out.on("finish", resolve);
      out.write(header);
      fs.createReadStream(opts.file, { start: cut }).on("error", reject).pipe(out);
    });
    await fsp.rename(tmp, opts.file);
    onDisk = (await fsp.stat(opts.file)).size;
  }
  async function write(batch, bytes) {
    await init();
    await fsp.appendFile(opts.file, batch, { mode: 384 });
    onDisk += bytes;
    if (onDisk > opts.maxBytes) await truncate();
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = void 0;
      drain();
    }, FLUSH_DELAY_MS);
    timer.unref?.();
  }
  function drain() {
    if (queue.length === 0) return;
    const batch = queue.join("");
    const bytes = queuedBytes;
    queue = [];
    queuedBytes = 0;
    chain = chain.then(() => write(batch, bytes)).catch(() => {
    });
  }
  return {
    append(event) {
      const line = `${JSON.stringify(event)}
`;
      queue.push(line);
      queuedBytes += Buffer.byteLength(line);
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = void 0;
      }
      drain();
      await chain;
    },
    async replay(emit, maxBytes) {
      await this.flush();
      if (!fs.existsSync(opts.file)) return;
      const input = fs.createReadStream(opts.file, {
        encoding: "utf8",
        ...maxBytes !== void 0 ? { end: Math.max(0, maxBytes - 1) } : {}
      });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of rl) {
        const ev = parseLine(line);
        if (ev) emit(ev);
      }
    },
    size: () => onDisk + queuedBytes
  };
}
export {
  LOG_NOTICE_TYPE,
  createEventLog
};
