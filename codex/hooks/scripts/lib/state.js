import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ADD_MAX_MESSAGES, PROMPT_KEY_MAX_CHARS, STATE_MAX_PROMPT_IDS, STATE_MAX_PROMPTS, STATE_TTL_DAYS } from "./constants.js";
import { sanitizeId } from "./identity.js";

const EMPTY = () => ({ sessionId: null, projectId: null, promptIds: [], warned: false, flushed: false, prompts: {} });

function stateDir(dataDir) {
  return path.join(dataDir, "state");
}

export function statePath(dataDir, sessionId) {
  return path.join(stateDir(dataDir), `${sanitizeId(sessionId, "unknown")}.json`);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseState(raw) {
  return {
    sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : null,
    projectId: typeof raw?.projectId === "string" ? raw.projectId : null,
    promptIds: Array.isArray(raw?.promptIds) ? raw.promptIds.filter((v) => typeof v === "string") : [],
    warned: raw?.warned === true,
    flushed: raw?.flushed === true,
    // turn_id -> the prompt the host says the user typed. Codex posts its own
    // scaffolding as role:"user" too, so this is how capture tells the two
    // apart without guessing from the text.
    prompts: isPlainObject(raw?.prompts) ? raw.prompts : {},
  };
}

export function readState(dataDir, sessionId) {
  try {
    return parseState(JSON.parse(fs.readFileSync(statePath(dataDir, sessionId), "utf8")));
  } catch {
    return EMPTY();
  }
}

/**
 * Write via a temporary file and rename. Two Claude Code windows share this
 * directory, and a reader must never see a half-written prompt/liveness cache.
 */
function writeState(dataDir, sessionId, state) {
  const file = statePath(dataDir, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    // writeFileSync only applies mode when creating; enforce it either way.
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch {
    // Prompt/liveness cache only: recall can still work when this is unwritable.
    // Side-effect dedupe and settlement use the fail-closed durable journal below.
  }
}

/**
 * Mark the session as alive, right now.
 *
 * pendingFlushes uses the file's mtime to tell an abandoned session from a live
 * one, but the file is otherwise written only when a turn is CAPTURED. A single
 * agentic turn can run for many minutes without one, and the sweep would then
 * force a topic boundary into the middle of a live session. Recall calls this on
 * every prompt so the mtime tracks activity rather than captures.
 */
export function touchSession(dataDir, sessionId, projectId = null) {
  const state = readState(dataDir, sessionId);
  writeState(dataDir, sessionId, { ...state, sessionId, projectId: projectId ?? state.projectId });
}

export function isStored(state, promptId) {
  return typeof promptId === "string" && state.promptIds.includes(promptId);
}

/**
 * `projectId` is recorded with the turn because the sweep that seals an
 * abandoned session may run from a later session in a different repository,
 * and flushing with the wrong project id seals the wrong partition.
 */
/**
 * Record what the user actually typed this turn.
 *
 * UserPromptSubmit is handed `prompt` verbatim. The transcript is not so clear:
 * Codex posts `<recommended_plugins>`, `<environment_context>`, AGENTS.md and
 * IDE context as role:"user" items stamped with the same turn_id. Measured over
 * 151 real sessions, 158 of 495 user-role items were scaffolding - and by
 * volume 95% of the text. Keyed on this, capture keeps the user's words and
 * drops the rest without pattern-matching the host's current vocabulary.
 *
 * Bounded: only the open turns of one session, oldest evicted.
 */
export function rememberPrompt(dataDir, sessionId, turnId, prompt) {
  if (!turnId || typeof prompt !== "string" || prompt.trim() === "") return;
  const state = readState(dataDir, sessionId);
  const prompts = { ...state.prompts, [turnId]: prompt.slice(0, PROMPT_KEY_MAX_CHARS) };
  const keys = Object.keys(prompts);
  for (const stale of keys.slice(0, Math.max(0, keys.length - STATE_MAX_PROMPTS))) delete prompts[stale];
  writeState(dataDir, sessionId, { ...state, sessionId, prompts });
}

export function markStored(dataDir, sessionId, promptId, projectId = null) {
  const state = readState(dataDir, sessionId);
  if (!isStored(state, promptId)) state.promptIds = [...state.promptIds, promptId].slice(-STATE_MAX_PROMPT_IDS);
  // Every newly acknowledged scope is activity, even when another scope stored
  // this turn already. Deduplicate the profile count, not the liveness update.
  writeState(dataDir, sessionId, {
    ...state,
    sessionId,
    projectId: projectId ?? state.projectId,
    flushed: false,
  });
}

export function markFlushed(dataDir, sessionId) {
  const state = readState(dataDir, sessionId);
  writeState(dataDir, sessionId, { ...state, sessionId, flushed: true });
}

/**
 * Sessions whose tail was never sealed.
 *
 * Claude Code cancels the SessionEnd hook when the host exits in a hurry -
 * routine under `claude -p` - which leaves the turns after EverOS's last topic
 * boundary sitting in the buffer, never extracted. The next session sweeps them
 * up rather than leaving a silent gap. Only sessions untouched for `idleMs` are
 * eligible, so a session running in another window is never sealed underneath it.
 */
export function pendingFlushes(dataDir, idleMs) {
  const root = path.join(stateDir(dataDir), "writes");
  const result = { scopes: [], held: false };
  let names;
  try { names = fs.readdirSync(root); } catch (error) { result.held = error.code !== "ENOENT"; return result; }
  for (const name of names) {
    const file = path.join(root, name, "settled.json");
    let scope;
    try {
      scope = JSON.parse(fs.readFileSync(file, "utf8")).scope;
      if (!validScope(scope) || writeDigest(scope) !== name) throw new Error("unidentifiable scope");
    } catch {
      // ponytail: unidentifiable authority blocks this bounded sweep, not direct
      // independent writers. No cache can reconstruct its producing partition.
      return { scopes: [], held: true };
    }
    if (fs.existsSync(path.join(root, name, "intent"))) { result.held = true; continue; }
    try {
      const journal = readSettlement(file, scope);
      if (journal.revision > 0 && journal.flushedRevision !== journal.revision && scopeIdle(dataDir, scope, idleMs)) result.scopes.push(scope);
    } catch {
      // Re-enter the same exclusive claim boundary to park identifiable corruption.
      result.scopes.push(scope);
    }
  }
  return result;
}

/** Cache mtime is activity only; absent cache falls back to the durable receipt.
 * Rechecked under the exclusive claim before an abandoned flush may send.
 */
export function scopeIdle(dataDir, scope, idleMs) {
  let mtime;
  try { mtime = fs.statSync(statePath(dataDir, scope.sessionId)).mtimeMs; } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mtime = fs.statSync(path.join(stateDir(dataDir), "writes", writeDigest(scope), "settled.json")).mtimeMs;
  }
  return Math.floor(mtime) <= Date.now() - idleMs;
}

/** True at most once per session: the caller may print an "EverOS is down" line. */
export function claimWarning(dataDir, sessionId) {
  const state = readState(dataDir, sessionId);
  if (state.warned) return false;
  writeState(dataDir, sessionId, { ...state, sessionId, warned: true });
  return true;
}

/** Sessions end without telling us; sweep the leftovers on SessionEnd. */
export function pruneState(dataDir, ttlDays = STATE_TTL_DAYS) {
  const dir = stateDir(dataDir);
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const state = parseState(JSON.parse(fs.readFileSync(file, "utf8")));
      if (hasUnknownWrite(dataDir, state.sessionId)) continue;
      if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
    } catch { /* raced with another window; nothing to do */ }
  }
  return removed;
}

