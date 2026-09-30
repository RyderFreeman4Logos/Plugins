// Synthetic IO boundaries only; actual hook/client/state modules are untouched.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";

// Never allow provisioning to escape a failed test health mock.
const childProcess = await import("node:child_process");
childProcess.default.spawn = (...args) => {
  if (args[0] !== process.execPath) throw new Error("unexpected service launch");
  return spawn(...args);
};
const mode = process.env.WRITE_MODE;
let acknowledged = false;
for (const name of ["fsyncSync", "renameSync", "writeFileSync"]) {
  const original = fs[name];
  fs[name] = (...args) => {
    if (name === "fsyncSync" && fs.fstatSync(args[0]).isDirectory()) {
      if ((mode === "intent-directory-fsync" && fs.readlinkSync(`/proc/self/fd/${args[0]}`).endsWith("/intent")) || (acknowledged && mode === "settle-directory-fsync")) throw new Error("synthetic directory sync fault");
      if (mode === "crash-before-send" && fs.readlinkSync(`/proc/self/fd/${args[0]}`).endsWith("/intent")) {
        original(...args); process.exit(0);
      }
    }
    if (acknowledged && mode === "settle-crash" && name === "writeFileSync") process.exit(0);
    if (mode === `intent-${name}` || (acknowledged && mode === `settle-${name}`)) {
      throw Object.assign(new Error("synthetic persistence fault"), { code: "EIO" });
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
let requests = 0;
globalThis.fetch = async (url, options) => {
  if (url.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ version: "synthetic" }) };
  if (!/\/api\/v2\/memory\/(add|flush)$/.test(url)) throw new Error("unexpected network boundary");
  const body = JSON.parse(options.body);
  requests += 1;
  const fd = fs.openSync(process.env.WRITE_REQUESTS, "a");
  try { fs.writeSync(fd, JSON.stringify({ url, body }) + "\n"); } finally { fs.closeSync(fd); }
  if (mode === "crash") process.exit(0); // acceptance simulated, process lost before settlement
  if (["before-send", "accepted-lost"].includes(mode) || (mode === "partial" && requests === 2)) {
    throw new DOMException("synthetic deadline", "TimeoutError");
  }
  if (mode === "network") throw new Error("synthetic network failure");
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 200));
  acknowledged = true;
  if (mode === "non-json") return { ok: true, status: 200, json: async () => { throw new Error("synthetic non-JSON"); } };
  const data = mode === "malformed" ? { status: "unexpected", message_count: -1 } :
    mode === "null-data" ? null :
    url.endsWith("/add") ? { status: "accumulated", message_count: body.messages.length } : { status: "extracted" };
  if (mode === "wrong-count" && url.endsWith("/add")) data.message_count -= 1;
  if (mode === "no-extraction") data.status = "no_extraction";
  const envelope = { request_id: "synthetic", data };
  if (mode === "no-request-id") delete envelope.request_id;
  if (mode === "error-and-data") envelope.error = { code: "ERROR", message: "synthetic-private-error" };
  return { ok: true, status: 200, json: async () => envelope };
};
