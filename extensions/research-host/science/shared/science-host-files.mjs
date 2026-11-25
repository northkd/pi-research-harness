import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
function scienceHostPaths(privateDir) {
  if (!path.isAbsolute(privateDir) || privateDir.includes("\0") || path.resolve(privateDir) !== privateDir) throw new Error("science-host-private-directory");
  return { privateDir, socket: path.join(privateDir, "viewer.sock"), secret: path.join(privateDir, "viewer.secret") };
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function sciencePrivateDirectory(privateDir, uid = process.getuid?.()) {
  if (process.platform !== "linux" || uid === void 0) throw new Error("science-host-platform-unavailable");
  scienceHostPaths(privateDir);
  const stat = await lstat(privateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 511) !== 448 || await realpath(privateDir) !== privateDir) throw new Error("science-host-private-directory");
  return stat;
}
async function readScienceHostSecret(privateDir, uid = process.getuid?.()) {
  const beforeDir = await sciencePrivateDirectory(privateDir, uid);
  const file = scienceHostPaths(privateDir).secret;
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid || (before.mode & 511) !== 384 || before.size !== 32) throw new Error("science-host-private-credential");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!same(before, stat) || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 511) !== 384 || stat.size !== 32) throw new Error("science-host-private-credential");
    const data = Buffer.alloc(32);
    const { bytesRead } = await handle.read(data, 0, 32, 0);
    const after = await handle.stat();
    const current = await lstat(file);
    const afterDir = await sciencePrivateDirectory(privateDir, uid);
    if (bytesRead !== 32 || !same(before, after) || !same(before, current) || !same(beforeDir, afterDir) || after.size !== 32 || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.nlink !== 1 || current.uid !== uid || (current.mode & 511) !== 384) throw new Error("science-host-private-credential");
    return data;
  } finally {
    await handle.close();
  }
}
async function verifyScienceHostSocket(privateDir, uid = process.getuid?.()) {
  await sciencePrivateDirectory(privateDir, uid);
  const stat = await lstat(scienceHostPaths(privateDir).socket);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 511) !== 384) throw new Error("science-host-private-socket");
  return stat;
}
export {
  readScienceHostSecret,
  scienceHostPaths,
  sciencePrivateDirectory,
  verifyScienceHostSocket
};
