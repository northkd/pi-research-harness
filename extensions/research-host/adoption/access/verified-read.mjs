import { constants, promises as fs } from "node:fs";
class VerifiedReadRefused extends Error {
  reason;
  subject;
  constructor(reason, subject) {
    super(`refused grant-admitted read of ${subject}: ${reason}`);
    this.name = "VerifiedReadRefused";
    this.reason = reason;
    this.subject = subject;
  }
}
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const SYMLINK_ERRNOS = /* @__PURE__ */ new Set(["ELOOP", "EMLINK"]);
async function openVerifiedRegularFile(resolved) {
  const linkStat = await fs.lstat(resolved);
  if (!linkStat.isFile()) throw new VerifiedReadRefused("not-regular", resolved);
  let handle;
  try {
    handle = await fs.open(resolved, OPEN_FLAGS);
  } catch (err) {
    const code = err.code;
    if (code && SYMLINK_ERRNOS.has(code)) {
      throw new VerifiedReadRefused("not-regular", resolved);
    }
    throw err;
  }
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.dev !== linkStat.dev || handleStat.ino !== linkStat.ino) {
      throw new VerifiedReadRefused("handle-mismatch", resolved);
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {
    });
    throw err;
  }
}
async function assertRegularFile(resolved) {
  const linkStat = await fs.lstat(resolved);
  if (!linkStat.isFile()) throw new VerifiedReadRefused("not-regular", resolved);
}
async function readFileVerified(resolved) {
  const handle = await openVerifiedRegularFile(resolved);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function readFileVerifiedUtf8(resolved) {
  return (await readFileVerified(resolved)).toString("utf-8");
}
export {
  VerifiedReadRefused,
  assertRegularFile,
  openVerifiedRegularFile,
  readFileVerified,
  readFileVerifiedUtf8
};
