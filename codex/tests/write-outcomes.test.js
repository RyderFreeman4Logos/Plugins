import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { markStored, readState, rememberPrompt, statePath, pruneState, pendingFlushes, touchSession, writeDigest } from "../hooks/scripts/lib/state.js";
import { ADD_MAX_MESSAGES } from "../hooks/scripts/lib/constants.js";
import { createClient, flushSession } from "../hooks/scripts/lib/everos.js";

test("search keeps its existing read-only envelope compatibility", async () => {
  const expected = { episodes: [] };
  const client = createClient({ baseUrl: "http://synthetic.invalid", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: expected }) }) });
  assert.deepEqual(await client.search({}), expected);
});

const plugin = fileURLToPath(new URL("../", import.meta.url));
const boundary = path.join(plugin, "tests/helpers/write-boundary.mjs");
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(messageCount = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-write-"));
  made.push(dir);
  const transcript = path.join(dir, "turn.jsonl");
  fs.writeFileSync(transcript, Array.from({ length: messageCount }, (_, i) => JSON.stringify({
    timestamp: "2026-09-16T12:00:00.000Z", ordinal: i, type: "response_item",
    payload: { type: "message", role: i === 0 ? "user" : "assistant",
      content: [{ type: i === 0 ? "input_text" : "output_text", text: `synthetic-${i}` }],
      internal_chat_message_metadata_passthrough: { turn_id: "t1" } },
  })).join("\n"));
  rememberPrompt(dir, "s1", "t1", "synthetic-0");
  return { dir, transcript, requests: path.join(dir, "requests.jsonl") };
}
function args(f, script, mode = "ack", extra = {}) {
  return { env: { ...process.env, HOME: f.dir, CODEX_HOME: f.dir,
    EVEROS_CODEX_DATA_DIR: f.dir, EVEROS_CODEX_BASE_URL: "http://127.0.0.1:8000",
    EVEROS_CODEX_PROJECT_ID: "synthetic-project", EVEROS_CODEX_USER_ID: "synthetic-user",
    EVEROS_CODEX_VERBOSE: "1", WRITE_REQUESTS: f.requests, WRITE_MODE: mode, ...extra },
    input: JSON.stringify({ session_id: "s1", turn_id: "t1", transcript_path: f.transcript,
      cwd: f.dir, hook_event_name: script === "flush" ? "SessionEnd" : "Stop" }),
    encoding: "utf8", timeout: 10000 };
}
function hook(f, script, mode, extra, input = {}) {
  const a = args(f, script, mode, extra);
  a.input = JSON.stringify({ ...JSON.parse(a.input), ...input });
  const result = spawnSync(process.execPath, ["--import", boundary, path.join(plugin, `hooks/scripts/${script}.js`)], a);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
function requests(f) {
  return fs.existsSync(f.requests) ? fs.readFileSync(f.requests, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
function jsonFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? jsonFiles(file) : file.endsWith(".json") ? [JSON.parse(fs.readFileSync(file, "utf8"))] : [];
  });
}
for (const mode of ["before-send", "accepted-lost", "network", "malformed", "null-data", "non-json", "no-request-id", "error-and-data", "crash"]) {
  test(`ambiguous flush ${mode}: direct and abandoned sweep never replay`, () => {
    const f = fixture();
    markStored(f.dir, "s1", "prior", "synthetic-project");
    hook(f, "flush", mode);
    assert.equal(readState(f.dir, "s1").flushed, false, "ambiguity is not flushed success");
    hook(f, "flush", "ack");
    const age = new Date(Date.now() - 31 * 86400000);
    fs.utimesSync(statePath(f.dir, "s1"), age, age);
    pruneState(f.dir);
    assert.ok(fs.existsSync(statePath(f.dir, "s1")), "unknown must survive TTL");
    hook(f, "session-start", "ack");
    assert.equal(requests(f).length, 1, "no duplicate direct/sweep POST");
  });
  test(`ambiguous capture ${mode}: repeated Stop and later turn HOLD`, () => {
    const f = fixture();
    hook(f, "capture", mode);
    const held = hook(f, "capture", "ack");
    assert.match(held.stdout, /UNKNOWN|HOLD/, "hold is visible without debug logging");
    rememberPrompt(f.dir, "s1", "t2", "later synthetic prompt");
    fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, "utf8").replaceAll('"t1"', '"t2"'));
    hook(f, "capture", "ack", {}, { turn_id: "t2" });
    markStored(f.dir, "s1", "other", "synthetic-project");
    hook(f, "flush", "ack");
    assert.equal(requests(f).length, 1);
    assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"));
  });
}
test("acknowledged add/flush dedupe is partition-scoped and new captures reopen flush", () => {
  const f = fixture();
  hook(f, "capture", "ack"); hook(f, "capture", "ack");
  hook(f, "flush", "ack"); hook(f, "flush", "ack");
  assert.equal(requests(f).length, 2);
  assert.ok(readState(f.dir, "s1").promptIds.includes("t1"));
  assert.equal(readState(f.dir, "s1").flushed, true);
  const other = { EVEROS_CODEX_PROJECT_ID: "other-project" };
  hook(f, "capture", "ack", other); hook(f, "flush", "ack", other);
  const remote = { EVEROS_CODEX_BASE_URL: "http://synthetic.invalid" };
  hook(f, "capture", "ack", remote); hook(f, "flush", "ack", remote);
  assert.equal(requests(f).length, 6, "old partition acknowledgments cannot suppress new work");
  fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, "utf8").replaceAll('"t1"', '"t2"'));
  // No turn_id uses the real fallback, and therefore the new transcript turn.
  const a = args(f, "capture", "ack");
  a.input = JSON.stringify({ session_id: "s1", transcript_path: f.transcript, cwd: f.dir });
  const result = spawnSync(process.execPath, ["--import", boundary, path.join(plugin, "hooks/scripts/capture.js")], a);
  assert.equal(result.status, 0, result.stderr);
  hook(f, "flush", "ack");
  assert.equal(requests(f).length, 8);
});
test("partial multi-batch capture retains acknowledged prefix and uncertain tail", () => {
  const f = fixture(ADD_MAX_MESSAGES + 2);
  hook(f, "capture", "partial"); hook(f, "capture", "ack"); hook(f, "flush", "ack");
  assert.equal(requests(f).length, 2);
  assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"), "partial is not whole-turn success");
  assert.ok(jsonFiles(f.dir).some((record) => Object.values(record.captures ?? {}).some((capture) => capture.acknowledged === ADD_MAX_MESSAGES && capture.complete === false)), "prefix is durably observable");
});
for (const fault of ["fsyncSync", "writeFileSync"]) {
  test(`intent ${fault} failure prevents POST`, () => {
    const f = fixture();
    hook(f, "capture", `intent-${fault}`);
    assert.equal(requests(f).length, 0);
  });
}
for (const fault of ["fsyncSync", "renameSync", "writeFileSync"]) {
  test(`acknowledgment before failed settlement ${fault} remains HOLD`, () => {
    const f = fixture();
    hook(f, "capture", `settle-${fault}`);
    hook(f, "capture", "ack"); hook(f, "flush", "ack");
    assert.equal(requests(f).length, 1);
    assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"));
  });
}
test("concurrent Stop/SessionEnd hooks have one exclusive scoped writer", async () => {
  const f = fixture();
  function run(script) {
    const a = args(f, script, "slow");
    const p = spawn(process.execPath, ["--import", boundary, path.join(plugin, `hooks/scripts/${script}.js`)], { env: a.env, stdio: ["pipe", "pipe", "pipe"] });
    p.stdin.end(a.input);
    let stderr = ""; p.stderr.on("data", (chunk) => { stderr += chunk; }); p.stdout.resume();
    return new Promise((resolve, reject) => { p.on("error", reject); p.on("close", (code) => { assert.equal(code, 0, stderr); resolve(); }); });
  }
  await Promise.all([run("capture"), run("capture"), run("flush")]);
  assert.equal(requests(f).length, 1);
});

