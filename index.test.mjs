import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("uses ExtensionAPI lifecycle hooks (pi.on) instead of deprecated pi.events.on wiring", () => {
  assert.match(source, /pi\.on\("notification"/);
  assert.match(source, /pi\.on\("stop"/);
  assert.equal(source.includes("pi.events.on("), false, "pi.events.on should be fully removed");
});

test("avoids unsafe sendMessage/sendUserMessage calls during factory init", () => {
  const start = source.indexOf("export default async function registerExtension");
  assert.ok(start >= 0, "registerExtension should exist");

  const sessionStartHook = source.indexOf('pi.on("session_start"', start);
  assert.ok(sessionStartHook > start, "session_start hook should be registered");

  const preHookSlice = source.slice(start, sessionStartHook);
  assert.equal(/pi\.sendMessage\(/.test(preHookSlice), false, "sendMessage before lifecycle hook registration is unsafe");
  assert.equal(/pi\.sendUserMessage\(/.test(preHookSlice), false, "sendUserMessage before lifecycle hook registration is unsafe");
});

test("tracks explicit mode boundaries plus structured lifecycle diagnostics", () => {
  assert.match(source, /type ManagedMode = "inactive" \| "auto" \| "step"/);
  assert.match(source, /plugin:\s*PLUGIN/);
  assert.match(source, /phase,/);
  assert.match(source, /retryType,/);
  assert.match(source, /attempt,/);
  assert.match(source, /reason,/);

  assert.match(source, /payload\.delayMs = delayMs/);
  assert.match(source, /payload\.escalation = escalation/);

  assert.match(source, /logLifecycle\("hook_notification"/);
  assert.match(source, /logLifecycle\("hook_stop"/);
  assert.match(source, /logLifecycle\("timer_cancel"/);
  assert.match(source, /`\$\{phase\}_scheduled`/);
  assert.match(source, /`\$\{phase\}_fired`/);
});

test("uses unified cancellable timer management for type1/type2/type3 retries", () => {
  assert.match(source, /type ManagedRetryType = Exclude<RetryType, "none">/);
  assert.match(source, /retryTimers:\s*Map<ManagedRetryType,\s*ScheduledRetryTimer>/);
  assert.match(source, /function cancelRetryTimer\(/);
  assert.match(source, /function cancelAllRetryTimers\(/);
  assert.match(source, /function scheduleRetryTimer\(/);
  assert.match(source, /state\.retryTimers\.set\(retryType,/);

  assert.match(source, /state\.retryTimers\.has\("type1"\)/);
  assert.match(source, /state\.retryTimers\.has\("type2"\)/);
  assert.match(source, /state\.retryTimers\.has\("type3"\)/);
});

test("resets retry counters on class switches and preserves type3 escalation path", () => {
  assert.match(source, /resetRetryCount\("type1", "type2_enter"\)/);
  assert.match(source, /resetRetryCount\("type2", "type1_enter"\)/);
  assert.match(source, /resetRetryCount\("type3", "type1_enter"\)/);
  assert.match(source, /resetSchemaOverloadRetries\("type2_enter"\)/);
  assert.match(source, /resetSchemaOverloadRetries\("type1_enter"\)/);

  assert.match(source, /triggerReason: state\.isFixingType3 \? `type3_in_progress:\$\{reason\}` : reason/);

  assert.match(source, /escalation:\s*"type1_to_type2"/);
  assert.match(source, /escalation:\s*"type2_to_type3"/);
});

test("guards retryLastTurn fallback with explicit safe path and no triggerTurn misuse", () => {
  assert.match(source, /function safeRetryLastTurn\(/);
  assert.match(source, /retryLastTurn_missing/);
  assert.match(source, /retry_last_turn_fallback/);
  assert.match(source, /safeSendUserMessage\(piApi, resumeCommand/);

  assert.equal(source.includes("triggerTurn"), false, "sendUserMessage no longer accepts triggerTurn");
});

test("adds schema-overload continuation path with in-place retryLastTurn", () => {
  assert.match(source, /SCHEMA_OVERLOAD_RE/);
  assert.match(source, /function classifyAsSchemaOverload\(/);
  assert.match(source, /function handleSchemaOverload\(/);
  assert.match(source, /schema_overload_retry/);
  assert.match(source, /Core schema-overload cap hit\. In-place retryLastTurn/);
  assert.match(source, /if \(classifyAsSchemaOverload\(combinedLog\)\)/);
  assert.equal(source.includes("/gsd auto"), true, "other paths may still use /gsd auto");
});

test("keeps stop handling simple: no custom-step soft-continue branch", () => {
  assert.equal(source.includes("CUSTOM_STEP_SOFT_CONTINUE_RE"), false);
  assert.equal(source.includes("handleSoftContinueForCustomStep"), false);
  assert.equal(source.includes("stop_cancelled_reclassified"), false);
  assert.match(source, /TOOL_INVOCATION_PASSTHROUGH_RE/);
  assert.match(source, /stop_passthrough_tool_invocation/);
});

test("forbids command-recognition and auto-lock heuristics; keeps programmatic session-end preservation", () => {
  assert.equal(source.includes("AUTO_MODE_COMMAND_RE"), false);
  assert.equal(source.includes("STEP_MODE_COMMAND_RE"), false);
  assert.equal(source.includes("STAND_DOWN_COMMAND_RE"), false);
  assert.equal(source.includes("applyModeBoundaryFromInput"), false);

  assert.equal(source.includes("AUTO_LOCK_REL_PATH"), false);
  assert.equal(source.includes("recoverModeFromSessionLock"), false);
  assert.equal(source.includes("existsSync("), false);

  assert.match(source, /event\.reason === "programmatic" && \(state\.mode !== "inactive" \|\| state\.isFixingType3\)/);
  assert.match(source, /logLifecycle\("session_end_mode_preserved"/);
});
