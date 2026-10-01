import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { claimWrite, pendingFlushes, releaseWrite, settleWrite, touchSession, writeDigest } from "../hooks/scripts/lib/state.js";
import { APP_ID } from "../hooks/scripts/lib/constants.js";
import { flushSession } from "../hooks/scripts/lib/everos.js";

const plugin = fileURLToPath(new URL("../", import.meta.url));
const boundary = path.join(plugin, "tests/helpers/write-boundary.mjs");
const sessionStart = path.join(plugin, "hooks/scripts/session-start.js");
const baseUrl = "http://127.0.0.1:8000";
const fixtures = [];
after(() => { for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sweep-"));
  fixtures.push(dir);
  return { dir, requests: path.join(dir, "requests.jsonl") };
}

function seed(dir, scope) {
  const claim = claimWrite(dir, scope, { kind: "add" });
  assert.ok(claim);
  claim.journal.captures[writeDigest("turn")] = {
    snapshot: writeDigest("synthetic"), total: 2, acknowledged: 2, complete: true,
  };
  claim.journal.revision = 1;
  settleWrite(claim);
  releaseWrite(claim);
  const age = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(claim.dir, "settled.json"), age, age);
  return path.join(claim.dir, "settled.json");
}

function requests(f) {
  return fs.existsSync(f.requests)
    ? fs.readFileSync(f.requests, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

function start(f) {
  const home = path.join(f.dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, ["--import", boundary, sessionStart], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      EVEROS_CODEX_DATA_DIR: f.dir,
      EVEROS_CODEX_BASE_URL: baseUrl,
      EVEROS_CODEX_PROJECT_ID: "healthy",
      EVEROS_CODEX_USER_ID: "synthetic",
      WRITE_MODE: "ack",
      WRITE_REQUESTS: f.requests,
    },
    input: JSON.stringify({ session_id: "startup", cwd: f.dir, hook_event_name: "SessionStart" }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, requests: requests(f) };
}

function holdMessage(stdout) {
  assert.match(stdout, /UNKNOWN \/ HOLD/);
}

test("five earlier endpoint/app scopes cannot starve current abandoned work", () => {
  const f = fixture();
  const current = { baseUrl, appId: APP_ID, projectId: "healthy", sessionId: "healthy-session" };
  const currentDigest = writeDigest(current);
  const oldEndpoints = [];
  const oldApps = [];
  for (let i = 0; i < 10000 && (oldEndpoints.length < 3 || oldApps.length < 2); i += 1) {
    const endpoint = { baseUrl: `http://historical-${i}.invalid`, appId: APP_ID, projectId: "old", sessionId: `old-endpoint-${i}` };
    const app = { baseUrl, appId: `historical-${i}`, projectId: "old", sessionId: `old-app-${i}` };
    if (oldEndpoints.length < 3 && writeDigest(endpoint) < currentDigest) oldEndpoints.push(endpoint);
    if (oldApps.length < 2 && writeDigest(app) < currentDigest) oldApps.push(app);
  }
  assert.equal(oldEndpoints.length, 3);
  assert.equal(oldApps.length, 2);
  const historical = [...oldEndpoints, ...oldApps].sort((a, b) => writeDigest(a).localeCompare(writeDigest(b)));
  const files = historical.map((scope) => seed(f.dir, scope));
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  seed(f.dir, current);
  const pending = pendingFlushes(f.dir, 30 * 60 * 1000).scopes;
  assert.equal(pending.length, 6);
  assert.deepEqual(pending.slice(0, 5).map(writeDigest), historical.map(writeDigest));
  assert.equal(writeDigest(pending[5]), currentDigest);

  const first = start(f);
  assert.equal(first.requests.length, 1, "incompatible history must not consume current send slots");
  assert.deepEqual(first.requests[0], {
    url: `${baseUrl}/api/v2/memory/flush`,
    body: { session_id: current.sessionId, app_id: APP_ID, project_id: current.projectId },
  });
  holdMessage(first.stdout);
  const second = start(f);
  assert.equal(second.requests.length, 1, "repeated startup must not replay the acknowledged current scope");
  holdMessage(second.stdout);
  files.forEach((file, i) => {
    assert.equal(fs.readFileSync(file, "utf8"), before[i], "excluded historical authority is unchanged");
    assert.equal(fs.existsSync(path.join(path.dirname(file), "intent")), false);
  });
});

test("live current scope is protected while idle current scope flushes", () => {
  const f = fixture();
  const idle = { baseUrl, appId: APP_ID, projectId: "healthy", sessionId: "idle-current" };
  const live = { ...idle, sessionId: "live-current" };
  seed(f.dir, idle);
  seed(f.dir, live);
  touchSession(f.dir, live.sessionId);
  const result = start(f);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].body.session_id, idle.sessionId);
  const liveJournal = path.join(f.dir, "state", "writes", writeDigest(live), "settled.json");
  assert.equal(JSON.parse(fs.readFileSync(liveJournal, "utf8")).flushedRevision, null);
  assert.equal(pendingFlushes(f.dir, 30 * 60 * 1000).scopes.length, 0);
});

test("incomplete intent remains HOLD without a POST", () => {
  const f = fixture();
  const scope = { baseUrl, appId: APP_ID, projectId: "healthy", sessionId: "held" };
  const claim = claimWrite(f.dir, scope, { kind: "flush" });
  assert.ok(claim);
  const result = start(f);
  assert.deepEqual(result.requests, []);
  holdMessage(result.stdout);
  assert.ok(fs.existsSync(path.join(claim.dir, "intent")));
});

test("invalid endpoint or app is rejected before any direct flush request", async () => {
  const f = fixture();
  const valid = { baseUrl, appId: APP_ID, projectId: "healthy", sessionId: "invalid-route" };
  const invalid = [
    { ...valid, baseUrl: "http://historical.invalid" },
    { ...valid, appId: "historical-app" },
  ];
  let contacted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { contacted = true; throw new Error("invalid route contacted network"); };
  try {
    for (const scope of invalid) assert.equal(await flushSession({ dataDir: f.dir, baseUrl }, scope), "UNKNOWN");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(contacted, false);
});

test("abandoned sweep sends no more than five eligible scopes", () => {
  const f = fixture();
  for (let i = 0; i < 6; i += 1) {
    seed(f.dir, { baseUrl, appId: APP_ID, projectId: "healthy", sessionId: `current-${i}` });
  }
  const result = start(f);
  assert.equal(result.requests.length, 5);
  assert.ok(result.requests.every(({ url, body }) => url === `${baseUrl}/api/v2/memory/flush` && body.app_id === APP_ID));
  assert.equal(pendingFlushes(f.dir, 30 * 60 * 1000).scopes.length, 1);
});
