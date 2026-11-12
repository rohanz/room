// packages/relay/src/private-core.ts
import fs from "node:fs";
import path from "node:path";
function privateDirectoryPath(dir) {
  dir = path.resolve(dir);
  const directories = [dir];
  let root = dir;
  while (path.basename(root) !== "room" && path.dirname(root) !== root) {
    root = path.dirname(root);
    directories.unshift(root);
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`);
  }
  return { directories, root, inState: path.basename(root) === "room" };
}
function verifyPosixPath(file, stat = fs.lstatSync(file)) {
  if (stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 63) !== 0) {
    throw new Error(`Room state must be owned by the current user and private: ${file}`);
  }
}
function initializePrivateDirectory(dir, repair, exclusive = false) {
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 448 });
    created = true;
  } catch (error) {
    if (exclusive || error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${dir}`);
  if (process.platform === "win32") return;
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
  if (created || repair && (stat.mode & 511) !== 448) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
      fs.fchmodSync(fd, 448);
    } finally {
      fs.closeSync(fd);
    }
    if (!created) console.error(`Room repaired private state directory: ${dir}`);
  }
  verifyPosixPath(dir);
}
export {
  initializePrivateDirectory,
  privateDirectoryPath,
  verifyPosixPath
};
