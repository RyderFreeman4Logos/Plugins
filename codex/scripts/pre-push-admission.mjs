#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_REF = "refs/remotes/origin/main";
const NODE20 = "v20.20.2";
const NODE22 = "v22.23.3";
const SCOPE = "complete-range";
function reject(message) { throw new Error(message); }
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function childEnv(env = process.env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) if (name.startsWith("GIT_")) delete clean[name];
  clean.GIT_CONFIG_GLOBAL = "/dev/null";
  clean.GIT_CONFIG_NOSYSTEM = "1";
  clean.GIT_NO_REPLACE_OBJECTS = "1";
  return clean;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) reject(`${command}: ${result.error.message}`);
  return result;
}
function git(args, cwd) {
  const result = run("git", args, { cwd, env: childEnv() });
  if (result.status !== 0) reject(`git ${args.join(" ")}: ${(result.stderr || "failed").trim()}`);
  return result.stdout.trim();
}
function tryGit(args, cwd) {
  const result = run("git", args, { cwd, env: childEnv() });
  return result.status === 0 ? result.stdout.trim() : null;
}
function snapshot() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  const branch = git(["symbolic-ref", "--quiet", "HEAD"], root);
  if (!branch.startsWith("refs/heads/") || ["refs/heads/main", "refs/heads/master"].includes(branch)) reject("checked-out ref must be a non-default feature branch");
  const defaultRef = tryGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root);
  const defaultBranch = defaultRef?.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/");
  if (branch === defaultBranch) reject("checked-out ref is the configured default branch");
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status) reject("checkout is not clean");
  const format = git(["rev-parse", "--show-object-format"], root);
  const oidLength = format === "sha1" ? 40 : format === "sha256" ? 64 : 0;
  if (!oidLength) reject(`unsupported Git object format: ${format}`);
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"], root);
  const tree = git(["rev-parse", "--verify", "HEAD^{tree}"], root);
  const base = git(["rev-parse", "--verify", `${BASE_REF}^{commit}`], root);
  const oid = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  if (![head, tree, base].every((value) => oid.test(value))) reject("Git returned a malformed object ID");
  if (head === base || tryGit(["merge-base", "--is-ancestor", base, head], root) === null) reject("HEAD must be a nonempty descendant of the declared base");
  return { root, branch, head, tree, base, oidLength };
}
function identity(candidate) {
  return {
    branch: candidate.branch,
    head: candidate.head,
    tree: candidate.tree,
    baseRef: BASE_REF,
    base: candidate.base,
    range: `${BASE_REF}...${candidate.head}`,
  };
}
function sameCandidate(before, after) {
  for (const key of ["root", "branch", "head", "tree", "base"]) {
    if (before[key] !== after[key]) reject(`candidate changed during admission: ${key}`);
  }
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) reject(`${label} has missing or unexpected fields`);
}
function tempRoot() {
  if (!process.env.HOME || !path.isAbsolute(process.env.HOME)) reject("HOME must be absolute");
  const root = fs.realpathSync(path.join(process.env.HOME, "tmp"));
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o777) !== 0o700 || fs.statSync("/mnt/ssd").dev !== rootStat.dev) reject("HOME/tmp must be a mode-0700 directory on the approved SSD");
  for (let parent = root; ; parent = path.dirname(parent)) {
    const mode = fs.statSync(parent).mode;
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) reject(`unsafe writable temp ancestor: ${parent}`);
    if (parent === path.dirname(parent)) break;
  }
  fs.accessSync(root, fs.constants.W_OK);
  return root;
}
function canonicalExisting(file, candidate) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file) reject("evidence path must be canonical and absolute");
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) reject("evidence must be a regular, non-symlink file");
  const real = fs.realpathSync(file);
  if (real !== file || isWithin(candidate.root, real) || !isWithin(tempRoot(), real) || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) reject("evidence must be an owned, non-writable external file under HOME/tmp");
  return fs.readFileSync(real);
}
function newEvidencePath(file, candidate) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file) reject("output path must be canonical and absolute");
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent || isWithin(candidate.root, file) || !isWithin(tempRoot(), file)) reject("output must be external to the checkout under HOME/tmp");
  try { fs.lstatSync(file); reject(`output already exists: ${file}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return file;
}
function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function writeReceipt(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { fs.closeSync(fd); }
}
function checkIdentity(value, candidate) {
  const expected = identity(candidate);
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) reject(`receipt candidate mismatch: ${key}`);
}
function readReceipt(envName, candidate) {
  const file = process.env[envName];
  if (!file) reject(`${envName} is required`);
  const bytes = canonicalExisting(file, candidate);
  if (bytes.length > 64 * 1024) reject(`${envName} is too large`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { reject(`${envName} is not valid JSON`); }
  return value;
}
function checkHashEvidence(value, field, candidate) {
  exactKeys(value, ["path", "sha256"], field);
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) reject(`${field} SHA-256 is malformed`);
  const bytes = canonicalExisting(value.path, candidate);
  if (digest(bytes) !== value.sha256) reject(`${field} SHA-256 mismatch`);
  return bytes;
}
function testSummaries(log) {
  const positions = [NODE20, NODE22].map((version) => {
    const hits = [...log.matchAll(new RegExp(`^${version.replaceAll(".", "\\.")}$`, "gm"))];
    if (hits.length !== 1) reject(`full log must contain exactly one ${version} runtime marker`);
    return hits[0].index;
  });
  if (positions[0] >= positions[1]) reject("full log Node runtime order is invalid");
  const result = {};
  for (const [i, key] of ["node20", "node22"].entries()) {
    const section = log.slice(positions[i], positions[i + 1] ?? log.length);
    const count = (name) => {
      const hits = [...section.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
      if (hits.length !== 1) reject(`${key} full test summary lacks one # ${name} count`);
      return Number(hits[0][1]);
    };
    const summary = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped"].map((name) => [name, count(name)]));
    if (summary.tests < 1 || summary.pass !== summary.tests || summary.fail !== 0 || summary.cancelled !== 0 || summary.skipped !== 0) reject(`${key} full test summary is not all-pass`);
    result[key] = summary;
  }
  return result;
}
function checkReviewReport(report, candidate) {
  const lines = report.replace(/\r?\n+$/, "").split(/\r?\n/);
  for (const line of expectedReviewLines(candidate)) if (!lines.includes(line)) reject(`review report lacks required attestation: ${line}`);
  if (lines.filter((line) => line === "VERDICT: PASS").length !== 1 || lines.at(-1) !== "VERDICT: PASS") reject("review report must end with one explicit VERDICT: PASS");
}
function checkGate(candidate) {
  const receipt = readReceipt("CODEX_GATE_RECEIPT", candidate);
  exactKeys(receipt, ["schema", "kind", "status", "branch", "head", "tree", "baseRef", "base", "range", "command", "node20", "node22", "testSummaries", "exitCode", "log"], "gate receipt");
  if (receipt.schema !== 1 || receipt.kind !== "gate" || receipt.status !== "PASS" || receipt.exitCode !== 0) reject("gate receipt is not a successful schema-1 full gate");
  checkIdentity(receipt, candidate);
  exactKeys(receipt.command, ["executable", "args"], "gate command");
  if (typeof receipt.command.executable !== "string" || !path.isAbsolute(receipt.command.executable) || path.basename(receipt.command.executable) !== "just" || JSON.stringify(receipt.command.args) !== JSON.stringify(["codex-full", receipt.node20?.path, receipt.node22?.path])) reject("gate command is not the declared Node 20/22 codex-full matrix");
  for (const [key, version] of [["node20", NODE20], ["node22", NODE22]]) {
    exactKeys(receipt[key], ["path", "version"], key);
    if (typeof receipt[key].path !== "string" || !path.isAbsolute(receipt[key].path) || receipt[key].version !== version) reject(`${key} runtime evidence is invalid`);
  }
  const summaries = testSummaries(checkHashEvidence(receipt.log, "gate log", candidate).toString("utf8"));
  exactKeys(receipt.testSummaries, ["node20", "node22"], "gate test summaries");
  for (const key of ["node20", "node22"]) {
    exactKeys(receipt.testSummaries[key], ["tests", "pass", "fail", "cancelled", "skipped"], `${key} test summary`);
    for (const field of ["tests", "pass", "fail", "cancelled", "skipped"]) if (receipt.testSummaries[key][field] !== summaries[key][field]) reject(`${key} receipt test count mismatch: ${field}`);
  }
}
function expectedReviewLines(candidate) {
  const facts = identity(candidate);
  return [
    `Candidate: ${facts.head}`,
    `Tree: ${facts.tree}`,
    `Base: ${facts.baseRef} ${facts.base}`,
    `Range: ${facts.range}`,
    `Scope: ${SCOPE}`,
    "VERDICT: PASS",
  ];
}
function checkReview(candidate) {
  const receipt = readReceipt("CODEX_REVIEW_RECEIPT", candidate);
  exactKeys(receipt, ["schema", "kind", "source", "verdict", "scope", "branch", "head", "tree", "baseRef", "base", "range", "report"], "review receipt");
  if (receipt.schema !== 1 || receipt.kind !== "review" || receipt.source !== "native" || receipt.verdict !== "PASS" || receipt.scope !== SCOPE) reject("review receipt is not a native complete-range PASS");
  checkIdentity(receipt, candidate);
  checkReviewReport(checkHashEvidence(receipt.report, "review report", candidate).toString("utf8"), candidate);
}
function parseUpdate(input, candidate) {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > 4096 || bytes.some((byte) => byte > 0x7f)) reject("pre-push stdin is missing or malformed");
  let line = bytes.toString("ascii");
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (!line || /[\r\n\t]/.test(line)) reject("exactly one pre-push update is required");
  const fields = line.split(" ");
  if (fields.length !== 4 || fields.some((field) => !field) || fields.join(" ") !== line) reject("pre-push update must contain exactly four fields");
  const [localRef, localOid, remoteRef, remoteOid] = fields;
  const oidPattern = new RegExp(`^[0-9a-f]{${candidate.oidLength}}$`);
  const zero = "0".repeat(candidate.oidLength);
  if (!oidPattern.test(localOid) || !oidPattern.test(remoteOid)) reject("pre-push object ID is malformed");
  if (localOid === zero) reject("deletion updates are forbidden");
  for (const ref of [localRef, remoteRef]) {
    if (!ref.startsWith("refs/heads/") || git(["check-ref-format", ref], candidate.root) !== "") reject("only valid branch refs are admissible");
  }
  if (localRef !== candidate.branch || remoteRef !== candidate.branch || localOid !== candidate.head) reject("outgoing update must be the checked-out feature branch at HEAD");
}
async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) reject("pre-push stdin is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function verify() {
  const candidate = snapshot();
  return readStdin().then((input) => {
    parseUpdate(input, candidate);
    checkGate(candidate);
    checkReview(candidate);
    sameCandidate(candidate, snapshot());
    console.log(`PASS pre-push admission: ${candidate.branch} ${candidate.head}`);
  });
}
function executable(file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) reject("tool path must be canonical and absolute");
  fs.accessSync(file, fs.constants.X_OK);
  if (!fs.statSync(file).isFile()) reject("tool path is not a regular executable");
  return file;
}
function runGate(args) {
  if (args.length !== 5) reject("usage: record-gate <just> <node20> <node22> <full-log> <gate-receipt>");
  const candidate = snapshot();
  const just = executable(args[0]);
  const node20 = executable(args[1]);
  const node22 = executable(args[2]);
  const logPath = newEvidencePath(args[3], candidate);
  const receiptPath = newEvidencePath(args[4], candidate);
  if (logPath === receiptPath) reject("gate log and receipt must be distinct files");
  const getVersion = (file) => {
    const result = run(file, ["--version"], { cwd: candidate.root, env: childEnv() });
    if (result.status !== 0) reject(`${file} --version failed`);
    return result.stdout.trim();
  };
  if (getVersion(node20) !== NODE20 || getVersion(node22) !== NODE22) reject(`gate runtimes must be exactly ${NODE20} and ${NODE22}`);
  const temp = tempRoot();
  const fd = fs.openSync(logPath, "wx", 0o600);
  let result;
  try {
    const env = childEnv({ ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp });
    result = run(just, ["codex-full", node20, node22], { cwd: candidate.root, env, stdio: ["ignore", fd, fd] });
  } finally { fs.closeSync(fd); }
  if (result.error) reject(`codex-full could not start: ${result.error.message}`);
  if (result.status !== 0) reject(`codex-full exited ${result.status}; full log retained at ${logPath}`);
  const logBytes = canonicalExisting(logPath, candidate);
  const log = logBytes.toString("utf8");
  const summaries = testSummaries(log);
  sameCandidate(candidate, snapshot());
  const receipt = {
    schema: 1, kind: "gate", status: "PASS", ...identity(candidate),
    command: { executable: just, args: ["codex-full", node20, node22] },
    node20: { path: node20, version: NODE20 },
    node22: { path: node22, version: NODE22 },
    testSummaries: summaries,
    exitCode: 0,
    log: { path: logPath, sha256: digest(logBytes) },
  };
  writeReceipt(receiptPath, receipt);
  console.log(`PASS gate receipt: ${receiptPath}`);
}
function runReview(args) {
  if (args.length !== 2) reject("usage: record-review <full-native-review-report> <review-receipt>");
  const candidate = snapshot();
  const reportPath = args[0];
  const receiptPath = newEvidencePath(args[1], candidate);
  const reportBytes = canonicalExisting(reportPath, candidate);
  checkReviewReport(reportBytes.toString("utf8"), candidate);
  sameCandidate(candidate, snapshot());
  writeReceipt(receiptPath, {
    schema: 1, kind: "review", source: "native", verdict: "PASS", scope: SCOPE,
    ...identity(candidate), report: { path: reportPath, sha256: digest(reportBytes) },
  });
  console.log(`PASS review receipt: ${receiptPath}`);
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "verify" && args.length === 0) await verify();
  else if (mode === "record-gate") runGate(args);
  else if (mode === "record-review") runReview(args);
  else reject("usage: pre-push-admission.mjs verify | record-gate ... | record-review ...");
}

main().catch((error) => {
  console.error(`pre-push admission: ${error.message}`);
  process.exitCode = 1;
});