test("remote UNKNOWN is held through PreCompact and sweep; other scopes remain independent", () => {
  const f = fixture();
  const remote = { EVEROS_CODEX_BASE_URL: "http://synthetic.invalid" };
  markStored(f.dir, "s1", "prior", "synthetic-project");
  hook(f, "flush", "accepted-lost", remote, { hook_event_name: "PreCompact" });
  hook(f, "flush", "ack", remote);
  const age = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(statePath(f.dir, "s1"), age, age); pruneState(f.dir);
  hook(f, "session-start", "ack", remote);
  assert.equal(requests(f).length, 1);
  assert.match(hook(f, "capture", "ack", remote).stdout, /UNKNOWN|HOLD/);
  hook(f, "capture", "ack"); // new endpoint, not the uncertain partition
  hook(f, "capture", "ack", remote, { session_id: "s2" });
  hook(f, "capture", "ack", { ...remote, EVEROS_CODEX_PROJECT_ID: "other" });
  assert.equal(requests(f).length, 4);
});
for (const script of ["capture", "flush"]) {
  test(`${script}: crash before send retains UNKNOWN without claiming nonacceptance`, () => {
    const f = fixture();
    hook(f, script, "crash-before-send");
    assert.equal(requests(f).length, 0);
    assert.match(hook(f, script, "ack").stdout, /UNKNOWN|HOLD/);
    assert.equal(requests(f).length, 0);
  });
  for (const mode of ["intent-directory-fsync", "settle-directory-fsync", "settle-postrename-directory-fsync", "settle-crash"]) {
    test(`${script}: ${mode} is fail-closed`, () => {
      const f = fixture();
      hook(f, script, mode);
      hook(f, script, "ack");
      assert.equal(requests(f).length, mode.startsWith("intent") ? 0 : 1);
      assert.equal(readState(f.dir, "s1").flushed, false);
      assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"));
    });
  }
}
test("wrong add count never settles; remote error text is not exposed", () => {
  const f = fixture();
  assert.match(hook(f, "capture", "wrong-count").stdout, /UNKNOWN|HOLD/);
  hook(f, "capture", "ack");
  assert.equal(requests(f).length, 1);
  const g = fixture();
  const result = hook(g, "capture", "error-and-data", { EVEROS_CODEX_DEBUG: "1" });
  assert.ok(!JSON.stringify(result).includes("synthetic-private-error"));
  assert.ok(!fs.readFileSync(path.join(g.dir, "debug.log"), "utf8").includes("synthetic-private-error"));
});
test("recognized no_extraction acknowledgment still settles normally", () => {
  const f = fixture();
  hook(f, "capture", "ack");
  hook(f, "flush", "no-extraction"); hook(f, "flush", "ack");
  assert.equal(readState(f.dir, "s1").flushed, true);
  assert.equal(requests(f).length, 2);
});