export const WRITE_HOLD = { systemMessage: "⚠️ EverOS: write outcome UNKNOWN / HOLD. Automatic add/flush replay is blocked; explicit reconciliation is required." };
export const writeDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function durableDirectory(dir) {
  if (fs.existsSync(dir)) { syncDirectory(path.dirname(dir)); return; }
  durableDirectory(path.dirname(dir));
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  syncDirectory(path.dirname(dir));
}

function durableJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function validScope(scope) {
  return isPlainObject(scope) && ["baseUrl", "appId", "projectId", "sessionId"].every((key) => typeof scope[key] === "string" && scope[key].length > 0)
    && Object.keys(scope).length === 4;
}

/** The one admission validator for capture, direct flush and sweep selection. */
function readSettlement(file, scope) {
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!validScope(scope) || !isPlainObject(journal) || writeDigest(journal.scope) !== writeDigest(scope) || !isPlainObject(journal.captures)
      || !Number.isSafeInteger(journal.revision) || journal.revision < 0
      || !(journal.flushedRevision === null || (Number.isSafeInteger(journal.flushedRevision)
        && journal.flushedRevision >= 0 && journal.flushedRevision <= journal.revision))) {
    throw new Error("invalid write settlement; HOLD");
  }
  let revisions = 0;
  for (const [key, receipt] of Object.entries(journal.captures)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !isPlainObject(receipt) || typeof receipt.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(receipt.snapshot)
        || !Number.isSafeInteger(receipt.total) || receipt.total <= 0
        || !Number.isSafeInteger(receipt.acknowledged) || receipt.acknowledged <= 0 || receipt.acknowledged > receipt.total
        || receipt.complete !== (receipt.acknowledged === receipt.total)
        || (!receipt.complete && receipt.acknowledged % ADD_MAX_MESSAGES !== 0)) {
      throw new Error("invalid capture settlement; HOLD");
    }
    revisions += Math.ceil(receipt.acknowledged / ADD_MAX_MESSAGES);
    if (!receipt.complete) throw new Error("incomplete capture settlement; HOLD");
  }
  if (revisions !== journal.revision) throw new Error("invalid settlement revision; HOLD");
  return journal;
}

