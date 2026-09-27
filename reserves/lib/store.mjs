// The history directory: `<height>.json` per snapshot and a derived
// `index.json`. A snapshot file, once written, is never replaced: the write
// goes to a temporary file that is then hard-linked into place, and a link
// cannot succeed over an existing name. So a second run for the same
// height, a clock gone wrong or a concurrent run all fail loudly instead of
// rewriting history.

import fs from "node:fs";
import path from "node:path";
import { buildIndex, fileText } from "./format.mjs";

const SNAPSHOT_FILE = /^(0|[1-9][0-9]*)\.json$/;

/** Heights present in `dir`, ascending. */
export function listHeights(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => SNAPSHOT_FILE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function snapshotPath(dir, height) {
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`not a height: ${height}`);
  return path.join(dir, `${height}.json`);
}

export function readSnapshot(dir, height) {
  return JSON.parse(fs.readFileSync(snapshotPath(dir, height), "utf8"));
}

export function readAll(dir) {
  return listHeights(dir).map((h) => {
    const s = readSnapshot(dir, h);
    if (s?.payload?.height !== h) throw new Error(`${h}.json holds the snapshot of height ${s?.payload?.height}`);
    return s;
  });
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // Not every platform can fsync a directory; the file itself was synced.
  }
}

function writeTemp(dir, name, text) {
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o644);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

/** Write a snapshot, refusing if its file already exists. */
export function writeSnapshotOnce(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  const final = snapshotPath(dir, snap.payload.height);
  if (fs.existsSync(final)) {
    throw new Error(`${final} already exists; a snapshot is never overwritten`);
  }
  const tmp = writeTemp(dir, `${snap.payload.height}.json`, fileText(snap));
  try {
    fs.linkSync(tmp, final); // EEXIST if anything got there first
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`${final} already exists; a snapshot is never overwritten`);
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fsyncDir(dir);
  return final;
}

/** Rebuild index.json from the snapshot files. The index is derived, so
 *  replacing it is safe; it is written atomically so a reader never sees
 *  half of one. */
export function writeIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const index = buildIndex(readAll(dir));
  const tmp = writeTemp(dir, "index.json", fileText(index));
  fs.renameSync(tmp, path.join(dir, "index.json"));
  fsyncDir(dir);
  return index;
}