test("add rejects flush-only no_extraction acknowledgment", () => {
  const f = fixture();
  assert.match(hook(f, "capture", "no-extraction").stdout, /UNKNOWN|HOLD/);
  assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"));
  hook(f, "capture", "ack");
  assert.equal(requests(f).length, 1);
});
for (const script of ["capture", "flush"]) {
  test(`${script}: release-directory-fsync retains HOLD separately from settlement`, () => {
    const f = fixture();
    assert.match(hook(f, script, "release-directory-fsync").stdout, /UNKNOWN|HOLD/);
    assert.equal(fs.readFileSync(f.requests + ".fault", "utf8"), "release\n", "exact release fence exercised once");
    assert.ok(jsonFiles(f.dir).some((j) => script === "capture" ? Object.values(j.captures ?? {}).some((c) => c.complete) : j.flushedRevision === 0), "acknowledgment survives release uncertainty");
    fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, "utf8").replaceAll('"t1"', '"t2"'));
    assert.match(hook(f, "capture", "ack", {}, { turn_id: "t2" }).stdout, /UNKNOWN|HOLD/);
    assert.match(hook(f, "flush", "ack").stdout, /UNKNOWN|HOLD/);
    assert.equal(requests(f).length, 1);
  });
}
const corruptions = {
  "inconsistent complete": (j, c) => { c.acknowledged = 0; },
  "negative flushed revision": (j) => { j.flushedRevision = -1; },
  "future flushed revision": (j) => { j.flushedRevision = j.revision + 1; },
  "fractional revision": (j) => { j.revision = 0.5; },
  "revision/count mismatch": (j) => { j.revision = 0; },
  "unsafe revision": (j) => { j.revision = Number.MAX_SAFE_INTEGER + 1; },
  "string acknowledged": (j, c) => { c.acknowledged = "2"; },
  "negative acknowledged": (j, c) => { c.acknowledged = -1; },
  "overflow acknowledged": (j, c) => { c.acknowledged = 3; },
  "zero total": (j, c) => { c.total = 0; },
  "fractional total": (j, c) => { c.total = 2.5; },
  "false complete": (j, c) => { c.complete = false; },
  "string complete": (j, c) => { c.complete = "true"; },
  "bad snapshot": (j, c) => { c.snapshot = "broken"; },
  "missing snapshot": (j, c) => { delete c.snapshot; },
  "bad key": (j, c) => { j.captures = { broken: c }; },
  "null receipt": (j) => { j.captures[Object.keys(j.captures)[0]] = null; },
  "array captures": (j) => { j.captures = []; },
  "wrong scope": (j) => { j.scope.projectId = "wrong"; },
  "missing scope": (j) => { delete j.scope; },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  for (const script of ["capture", "flush"]) {
    test(`${script}: corrupt settlement ${name} remains HOLD before requests or release`, () => {
      const f = fixture();
      hook(f, "capture", "ack");
      const root = path.join(f.dir, "state/writes");
      const dir = path.join(root, fs.readdirSync(root)[0]);
      const file = path.join(dir, "settled.json");
      const journal = JSON.parse(fs.readFileSync(file, "utf8"));
      corrupt(journal, Object.values(journal.captures)[0]);
      fs.writeFileSync(file, JSON.stringify(journal));
      assert.match(hook(f, script, "ack").stdout, /UNKNOWN|HOLD/);
      assert.ok(fs.existsSync(path.join(dir, "intent")), "corruption cannot release HOLD");
      hook(f, "capture", "ack"); hook(f, "flush", "ack");
      assert.equal(requests(f).length, 1, "corruption cannot authorize another POST");
    });
  }
}

