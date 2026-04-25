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

  assert.match(source, /if \(state\.isFixingType3 \|\| classifyAsType3\(reason, combinedLog\)\)/);
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