/** Partition-bound journal, separate from the best-effort prompt/liveness cache.
 * An exclusive intent directory is NEVER recovered by age or process liveness.
 * Even an empty directory (crash before intent write) means UNKNOWN. Settled
 * receipts are retained, so TTL pruning cannot make an acknowledged turn new.
 * ponytail: one writer per partition/session; no automatic recovery protocol.
 */
export function claimWrite(dataDir, scope, operation) {
  if (!validScope(scope)) throw new Error("invalid write scope; HOLD");
  const dir = path.join(stateDir(dataDir), "writes", writeDigest(scope));
  const hold = path.join(dir, "intent");
  durableDirectory(path.dirname(dir));
  // Only our successful exclusive mkdir proves first use. A surviving directory
  // with missing authority is never initialized again (including a setup crash).
  let created = false;
  try { fs.mkdirSync(dir, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
  syncDirectory(path.dirname(dir));
  syncDirectory(dataDir);
  syncDirectory(path.dirname(dataDir));
  const file = path.join(dir, "settled.json");
  // A missing receipt is itself HOLD. Do not steal the initializer's intent
  // between its exclusive scope mkdir and publication of empty authority.
  if (!created && !fs.existsSync(file)) return null;
  try { fs.mkdirSync(hold, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  syncDirectory(dir);
  if (created) durableJson(file, { scope, captures: {}, revision: 0, flushedRevision: null });
  const journal = readSettlement(file, scope);
  const claim = { dir, hold, file, journal };
  // Store only identifiers, counts and digests: no transcript payload or error body.
  durableJson(path.join(hold, "unknown.json"), { outcome: "UNKNOWN", scope, ...operation, revision: journal.revision });
  return claim;
}

/** Called only with the exclusive claim. Failure deliberately leaves intent held. */
export function settleWrite(claim) {
  const temp = `${claim.file}.${process.pid}.tmp`;
  durableJson(temp, claim.journal);
  fs.renameSync(temp, claim.file);
  syncDirectory(claim.dir);
}

/** Release only AFTER matching acknowledged state is durably settled.
 * Fence all fallible writes while the (possibly empty) intent still blocks admission.
 * Final rmdir is deliberately not synced: a crash may restore HOLD, never lose an
 * acknowledgment. No fallible publication follows removal, so UNKNOWN retains HOLD.
 */
export function releaseWrite(claim) {
  fs.unlinkSync(path.join(claim.hold, "unknown.json"));
  syncDirectory(claim.dir);
  fs.rmdirSync(claim.hold);
}

function hasUnknownWrite(dataDir, sessionId) {
  const root = path.join(stateDir(dataDir), "writes");
  let names;
  try { names = fs.readdirSync(root); } catch (error) { return error.code !== "ENOENT"; }
  for (const name of names) {
    const hold = path.join(root, name, "intent");
    if (!fs.existsSync(hold)) continue;
    try {
      const intent = JSON.parse(fs.readFileSync(path.join(hold, "unknown.json"), "utf8"));
      if (intent.scope?.sessionId === sanitizeId(sessionId, "unknown")) return true;
    } catch { return true; } // Incomplete/corrupt intent must not enable a sweep.
  }
  return false;
}

export function writeScope(config, identity, sessionId) {
  return { baseUrl: config.baseUrl, appId: identity.appId, projectId: identity.projectId, sessionId: sanitizeId(sessionId, "unknown") };
}