function settlements(f) {
  const root = path.join(f.dir, "state/writes");
  return fs.readdirSync(root).map((name) => path.join(root, name, "settled.json"));
}
function idle(f, days = 1) {
  const age = new Date(Date.now() - days * 86400000);
  for (const file of [statePath(f.dir, "s1"), ...settlements(f)]) {
    if (fs.existsSync(file)) fs.utimesSync(file, age, age);
  }
}
for (const script of ["capture", "flush", "session-start"]) {
  test(`authority: ${script} refuses lost settlement in an existing scope`, () => {
    const f = fixture();
    hook(f, "capture", "ack");
    idle(f);
    fs.unlinkSync(settlements(f)[0]);
    assert.match(hook(f, script, "ack").stdout, /UNKNOWN|HOLD/);
    assert.equal(requests(f).length, 1, "lost authority cannot authorize a POST");
    assert.ok(!fs.existsSync(settlements(f)[0]), "missing authority is never recreated");
  });
}
for (const distinctTurn of [false, true]) {
  test(`authority: flush A then recover B (${distinctTurn ? "distinct" : "same"} turn)`, () => {
    const f = fixture();
    const other = { EVEROS_CODEX_PROJECT_ID: "other-project" };
    hook(f, "capture", "ack");
    hook(f, "flush", "ack");
    if (distinctTurn) {
      fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, "utf8").replaceAll('"t1"', '"t2"'));
    }
    hook(f, "capture", "ack", other, { turn_id: distinctTurn ? "t2" : "t1" });
    // Flushing A again must not mask B's durable outstanding revision.
    hook(f, "flush", "ack");
    idle(f);
    hook(f, "session-start", "ack");
    hook(f, "session-start", "ack");
    assert.equal(requests(f).length, 4);
    assert.equal(requests(f).at(-1).body.project_id, "other-project");
  });
}
for (const loss of ["missing", "ttl", "stale"]) {
  test(`authority: pending capture survives ${loss} cache projection`, () => {
    const f = fixture();
    hook(f, "capture", "ack");
    if (loss === "stale") {
      const cache = readState(f.dir, "s1");
      fs.writeFileSync(statePath(f.dir, "s1"), JSON.stringify({ ...cache, flushed: true, projectId: "wrong", promptIds: [] }));
    }
    idle(f, 31);
    if (loss === "missing") fs.unlinkSync(statePath(f.dir, "s1"));
    if (loss === "ttl") pruneState(f.dir);
    hook(f, "session-start", "ack");
    assert.equal(requests(f).length, 2);
    assert.equal(requests(f).at(-1).body.project_id, "synthetic-project");
  });
}
for (const sameSession of [true, false]) {
  test(`authority: scoped HOLD does not mask healthy ${sameSession ? "same" : "other"} session`, () => {
    const f = fixture();
    hook(f, "capture", "accepted-lost");
    hook(f, "capture", "ack", { EVEROS_CODEX_PROJECT_ID: "other-project" }, { session_id: sameSession ? "s1" : "s2" });
    idle(f);
    if (!sameSession) {
      const age = new Date(Date.now() - 86400000);
      fs.utimesSync(statePath(f.dir, "s2"), age, age);
    }
    hook(f, "session-start", "ack");
    assert.equal(requests(f).length, 3);
    assert.equal(requests(f).at(-1).body.project_id, "other-project");
  });
}
test("authority: sweep never relabels historical endpoint or app", () => {
  const f = fixture();
  const remote = { EVEROS_CODEX_BASE_URL: "http://synthetic.invalid" };
  hook(f, "capture", "ack", remote);
  idle(f);
  assert.match(hook(f, "session-start", "ack").stdout, /UNKNOWN|HOLD/);
  assert.equal(requests(f).length, 1);
  hook(f, "session-start", "ack", remote);
  assert.equal(requests(f).length, 2, "compatible route can recover its own scope");
});
for (const script of ["capture", "flush", "session-start"]) {
  test(`authority: ${script} refuses incomplete prefix without intent`, () => {
    const f = fixture(ADD_MAX_MESSAGES + 2);
    hook(f, "capture", "partial");
    fs.rmSync(path.join(path.dirname(settlements(f)[0]), "intent"), { recursive: true });
    idle(f);
    assert.match(hook(f, script, "ack").stdout, /UNKNOWN|HOLD/);
    assert.equal(requests(f).length, 2, "prefix cannot authorize capture or flush");
    assert.ok(fs.existsSync(path.join(path.dirname(settlements(f)[0]), "intent")));
  });
}
test("authority: live activity protects every session scope", () => {
  const f = fixture();
  hook(f, "capture", "ack");
  hook(f, "capture", "ack", { EVEROS_CODEX_PROJECT_ID: "other-project" });
  idle(f);
  hook(f, "recall", "ack", {}, { prompt: "ok" });
  hook(f, "session-start", "ack");
  assert.equal(requests(f).length, 2);
});

