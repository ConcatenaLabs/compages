// The signed proof-of-reserves history, served read-only from the directory
// the snapshot tool (reserves/snapshot.mjs) writes to (`porHistoryDir`).
//
//   GET /api/por/history        index.json
//   GET /api/por/history/<H>    <H>.json
//
// The files are served byte for byte, never parsed and re-serialized: they
// are canonical JSON under a signature, and the bytes are what a verifier
// hashes. H must be a plain decimal height, which is also what keeps a
// request from naming any other file.

import fs from "node:fs/promises";
import path from "node:path";

const HEIGHT = /^(0|[1-9][0-9]{0,14})$/;
const json = { "content-type": "application/json; charset=utf-8" };

/** Answer a request for /api/por/history[/...]. `rest` is the path segments
 *  after "history". Returns { status, headers, body }. */
export async function porHistory(dir, rest) {
  const notFound = (error) => ({ status: 404, headers: json, body: JSON.stringify({ error }) });
  if (!dir) return notFound("this bridge publishes no reserve snapshot history");
  let file;
  let cache;
  if (rest.length === 0) {
    file = "index.json";
    cache = "public, max-age=60";
  } else if (rest.length === 1 && HEIGHT.test(rest[0])) {
    file = `${rest[0]}.json`;
    // A snapshot never changes once written.
    cache = "public, max-age=31536000, immutable";
  } else {
    return notFound("not found");
  }
  try {
    const body = await fs.readFile(path.join(dir, file));
    return { status: 200, headers: { ...json, "cache-control": cache }, body };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") {
      return notFound(rest.length === 0 ? "no reserve snapshot has been taken yet" : `no snapshot at height ${rest[0]}`);
    }
    throw e;
  }
}
