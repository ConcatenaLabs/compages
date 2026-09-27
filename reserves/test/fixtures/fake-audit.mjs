// Stands in for the node repository's audit.py in tests: same arguments,
// same checkpoint and report shape, but the report comes from the
// environment (FAKE_AUDIT_REPORT) and the exit status from FAKE_AUDIT_EXIT.
// It records its arguments and the cookie it was handed (FAKE_AUDIT_LOG),
// so a test can check the credentials never reached the command line.
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1];
};
const end = Number(arg("--end"));
const cookie = arg("--cookie");
if (process.env.FAKE_AUDIT_LOG) {
  fs.writeFileSync(process.env.FAKE_AUDIT_LOG, JSON.stringify({ argv, cookie: cookie && fs.readFileSync(cookie, "utf8") }));
}
const exit = Number(process.env.FAKE_AUDIT_EXIT ?? 0);
if (exit !== 0 && exit !== 2) {
  process.stderr.write("RuntimeError: getblock: connection refused\n");
  process.exit(exit);
}
const checkpoint = arg("--checkpoint");
const assets = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--asset") assets.push(argv[i + 1]);
if (checkpoint) fs.writeFileSync(checkpoint, JSON.stringify({ want: assets.sort(), next_height: end + 1, accs: {} }));
const report = JSON.parse(process.env.FAKE_AUDIT_REPORT ?? '{"assets":{}}');
console.log(JSON.stringify({ chain_tip: end + 10, scanned_start: 0, scanned_end: end, ...report }, null, 2));
process.exit(exit);