test("authority: under-claim liveness revalidation preserves pending work", async () => {
  const f = fixture();
  hook(f, "capture", "ack");
  idle(f);
  const [scope] = pendingFlushes(f.dir, 30 * 60 * 1000).scopes;
  assert.ok(scope);
  touchSession(f.dir, "s1");
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { assert.fail("live scope cannot POST"); };
  try {
    assert.equal(await flushSession({ dataDir: f.dir, baseUrl: scope.baseUrl }, scope, undefined, 30 * 60 * 1000), "live");
  } finally { globalThis.fetch = fetchBefore; }
  assert.equal(JSON.parse(fs.readFileSync(settlements(f)[0])).flushedRevision, null);
  idle(f);
  hook(f, "session-start", "ack");
  assert.equal(requests(f).length, 2);
});
test("authority: historical app is excluded rather than relabeled", () => {
  const f = fixture();
  hook(f, "capture", "ack");
  const file = settlements(f)[0];
  const journal = JSON.parse(fs.readFileSync(file));
  journal.scope.appId = "historical-app";
  const dir = path.join(path.dirname(path.dirname(file)), writeDigest(journal.scope));
  fs.renameSync(path.dirname(file), dir);
  fs.writeFileSync(path.join(dir, "settled.json"), JSON.stringify(journal));
  idle(f);
  assert.match(hook(f, "session-start", "ack").stdout, /UNKNOWN|HOLD/);
  assert.equal(requests(f).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settled.json"))).flushedRevision, null);
});
test("authority: unidentifiable corrupt records block sweep but not independent direct scopes", () => {
  const f = fixture();
  hook(f, "capture", "ack");
  fs.writeFileSync(settlements(f)[0], "{");
  hook(f, "capture", "ack", { EVEROS_CODEX_PROJECT_ID: "other-project" });
  idle(f);
  assert.match(hook(f, "session-start", "ack").stdout, /UNKNOWN|HOLD/);
  assert.equal(requests(f).length, 2);
  hook(f, "flush", "ack", { EVEROS_CODEX_PROJECT_ID: "other-project" });
  assert.equal(requests(f).length, 3);
});
for (const script of ["capture", "flush"]) {
  test(`authority: ${script} initializer retains ownership against an interleaved contender`, () => {
    const f = fixture();
    hook(f, script, "scope-mkdir-contender", { WRITE_CONTENDER_INPUT: args(f, script).input });
    assert.equal(requests(f).length, 1);
    assert.ok(!fs.existsSync(path.join(path.dirname(settlements(f)[0]), "intent")));
    hook(f, script, "ack");
    assert.equal(requests(f).length, 1);
  });
  for (const mode of ["scope-mkdir-crash", "bootstrap-writeFileSync", "bootstrap-fsyncSync"]) {
    test(`authority: ${script} ${mode} parks before send and after restart`, () => {
      const f = fixture();
      hook(f, script, mode);
      hook(f, script, "ack");
      assert.equal(requests(f).length, 0);
      assert.match(hook(f, script, "ack").stdout, /UNKNOWN|HOLD/);
    });
  }
}
test("authority: release-to-cache crash retains discoverable acknowledged work", () => {
  const f = fixture();
  hook(f, "capture", "cache-after-release-crash");
  assert.equal(requests(f).length, 1);
  assert.ok(!fs.existsSync(path.join(path.dirname(settlements(f)[0]), "intent")));
  assert.ok(!readState(f.dir, "s1").promptIds.includes("t1"));
  idle(f);
  hook(f, "session-start", "ack");
  assert.equal(requests(f).length, 2);
});

test("acknowledged receipts survive TTL, and changed turn snapshot cannot reuse an old acknowledgment", () => {
  const f = fixture();
  hook(f, "capture", "ack"); hook(f, "flush", "ack");
  const age = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(statePath(f.dir, "s1"), age, age); pruneState(f.dir);
  hook(f, "capture", "ack"); hook(f, "flush", "ack");
  assert.equal(requests(f).length, 2);
  fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, "utf8").replace("synthetic-1", "synthetic-changed"));
  assert.match(hook(f, "capture", "ack").stdout, /UNKNOWN|HOLD/);
  assert.equal(requests(f).length, 2);
});
