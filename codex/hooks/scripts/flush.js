#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity } from "./lib/identity.js";
import { flushSession, deadline } from "./lib/everos.js";
import { pruneState, writeScope, WRITE_HOLD } from "./lib/state.js";
import { FLUSH_DISPATCH_MS } from "./lib/constants.js";

// Registered for both SessionEnd and PreCompact; UNKNOWN must never be replayed.
runHook("SessionEnd", async (input, ctx) => {
  const { config, debug } = ctx;
  const event = input.hook_event_name ?? "SessionEnd";
  const sessionId = input.session_id;
  if (!sessionId) return undefined;
  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  const outcome = await flushSession(config, writeScope(config, identity, sessionId), deadline(FLUSH_DISPATCH_MS));
  debug(`${event}: flush ${outcome}`);
  if (event === "SessionEnd") {
    const removed = pruneState(config.dataDir);
    if (removed) debug(`pruned ${removed} stale state files`);
  }
  return outcome === "UNKNOWN" ? WRITE_HOLD : undefined;
});
