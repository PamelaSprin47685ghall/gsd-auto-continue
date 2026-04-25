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

test("keeps structured lifecycle diagnostics without mode-state dependency", () => {
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

  assert.equal(source.includes("type ManagedMode"), false);
  assert.equal(source.includes("state.mode"), false);
  assert.equal(source.includes("transitionMode("), false);
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

test("hijacks schema-overload at agent_end to force in-session transient retry path", () => {
  assert.match(source, /function getAgentEndErrorMessage\(/);
  assert.match(source, /pi\.on\("agent_end", \(event: \{ messages: unknown\[] \}\) => \{/);
  assert.match(source, /if \(!classifyAsSchemaOverload\(errorMsg\.toLowerCase\(\)\)\) return;/);
  assert.match(source, /if \(!lastMsg \|\| lastMsg\.stopReason !== "error"\) return;/);
  assert.match(source, /fetch failed \(schema-overload-transient-hijack\)/);
  assert.match(source, /lastMsg\.errorMessage = hijackedError;/);
  assert.match(source, /logLifecycle\("agent_end_schema_overload_hijack"/);
});

test("aborts a turn after 2 tool errors and auto-resumes on cancelled stop", () => {
  assert.match(source, /const MAX_TOOL_ERRORS_BEFORE_ABORT = 2/);
  assert.match(source, /toolErrorsInCurrentTurn: number/);
  assert.match(source, /toolErrorGuardAbortArmed: boolean/);

  assert.match(source, /pi\.on\("turn_start", \(\) => \{/);
  assert.match(source, /pi\.on\("tool_execution_end", \(event: \{ isError\?: boolean; toolName\?: string \}, ctx: ExtensionContext\) => \{/);
  assert.match(source, /state\.toolErrorsInCurrentTurn \+= 1/);
  assert.match(source, /if \(state\.toolErrorsInCurrentTurn < MAX_TOOL_ERRORS_BEFORE_ABORT\)/);
  assert.match(source, /state\.toolErrorGuardAbortArmed = true/);
  assert.match(source, /ctx\.abort\(\)/);
  assert.match(source, /logLifecycle\("tool_error_guard_abort_requested"/);

  assert.match(source, /if \(reason === "cancelled"\) \{/);
  assert.match(source, /if \(state\.toolErrorGuardAbortArmed\) \{/);
  assert.match(source, /phase: "tool_error_guard_resume"/);
  assert.match(source, /safeSendUserMessage\(pi, resumeCommand/);
});

test("forbids command-recognition, auto-lock and mode-branch heuristics", () => {
  assert.equal(source.includes("AUTO_MODE_COMMAND_RE"), false);
  assert.equal(source.includes("STEP_MODE_COMMAND_RE"), false);
  assert.equal(source.includes("STAND_DOWN_COMMAND_RE"), false);
  assert.equal(source.includes("applyModeBoundaryFromInput"), false);

  assert.equal(source.includes("AUTO_LOCK_REL_PATH"), false);
  assert.equal(source.includes("recoverModeFromSessionLock"), false);
  assert.equal(source.includes("existsSync("), false);

  assert.equal(source.includes("AUTO_MODE_STARTED_RE"), false);
  assert.equal(source.includes("STEP_MODE_STARTED_RE"), false);
  assert.equal(source.includes("stop:error_signature_bootstrap"), false);
  assert.equal(source.includes("mode_bootstrap_from_stop_error"), false);
  assert.equal(source.includes("mode_inactive"), false);

  assert.equal(source.includes("/gsd next"), false);
  assert.equal(source.includes('return "/gsd auto"'), true);
});
