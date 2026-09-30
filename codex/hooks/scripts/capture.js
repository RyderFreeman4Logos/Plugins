#!/usr/bin/env node
import fs from "node:fs/promises";
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity, sanitizeId } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { lastTurnId, parseTranscript, readTurn, toEverosMessages } from "./lib/transcript.js";
import { readState, markStored, claimWrite, settleWrite, releaseWrite, writeScope, writeDigest, WRITE_HOLD } from "./lib/state.js";
import { ADD_MAX_MESSAGES, CAPTURE_DEADLINE_MS } from "./lib/constants.js";

async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

runHook("Stop", async (input, ctx) => {
  const { config, debug } = ctx;
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    debug(`missing stdin fields: session_id=${sessionId} transcript_path=${transcriptPath}`);
    return undefined;
  }
  // Codex stamps turn_id on the Stop payload AND on every transcript item, so
  // the turn is addressable directly. Falling back to the last turn on disk
  // keeps the hook working if a future version stops sending it.
  let turnId = input.turn_id;
  if (!turnId) {
    turnId = lastTurnId(parseTranscript(await readFileOrEmpty(transcriptPath)));
    debug(`no turn_id on stdin; falling back to the last turn (${turnId})`);
    if (!turnId) return undefined;
  }

  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  if (!identity.userId) {
    debug("no user id; skipping capture");
    return undefined;
  }

  const turn = await readTurn(transcriptPath, turnId);
  // What the user actually typed, as the host reported it at UserPromptSubmit.
  // Without it every `<recommended_plugins>` block and every AGENTS.md dump
  // Codex posts as role:"user" would be stored as the user's own words.
  const userPrompt = readState(config.dataDir, sessionId).prompts?.[turnId];
  if (!userPrompt) debug(`no recorded prompt for ${turnId}; falling back to shape matching`);
  const messages = toEverosMessages(turn, { ...identity, userPrompt });
  if (messages.length === 0) {
    debug(`nothing to capture for ${turnId}`);
    return undefined;
  }

  const client = createClient({ baseUrl: config.baseUrl });
  const signal = deadline(CAPTURE_DEADLINE_MS);
  const key = writeDigest(turnId);
  const snapshot = writeDigest(messages);
  let committed = 0;
  try {
    const claim = claimWrite(config.dataDir, writeScope(config, identity, sessionId),
      { kind: "add", turn: key, snapshot, total: messages.length, batchSize: ADD_MAX_MESSAGES });
    if (!claim) return WRITE_HOLD;
    if (claim.journal.captures[key]) {
      const prior = claim.journal.captures[key];
      if (prior.complete !== true || prior.snapshot !== snapshot) return WRITE_HOLD;
      releaseWrite(claim);
      return undefined;
    }
    for (let start = 0; start < messages.length; start += ADD_MAX_MESSAGES) {
      const batch = messages.slice(start, start + ADD_MAX_MESSAGES);
      const data = await client.add(
        { session_id: sanitizeId(sessionId, "unknown"), app_id: identity.appId, project_id: identity.projectId, messages: batch }, signal,
      );
      if (!["accumulated", "extracted", "no_extraction"].includes(data?.status) || data.message_count !== batch.length) {
        throw new Error("invalid add acknowledgment");
      }
      committed += batch.length;
      claim.journal.captures[key] = { snapshot, acknowledged: committed, total: messages.length, complete: committed === messages.length };
      claim.journal.revision += 1;
      // Persist each acknowledged prefix BEFORE another batch can be attempted.
      settleWrite(claim);
    }
    releaseWrite(claim);
  } catch {
    debug(`capture UNKNOWN / HOLD; acknowledged prefix ${committed} of ${messages.length}`);
    return WRITE_HOLD;
  }
  markStored(config.dataDir, sessionId, turnId, identity.projectId);
  debug(`stored ${committed} of ${messages.length} messages for ${turnId}`);
  return config.verbose ? { systemMessage: `💾 EverOS: saved ${committed} messages` } : undefined;
});
