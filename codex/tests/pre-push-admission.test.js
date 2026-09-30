import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const codex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptSource = path.resolve(codex, "scripts/pre-push-admission.mjs");
const lefthook = process.env.LEFTHOOK_BIN ?? "/tools/lefthook";
const node20 = "v20.20.2";
const node22 = "v22.23.3";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
function runGit(cwd, env, args) {
  const result = run("git", args, { cwd, env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const temp = path.join(home, "tmp");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(temp, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    TMP: temp,
    TMPDIR: temp,
    TEMP: temp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    LEFTHOOK_BIN: lefthook,
  };
  const template = path.join(root, "template");
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(template);
  runGit(root, env, ["init", "--initial-branch=main", `--template=${template}`, repo]);
  runGit(repo, env, ["config", "user.name", "Fixture"]);
  runGit(repo, env, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  runGit(repo, env, ["add", "base.txt"]);
  runGit(repo, env, ["commit", "--quiet", "-m", "base"]);
  runGit(root, env, ["init", "--bare", "--initial-branch=main", `--template=${template}`, origin]);
  runGit(repo, env, ["remote", "add", "origin", origin]);
  runGit(repo, env, ["push", "--quiet", "origin", "refs/heads/main:refs/heads/main"]);
  runGit(repo, env, ["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  runGit(repo, env, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  runGit(repo, env, ["switch", "--quiet", "--create", "fix/fixture"]);
  fs.mkdirSync(path.join(repo, "codex", "scripts"), { recursive: true });
  fs.copyFileSync(scriptSource, path.join(repo, "codex", "scripts", "pre-push-admission.mjs"));
  fs.copyFileSync(path.resolve(codex, "../lefthook.yml"), path.join(repo, "lefthook.yml"));
  fs.writeFileSync(path.join(repo, "candidate.txt"), "candidate\n");
  runGit(repo, env, ["add", "codex/scripts/pre-push-admission.mjs", "lefthook.yml", "candidate.txt"]);
  runGit(repo, env, ["commit", "--quiet", "-m", "candidate"]);
  const format = runGit(repo, env, ["rev-parse", "--show-object-format"]);
  const identity = {
    branch: runGit(repo, env, ["symbolic-ref", "--quiet", "HEAD"]),
    head: runGit(repo, env, ["rev-parse", "HEAD"]),
    tree: runGit(repo, env, ["rev-parse", "HEAD^{tree}"]),
    baseRef: "refs/remotes/origin/main",
    base: runGit(repo, env, ["rev-parse", "refs/remotes/origin/main"]),
  };
  identity.range = `${identity.baseRef}...${identity.head}`;
  return {
    root, home, temp, repo, origin, env, identity,
    script: path.join(repo, "codex", "scripts", "pre-push-admission.mjs"),
    hashLength: format === "sha256" ? 64 : 40,
    gateLog: path.join(temp, "gate-full.log"),
    gateReceipt: path.join(temp, "gate.json"),
    reviewReport: path.join(temp, "native-review.md"),
    reviewReceipt: path.join(temp, "review.json"),
  };
}
function reportText(identity) {
  return [
    "Native whole-range review findings and evidence follow.",
    `Candidate: ${identity.head}`,
    `Tree: ${identity.tree}`,
    `Base: ${identity.baseRef} ${identity.base}`,
    `Range: ${identity.range}`,
    "Scope: complete-range",
    "VERDICT: PASS",
    "",
  ].join("\n");
}
function fullLog() {
  const summary = "TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n";
  return `${node20}\n${summary}${node22}\n${summary}`;
}
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function evidenceEnv(f) {
  return { CODEX_GATE_RECEIPT: f.gateReceipt, CODEX_REVIEW_RECEIPT: f.reviewReceipt };
}
function syntheticEvidence(f) {
  // Synthetic PASS evidence is confined to this throwaway local Git fixture.
  const log = Buffer.from(fullLog());
  const report = Buffer.from(reportText(f.identity));
  fs.writeFileSync(f.gateLog, log, { mode: 0o600 });
  fs.writeFileSync(f.reviewReport, report, { mode: 0o600 });
  writeJson(f.gateReceipt, {
    schema: 1, kind: "gate", status: "PASS", ...f.identity,
    command: { executable: "/tools/just", args: ["codex-full", "/tools/node20", "/tools/node22"] },
    node20: { path: "/tools/node20", version: node20 },
    node22: { path: "/tools/node22", version: node22 },
    testSummaries: {
      node20: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0 },
      node22: { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0 },
    },
    exitCode: 0,
    log: { path: f.gateLog, sha256: sha(log) },
  });
  writeJson(f.reviewReceipt, {
    schema: 1, kind: "review", source: "native", verdict: "PASS", scope: "complete-range",
    ...f.identity,
    report: { path: f.reviewReport, sha256: sha(report) },
  });
  return { ...f.env, ...evidenceEnv(f) };
}
function update(f, { localRef = f.identity.branch, localOid = f.identity.head, remoteRef = f.identity.branch, remoteOid = "0".repeat(f.hashLength) } = {}) {
  return `${localRef} ${localOid} ${remoteRef} ${remoteOid}\n`;
}
function verify(f, input = update(f), extraEnv = {}) {
  return run(process.execPath, [f.script, "verify"], {
    cwd: f.repo,
    env: { ...f.env, ...evidenceEnv(f), ...extraEnv },
    input,
  });
}
function receipt(f, name) { return JSON.parse(fs.readFileSync(f[name], "utf8")); }
function remoteRef(f, ref) {
  const result = run("git", ["--git-dir", f.origin, "show-ref", "--heads"], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim().split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
  return line?.split(" ", 1)[0] ?? null;
}

test("resolved pre-push hook preserves stdin and invokes exact-candidate admission", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-admission-dump-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, "repo");
  const template = path.join(root, "template");
  const home = path.join(root, "home");
  fs.mkdirSync(template);
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LEFTHOOK_BIN: lefthook,
  };
  const init = run("git", ["init", "--initial-branch=main", `--template=${template}`, checkout], { env });
  assert.equal(init.status, 0, init.stderr);
  fs.copyFileSync(path.resolve(codex, "../lefthook.yml"), path.join(checkout, "lefthook.yml"));
  const dump = run(lefthook, ["dump"], { cwd: checkout, env });
  assert.equal(dump.status, 0, dump.stderr);
  const block = dump.stdout.match(/^pre-push:\n((?:[ \t].*(?:\n|$))*)/m)?.[0] ?? "";
  assert.ok(block, `resolved hook must declare pre-push:\n${dump.stdout}`);
  assert.match(block, /use_stdin:\s*true/);
  assert.match(block, /run:\s*node codex\/scripts\/pre-push-admission\.mjs verify/);
});

test("receipt producers and direct verifier bind one clean exact candidate and fail closed", (t) => {
  const f = fixture(t);
  const tools = path.join(f.root, "tools");
  fs.mkdirSync(tools);
  const fakeNode20 = path.join(tools, "node20");
  const fakeNode22 = path.join(tools, "node22");
  const fakeJust = path.join(tools, "just");
  const fakeNode = `#!/runtime/bin/node\nif (process.argv[2] !== "--version") process.exit(90);\nprocess.stdout.write(require("node:path").basename(process.argv[1]) === "node20" ? "${node20}\\n" : "${node22}\\n");\n`;
  fs.writeFileSync(fakeNode20, fakeNode, { mode: 0o700 });
  fs.writeFileSync(fakeNode22, fakeNode, { mode: 0o700 });
  const fakeGate = `#!/runtime/bin/node\nconst path = require("node:path");\nconst dir = path.dirname(process.argv[1]);\nif (process.argv[2] !== "codex-full" || process.argv[3] !== path.join(dir, "node20") || process.argv[4] !== path.join(dir, "node22")) process.exit(91);\nprocess.stdout.write(${JSON.stringify(fullLog())});\n`;
  fs.writeFileSync(fakeJust, fakeGate, { mode: 0o700 });
  const gate = run(process.execPath, [f.script, "record-gate", fakeJust, fakeNode20, fakeNode22, f.gateLog, f.gateReceipt], { cwd: f.repo, env: f.env });
  assert.equal(gate.status, 0, gate.stderr || gate.stdout);
  assert.equal(receipt(f, "gateReceipt").testSummaries.node20.tests, 2);
  fs.writeFileSync(f.reviewReport, reportText(f.identity), { mode: 0o600 });
  const review = run(process.execPath, [f.script, "record-review", f.reviewReport, f.reviewReceipt], { cwd: f.repo, env: f.env });
  assert.equal(review.status, 0, review.stderr || review.stdout);
  const gateBefore = fs.readFileSync(f.gateReceipt);
  const reviewBefore = fs.readFileSync(f.reviewReceipt);
  const logBefore = fs.readFileSync(f.gateLog);
  const reportBefore = fs.readFileSync(f.reviewReport);
  const valid = verify(f);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const failures = [
    ["empty stdin", Buffer.alloc(0)],
    ["multiple updates", Buffer.from(update(f) + update(f))],
    ["deletion", Buffer.from(update(f, { localOid: "0".repeat(f.hashLength) }))],
    ["malformed local OID", Buffer.from(update(f, { localOid: "z".repeat(f.hashLength) }))],
    ["malformed remote OID", Buffer.from(update(f, { remoteOid: "z".repeat(f.hashLength) }))],
    ["wrong local OID", Buffer.from(update(f, { localOid: f.identity.base }))],
    ["wrong local ref", Buffer.from(update(f, { localRef: "refs/heads/fix/other" }))],
    ["wrong remote ref", Buffer.from(update(f, { remoteRef: "refs/heads/fix/other" }))],
    ["tag ref", Buffer.from(update(f, { remoteRef: "refs/tags/v1" }))],
    ["default branch", Buffer.from(update(f, { localRef: "refs/heads/main", remoteRef: "refs/heads/main" }))],
    ["extra whitespace", Buffer.from(update(f).replace("  ", " ").replace(" ", "  "))],
    ["non-ASCII stdin", Buffer.concat([Buffer.from(update(f)), Buffer.from([0xff])])],
  ];
  for (const [label, input] of failures) {
    const result = verify(f, input);
    assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  }

  const gateCases = [
    ["gate FAIL", (r) => { r.status = "FAIL"; }],
    ["stale gate HEAD", (r) => { r.head = f.identity.base; }],
    ["wrong gate tree", (r) => { r.tree = f.identity.base; }],
    ["wrong gate base", (r) => { r.base = f.identity.head; }],
    ["wrong command", (r) => { r.command.args[0] = "codex-test"; }],
    ["wrong runtime", (r) => { r.node20.version = "v20.0.0"; }],
    ["wrong test count", (r) => { r.testSummaries.node22.pass = 0; }],
    ["tampered log hash", (r) => { r.log.sha256 = "0".repeat(64); }],
  ];
  for (const [label, mutate] of gateCases) {
    fs.writeFileSync(f.gateReceipt, gateBefore);
    fs.writeFileSync(f.reviewReceipt, reviewBefore);
    fs.writeFileSync(f.gateLog, logBefore);
    fs.writeFileSync(f.reviewReport, reportBefore);
    const changed = JSON.parse(gateBefore.toString("utf8"));
    mutate(changed);
    writeJson(f.gateReceipt, changed);
    assert.notEqual(verify(f).status, 0, `${label} unexpectedly passed`);
  }
  fs.writeFileSync(f.gateReceipt, gateBefore);
  fs.writeFileSync(f.reviewReceipt, reviewBefore);
  fs.writeFileSync(f.gateLog, Buffer.concat([logBefore, Buffer.from("tampered\n")]));
  assert.notEqual(verify(f).status, 0, "tampered gate log unexpectedly passed");
  fs.writeFileSync(f.gateLog, logBefore);
  fs.writeFileSync(f.reviewReport, Buffer.concat([reportBefore, Buffer.from("tampered\n")]));
  assert.notEqual(verify(f).status, 0, "tampered review report unexpectedly passed");
  fs.writeFileSync(f.reviewReport, reportBefore);

  const reviewCases = [
    ["review FAIL", (r) => { r.verdict = "FAIL"; }],
    ["wrong review source", (r) => { r.source = "synthetic"; }],
    ["wrong review scope", (r) => { r.scope = "partial"; }],
    ["stale review HEAD", (r) => { r.head = f.identity.base; }],
    ["tampered review hash", (r) => { r.report.sha256 = "0".repeat(64); }],
  ];
  for (const [label, mutate] of reviewCases) {
    fs.writeFileSync(f.gateReceipt, gateBefore);
    fs.writeFileSync(f.reviewReceipt, reviewBefore);
    fs.writeFileSync(f.gateLog, logBefore);
    fs.writeFileSync(f.reviewReport, reportBefore);
    const changed = JSON.parse(reviewBefore.toString("utf8"));
    mutate(changed);
    writeJson(f.reviewReceipt, changed);
    assert.notEqual(verify(f).status, 0, `${label} unexpectedly passed`);
  }
  fs.writeFileSync(f.gateReceipt, gateBefore);
  fs.writeFileSync(f.reviewReceipt, reviewBefore);
  const badReport = Buffer.from(reportBefore.toString("utf8").replace("VERDICT: PASS", "VERDICT: FAIL"));
  fs.writeFileSync(f.reviewReport, badReport);
  const staleVerdict = JSON.parse(reviewBefore.toString("utf8"));
  staleVerdict.report.sha256 = sha(badReport);
  writeJson(f.reviewReceipt, staleVerdict);
  assert.notEqual(verify(f).status, 0, "a hash-matched non-PASS report unexpectedly passed");
  fs.writeFileSync(f.reviewReport, reportBefore);

  fs.writeFileSync(f.gateReceipt, "{\n");
  assert.notEqual(verify(f).status, 0, "malformed gate JSON unexpectedly passed");
  fs.writeFileSync(f.gateReceipt, gateBefore);
  const link = path.join(f.temp, "gate-link.json");
  fs.symlinkSync(f.gateReceipt, link);
  assert.notEqual(verify(f, update(f), { CODEX_GATE_RECEIPT: link }).status, 0, "symlinked receipt unexpectedly passed");
  fs.unlinkSync(link);

  fs.writeFileSync(path.join(f.repo, "dirty.txt"), "dirty\n");
  assert.notEqual(verify(f).status, 0, "dirty checkout unexpectedly passed");
  fs.unlinkSync(path.join(f.repo, "dirty.txt"));
  const alternate = runGit(f.repo, f.env, ["commit-tree", f.identity.tree, "-p", f.identity.base, "-m", "alternate exact tree"]);
  runGit(f.repo, f.env, ["update-ref", f.identity.branch, alternate]);
  assert.notEqual(verify(f).status, 0, "stale HEAD receipt unexpectedly passed");
  runGit(f.repo, f.env, ["update-ref", f.identity.branch, f.identity.head]);
  runGit(f.repo, f.env, ["update-ref", f.identity.baseRef, f.identity.head]);
  assert.notEqual(verify(f).status, 0, "stale base receipt unexpectedly passed");
  runGit(f.repo, f.env, ["update-ref", f.identity.baseRef, f.identity.base]);
  fs.writeFileSync(f.gateReceipt, gateBefore);
  fs.writeFileSync(f.reviewReceipt, reviewBefore);
  assert.equal(verify(f).status, 0, "restored exact candidate should pass");
});

test("installed hook blocks unreviewed transport, admits fixture receipts, rejects outgoing-ref mismatches", (t) => {
  const f = fixture(t);
  const install = run(lefthook, ["install"], { cwd: f.repo, env: f.env });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const feature = f.identity.branch;
  const unreviewed = run("git", ["push", "origin", `${feature}:${feature}`], { cwd: f.repo, env: f.env });
  assert.notEqual(unreviewed.status, 0, "unreviewed push unexpectedly passed");
  assert.equal(remoteRef(f, feature), null, "rejected push updated the bare remote");

  const admittedEnv = syntheticEvidence(f);
  const admitted = run("git", ["push", "origin", `${feature}:${feature}`], { cwd: f.repo, env: admittedEnv });
  assert.equal(admitted.status, 0, admitted.stderr || admitted.stdout);
  assert.equal(remoteRef(f, feature), f.identity.head, "admitted push did not update exact feature ref");

  runGit(f.repo, f.env, ["branch", "fix/other", f.identity.head]);
  const wrongLocal = run("git", ["push", "origin", "refs/heads/fix/other:refs/heads/fix/other"], { cwd: f.repo, env: admittedEnv });
  assert.notEqual(wrongLocal.status, 0, "non-checked-out local ref unexpectedly passed");
  assert.equal(remoteRef(f, "refs/heads/fix/other"), null, "wrong local ref updated the bare remote");
  const wrongRemote = run("git", ["push", "origin", `${feature}:refs/heads/fix/other`], { cwd: f.repo, env: admittedEnv });
  assert.notEqual(wrongRemote.status, 0, "mismatched remote ref unexpectedly passed");
  assert.equal(remoteRef(f, "refs/heads/fix/other"), null, "wrong remote ref updated the bare remote");
});