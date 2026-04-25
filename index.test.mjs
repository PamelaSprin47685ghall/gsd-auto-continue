import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const REQUIRED_LIFECYCLE_HOOKS = [
  "session_start",
  "session_end",
  "session_shutdown",
  "before_agent_start",
  "agent_end",
  "turn_end",
  "input",
  "notification",
  "stop",
];

let importCounter = 0;

// Behavior-test contract: this suite imports the real index.ts entrypoint,
// captures lifecycle handlers registered through pi.on, and must not inspect
// the implementation file as text. Regression checks live at the public
// lifecycle boundary so the runtime can be refactored without structure locks.
async function importExtension() {
  const importPath = new URL(`./index.ts?behavior-harness=${Date.now()}-${importCounter++}`, import.meta.url).href;

  try {
    const module = await import(importPath);
    assert.equal(typeof module.default, "function", `default export must be a factory: ${importPath}`);
    return { registerExtension: module.default, importPath };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`failed to import real gsd-auto-continue entrypoint ${importPath}: ${detail}`);
  }
}

function createFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  let nextId = 1;

  globalThis.setTimeout = (callback, delayMs = 0, ...args) => {
    const timer = {
      id: nextId++,
      delayMs,
      callback,
      args,
      cancelled: false,
      fired: false,
    };
    timers.push(timer);
    return timer;
  };

  globalThis.clearTimeout = (handle) => {
    const timer = timers.find((candidate) => candidate === handle || candidate.id === handle);
    if (timer) timer.cancelled = true;
  };

  async function flushNextTimer() {
    const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
    assert.ok(timer, "expected a scheduled timer to flush, but none was pending");

    timer.fired = true;
    await timer.callback(...timer.args);
    return timer;
  }

  function pendingTimers() {
    return timers.filter((timer) => !timer.cancelled && !timer.fired);
  }

  function cleanup() {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  return { timers, flushNextTimer, pendingTimers, cleanup };
}

function parseAutoContinueNotification(message) {
  const prefix = "[AutoContinue] ";
  if (typeof message !== "string" || !message.startsWith(prefix)) return undefined;

  try {
    return JSON.parse(message.slice(prefix.length));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`malformed [AutoContinue] notification payload: ${detail}; message=${message}`);
  }
}

function createMockPi({
  retryLastTurnMode = "record",
  sendUserMessageMode = "record",
  triggerTurnSendMessageMode = "record",
} = {}) {
  const handlers = new Map();
  const sendMessageCalls = [];
  const sendUserMessageCalls = [];
  const retryLastTurnCalls = [];

  const pi = {
    on(eventName, handler) {
      assert.equal(typeof eventName, "string", "pi.on event name must be a string");
      assert.equal(typeof handler, "function", `pi.on handler for ${eventName} must be a function`);
      handlers.set(eventName, handler);
    },
    sendMessage(message, options) {
      sendMessageCalls.push({ message, options });
      if (options?.triggerTurn === true && triggerTurnSendMessageMode === "throw") {
        throw new Error("synthetic triggerTurn sendMessage failure");
      }
    },
    sendUserMessage(content, options) {
      sendUserMessageCalls.push({ content, options });
      if (sendUserMessageMode === "throw") {
        throw new Error("synthetic sendUserMessage failure");
      }
    },
  };

  if (retryLastTurnMode === "record") {
    pi.retryLastTurn = (...args) => {
      retryLastTurnCalls.push(args);
    };
  }

  if (retryLastTurnMode === "throw") {
    pi.retryLastTurn = (...args) => {
      retryLastTurnCalls.push(args);
      throw new Error("synthetic retryLastTurn failure");
    };
  }

  function getHandler(eventName) {
    const handler = handlers.get(eventName);
    assert.equal(
      typeof handler,
      "function",
      `missing lifecycle handler for ${eventName}; registered events: ${[...handlers.keys()].sort().join(", ") || "(none)"}`,
    );
    return handler;
  }

  return {
    pi,
    handlers,
    getHandler,
    sendMessageCalls,
    sendUserMessageCalls,
    retryLastTurnCalls,
  };
}

function createMockContext({ withUi = true, abortMode = "record" } = {}) {
  const rawNotifications = [];
  const diagnostics = [];
  const abortCalls = [];

  const ctx = {
    abort() {
      abortCalls.push({});
      if (abortMode === "throw") {
        throw new Error("synthetic ctx.abort failure");
      }
    },
  };

  if (withUi) {
    ctx.ui = {
      notify(message, level) {
        rawNotifications.push({ message, level });
        const diagnostic = parseAutoContinueNotification(message);
        if (diagnostic) diagnostics.push(diagnostic);
      },
    };
  }

  return { ctx, rawNotifications, diagnostics, abortCalls };
}

async function createHarness(
  t,
  {
    retryLastTurnMode = "record",
    schemaOverloadMaxRetries,
    sendUserMessageMode = "record",
    triggerTurnSendMessageMode = "record",
  } = {},
) {
  const originalSchemaOverloadMaxRetries = process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES;
  if (schemaOverloadMaxRetries === undefined) {
    // Keep the caller's environment untouched for normal imports.
  } else if (schemaOverloadMaxRetries === null) {
    delete process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES;
  } else {
    process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES = String(schemaOverloadMaxRetries);
  }

  const timers = createFakeTimers();
  t.after(() => {
    if (originalSchemaOverloadMaxRetries === undefined) {
      delete process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES;
    } else {
      process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES = originalSchemaOverloadMaxRetries;
    }
    timers.cleanup();
  });

  const mockPi = createMockPi({ retryLastTurnMode, sendUserMessageMode, triggerTurnSendMessageMode });
  const { registerExtension } = await importExtension();
  await registerExtension(mockPi.pi);

  return { ...mockPi, timers };
}

function assertNoUnsafeFactoryActions(harness) {
  assert.deepEqual(harness.sendMessageCalls, [], "factory initialization must not send system messages");
  assert.deepEqual(harness.sendUserMessageCalls, [], "factory initialization must not send user messages");
  assert.deepEqual(harness.retryLastTurnCalls, [], "factory initialization must not retry the last turn");
}

async function startSession(harness, context) {
  await harness.getHandler("session_start")({ type: "session_start" }, context.ctx);
}

async function emitAutoPause(harness, context, message = "auto-mode paused after synthetic failure") {
  await harness.getHandler("notification")({ type: "notification", kind: "error", message }, context.ctx);
}

async function stopWith(harness, context, reason, errorMessage = "") {
  await harness.getHandler("stop")(
    { type: "stop", reason, lastMessage: errorMessage ? { errorMessage } : undefined },
    context.ctx,
  );
}

async function pausedStop(harness, context, reason, errorMessage) {
  await emitAutoPause(harness, context, `auto-mode paused after ${errorMessage}`);
  await stopWith(harness, context, reason, errorMessage);
}

function diagnosticsFor(context, phases) {
  const phaseSet = new Set(Array.isArray(phases) ? phases : [phases]);
  return context.diagnostics.filter((payload) => phaseSet.has(payload.phase));
}

function latestDiagnostic(context, phase) {
  const matches = diagnosticsFor(context, phase);
  assert.ok(matches.length > 0, `expected diagnostic phase ${phase}`);
  return matches[matches.length - 1];
}

const REQUIRED_DIAGNOSTIC_KEYS = ["plugin", "phase", "retryType", "attempt", "reason", "fixingType3"];
const OPTIONAL_DIAGNOSTIC_KEYS = ["detail", "delayMs", "escalation"];
const ALLOWED_DIAGNOSTIC_KEYS = new Set([...REQUIRED_DIAGNOSTIC_KEYS, ...OPTIONAL_DIAGNOSTIC_KEYS]);

function assertDiagnosticPayloadKeys(context, optionalKeysByPhase = new Map()) {
  assert.ok(context.diagnostics.length > 0, "expected parsed [AutoContinue] diagnostic payloads");

  for (const payload of context.diagnostics) {
    for (const key of REQUIRED_DIAGNOSTIC_KEYS) {
      assert.ok(Object.hasOwn(payload, key), `diagnostic ${payload.phase} missing required key ${key}`);
    }

    for (const key of Object.keys(payload)) {
      assert.ok(ALLOWED_DIAGNOSTIC_KEYS.has(key), `diagnostic ${payload.phase} has unexpected key ${key}`);
    }

    assert.equal(payload.plugin, "gsd-auto-continue", `diagnostic ${payload.phase} must identify the plugin`);
    assert.equal(typeof payload.phase, "string", "diagnostic phase must be a string");
    assert.equal(typeof payload.retryType, "string", `diagnostic ${payload.phase} retryType must be a string`);
    assert.equal(typeof payload.attempt, "number", `diagnostic ${payload.phase} attempt must be numeric`);
    assert.equal(typeof payload.reason, "string", `diagnostic ${payload.phase} reason must be a string`);
    assert.equal(typeof payload.fixingType3, "boolean", `diagnostic ${payload.phase} fixingType3 must be boolean`);

    if (Object.hasOwn(payload, "detail")) {
      assert.equal(typeof payload.detail, "string", `diagnostic ${payload.phase} detail must be a string`);
      assert.ok(payload.detail.length <= 320, `diagnostic ${payload.phase} detail must remain truncated`);
    }
    if (Object.hasOwn(payload, "delayMs")) {
      assert.equal(typeof payload.delayMs, "number", `diagnostic ${payload.phase} delayMs must be numeric`);
    }
    if (Object.hasOwn(payload, "escalation")) {
      assert.equal(typeof payload.escalation, "string", `diagnostic ${payload.phase} escalation must be a string`);
      assert.notEqual(payload.escalation, "none", `diagnostic ${payload.phase} must omit no-op escalation`);
    }

    const expectedOptionalKeys = optionalKeysByPhase.get(payload.phase);
    if (expectedOptionalKeys) {
      const presentOptionalKeys = OPTIONAL_DIAGNOSTIC_KEYS.filter((key) => Object.hasOwn(payload, key));
      assert.deepEqual(presentOptionalKeys.sort(), [...expectedOptionalKeys].sort(), `diagnostic ${payload.phase} optional keys changed`);
    }
  }
}

function findTriggerTurnMessage(harness) {
  return harness.sendMessageCalls.find((call) => call.options?.triggerTurn === true);
}

function hasManualInterventionMessage(harness) {
  return harness.sendMessageCalls.some(
    (call) =>
      call.message.customType === "system" &&
      String(call.message.content).includes("User/manual intervention detected"),
  );
}

test("registers expected lifecycle hooks through the real extension entrypoint", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual([...harness.handlers.keys()].sort(), [...REQUIRED_LIFECYCLE_HOOKS].sort());
  for (const eventName of REQUIRED_LIFECYCLE_HOOKS) {
    assert.equal(typeof harness.getHandler(eventName), "function");
  }
});

test("does not perform unsafe send actions during factory initialization", async (t) => {
  const harness = await createHarness(t);

  assertNoUnsafeFactoryActions(harness);
  assert.deepEqual(harness.timers.pendingTimers(), [], "factory initialization must not schedule retry timers");
});

test("tolerates a missing optional UI notifier while registering and invoking session_start", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext({ withUi: false });

  await startSession(harness, context);

  assert.equal(harness.handlers.size, REQUIRED_LIFECYCLE_HOOKS.length);
  assert.equal(harness.sendMessageCalls.length, 1);
  assert.equal(harness.sendMessageCalls[0].message.customType, "system");
  assert.equal(context.rawNotifications.length, 0);
});

test("emits session-start lifecycle diagnostics only after session_start is invoked", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  assertNoUnsafeFactoryActions(harness);
  assert.deepEqual(context.diagnostics, [], "factory_registered is not emitted until a UI notifier is bound");

  await startSession(harness, context);

  assert.equal(harness.sendMessageCalls.length, 1);
  assert.deepEqual(
    context.diagnostics.map((payload) => payload.phase),
    ["hook_session_start"],
  );
  assert.deepEqual(context.diagnostics[0], {
    plugin: "gsd-auto-continue",
    phase: "hook_session_start",
    retryType: "none",
    attempt: 0,
    reason: "session_start",
    fixingType3: false,
  });
});

test("completed stop stands down active recovery and cancels pending timers", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic network timeout");

  assert.equal(harness.timers.pendingTimers().length, 1);

  await stopWith(harness, context, "completed");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(harness.timers.timers[0].cancelled, true);
  assert.equal(hasManualInterventionMessage(harness), false);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.deepEqual(
    diagnosticsFor(context, ["timer_cancel", "retry_reset", "schema_overload_reset", "recovery_stood_down"])
      .map((payload) => ({ phase: payload.phase, retryType: payload.retryType, attempt: payload.attempt, reason: payload.reason })),
    [
      { phase: "timer_cancel", retryType: "type1", attempt: 1, reason: "stop:completed:stand_down" },
      { phase: "retry_reset", retryType: "type1", attempt: 0, reason: "stop:completed:stand_down" },
      { phase: "retry_reset", retryType: "type2", attempt: 0, reason: "stop:completed:stand_down" },
      { phase: "retry_reset", retryType: "type3", attempt: 0, reason: "stop:completed:stand_down" },
      { phase: "schema_overload_reset", retryType: "type1", attempt: 0, reason: "stop:completed:stand_down" },
      { phase: "recovery_stood_down", retryType: "none", attempt: 0, reason: "stop:completed" },
    ],
  );
});

test("plain cancelled stop stands down without scheduling or user intervention messaging", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "cancelled");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.equal(hasManualInterventionMessage(harness), false);
  assert.deepEqual(
    diagnosticsFor(context, ["retry_reset", "schema_overload_reset", "recovery_stood_down"])
      .map((payload) => ({ phase: payload.phase, retryType: payload.retryType, attempt: payload.attempt, reason: payload.reason })),
    [
      { phase: "retry_reset", retryType: "type1", attempt: 0, reason: "stop:cancelled:stand_down" },
      { phase: "retry_reset", retryType: "type2", attempt: 0, reason: "stop:cancelled:stand_down" },
      { phase: "retry_reset", retryType: "type3", attempt: 0, reason: "stop:cancelled:stand_down" },
      { phase: "schema_overload_reset", retryType: "type1", attempt: 0, reason: "stop:cancelled:stand_down" },
      { phase: "recovery_stood_down", retryType: "none", attempt: 0, reason: "stop:cancelled" },
    ],
  );
});

test("manual intervention stop emits a stand-down message while recovery is active", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic network timeout");
  await harness.getHandler("notification")(
    { type: "notification", kind: "input_needed", message: "manual intervention requested by operator" },
    context.ctx,
  );
  await stopWith(harness, context, "error", "manual intervention requested by operator");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(harness.timers.timers[0].cancelled, true);
  assert.equal(hasManualInterventionMessage(harness), true);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.deepEqual(
    diagnosticsFor(context, ["stop_stand_down_user_intervention", "timer_cancel", "recovery_stood_down"])
      .map((payload) => ({ phase: payload.phase, retryType: payload.retryType, reason: payload.reason })),
    [
      { phase: "stop_stand_down_user_intervention", retryType: "none", reason: "error" },
      { phase: "timer_cancel", retryType: "type1", reason: "stop:user_intervention_detected:stand_down" },
      { phase: "recovery_stood_down", retryType: "none", reason: "stop:user_intervention_detected" },
    ],
  );
});

test("manual intervention text without active recovery does not emit a stand-down message", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("notification")(
    { type: "notification", kind: "input_needed", message: "manual intervention requested by operator" },
    context.ctx,
  );
  await stopWith(harness, context, "error", "manual intervention requested by operator");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(hasManualInterventionMessage(harness), false);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.deepEqual(
    diagnosticsFor(context, ["stop_stand_down_user_intervention", "recovery_stood_down"])
      .map((payload) => ({ phase: payload.phase, reason: payload.reason, detail: payload.detail })),
    [
      { phase: "stop_stand_down_user_intervention", reason: "error", detail: undefined },
      { phase: "recovery_stood_down", reason: "stop:user_intervention_detected", detail: "wasRecovering=no" },
    ],
  );
});

test("error stop without a recent auto-pause signal passes through without recovery dispatch", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "error", "synthetic network timeout");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.equal(harness.sendMessageCalls.length, 1);
  assert.deepEqual(latestDiagnostic(context, "stop_passthrough_no_recent_auto_pause"), {
    plugin: "gsd-auto-continue",
    phase: "stop_passthrough_no_recent_auto_pause",
    retryType: "none",
    attempt: 0,
    reason: "error",
    fixingType3: false,
    detail: "pause_signal_missing_for_this_stop_turn",
  });
});

test("error stop with a current-turn auto-pause signal enters the recovery decision chain", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic network timeout");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.deepEqual(
    diagnosticsFor(context, ["auto_pause_signal_observed", "type1_retry_scheduled"])
      .map((payload) => ({ phase: payload.phase, retryType: payload.retryType, attempt: payload.attempt, reason: payload.reason, delayMs: payload.delayMs })),
    [
      { phase: "auto_pause_signal_observed", retryType: "none", attempt: 0, reason: "error", delayMs: undefined },
      { phase: "type1_retry_scheduled", retryType: "type1", attempt: 1, reason: "network_or_timeout", delayMs: 2000 },
    ],
  );
});

test("Type0 tool invocation validation failures schedule an in-session continuation", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("notification")(
    { type: "notification", kind: "error", message: "tool invocation failed: validation failed for tool synthetic_tool" },
    context.ctx,
  );
  await stopWith(harness, context, "error", "validation failed for tool synthetic_tool");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 300);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Type 0 detected/);
  assert.deepEqual(
    diagnosticsFor(context, "type0_continue_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
    })),
    [{ retryType: "type1", attempt: 0, reason: "error", delayMs: 300 }],
  );

  const timer = await harness.timers.flushNextTimer();

  assert.equal(timer.delayMs, 300);
  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /Continue execution from current context/);
  assert.match(harness.sendUserMessageCalls[0].content, /tool invocation\/validation errors/);
  assert.deepEqual(
    diagnosticsFor(context, "type0_continue_fired").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
    })),
    [{ retryType: "type1", attempt: 0, reason: "error", delayMs: 300 }],
  );
});

test("Type0 sendUserMessage failure falls back to hidden trigger-turn sendMessage", async (t) => {
  const harness = await createHarness(t, { sendUserMessageMode: "throw" });
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("notification")(
    { type: "notification", kind: "error", message: "tool invocation failed: validation failed for tool synthetic_tool" },
    context.ctx,
  );
  await stopWith(harness, context, "error", "validation failed for tool synthetic_tool");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.sendMessageCalls.filter((call) => call.options?.triggerTurn === true).length, 0);

  await harness.timers.flushNextTimer();

  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /tool invocation\/validation errors/);

  const triggerTurnCall = findTriggerTurnMessage(harness);
  assert.ok(triggerTurnCall, "sendUserMessage failure should dispatch a hidden trigger-turn sendMessage fallback");
  assert.equal(triggerTurnCall.message.customType, "auto-continue-recovery");
  assert.equal(triggerTurnCall.message.display, false);
  assert.match(triggerTurnCall.message.content, /Continue execution from current context/);
  assert.deepEqual(triggerTurnCall.options, { triggerTurn: true });

  assert.match(latestDiagnostic(context, "type0_continue_send_user_message_failed").detail, /synthetic sendUserMessage failure/);
  assert.deepEqual(
    latestDiagnostic(context, "type0_continue_trigger_turn_called"),
    {
      plugin: "gsd-auto-continue",
      phase: "type0_continue_trigger_turn_called",
      retryType: "type1",
      attempt: 0,
      reason: "tool_use_error",
      fixingType3: false,
      detail: "fallback_sendMessage_triggerTurn",
    },
  );
});

test("Type3 hidden trigger-turn fallback failure is reported without escaping the timer", async (t) => {
  const harness = await createHarness(t, {
    sendUserMessageMode: "throw",
    triggerTurnSendMessageMode: "throw",
  });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "blocked", "synthetic blocker needs fallback failure coverage");

  assert.equal(harness.timers.pendingTimers().length, 1);
  await harness.timers.flushNextTimer();

  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /manual recovery turn outside auto-mode/);

  const triggerTurnCall = findTriggerTurnMessage(harness);
  assert.ok(triggerTurnCall, "trigger-turn fallback should be attempted before its synthetic failure is normalized");
  assert.equal(triggerTurnCall.options.triggerTurn, true);
  assert.equal(harness.timers.pendingTimers().length, 0, "failed fallback action must not leave the fired timer pending");
  assert.match(latestDiagnostic(context, "type3_fix_send_user_message_failed").detail, /synthetic sendUserMessage failure/);
  assert.match(latestDiagnostic(context, "type3_fix_trigger_turn_failed").detail, /synthetic triggerTurn sendMessage failure/);
});
test("escape pause banner is stashed as auto-pause context without manual-intervention stand-down", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await emitAutoPause(harness, context, "auto-mode paused (escape)");
  await stopWith(harness, context, "blocked", "synthetic blocker after escape pause");

  assert.equal(hasManualInterventionMessage(harness), false);
  assert.equal(diagnosticsFor(context, "stop_stand_down_user_intervention").length, 0);
  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.deepEqual(
    diagnosticsFor(context, ["auto_pause_signal_observed", "notification_stashed", "type3_fix_scheduled"])
      .map((payload) => ({ phase: payload.phase, retryType: payload.retryType, attempt: payload.attempt, reason: payload.reason, delayMs: payload.delayMs })),
    [
      { phase: "auto_pause_signal_observed", retryType: "none", attempt: 0, reason: "error", delayMs: undefined },
      { phase: "notification_stashed", retryType: "none", attempt: 0, reason: "error", delayMs: undefined },
      { phase: "type3_fix_scheduled", retryType: "type3", attempt: 1, reason: "blocked", delayMs: 2000 },
    ],
  );
});

test("Type1 network retry schedules a 2000ms retry and uses retryLastTurn when available", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic network timeout");

  const pending = harness.timers.pendingTimers();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delayMs, 2000);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Type 1 retry in 2s/);
  assert.deepEqual(
    diagnosticsFor(context, "type1_retry_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
      detail: payload.detail,
    })),
    [{ retryType: "type1", attempt: 1, reason: "network_or_timeout", delayMs: 2000, detail: "retryLastTurn" }],
  );

  const timer = await harness.timers.flushNextTimer();

  assert.equal(timer.delayMs, 2000);
  assert.equal(harness.retryLastTurnCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls.length, 0);
  assert.deepEqual(
    diagnosticsFor(context, ["type1_retry_fired", "type1_retry_retry_last_turn_called"]).map((payload) => ({
      phase: payload.phase,
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
    })),
    [
      { phase: "type1_retry_fired", retryType: "type1", attempt: 1, reason: "network_or_timeout", delayMs: 2000 },
      { phase: "type1_retry_retry_last_turn_called", retryType: "type1", attempt: 1, reason: "network_or_timeout", delayMs: undefined },
    ],
  );
});

test("Type1 falls back to sendUserMessage when retryLastTurn is missing", async (t) => {
  const harness = await createHarness(t, { retryLastTurnMode: "missing" });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic fetch failed");
  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /Retry the last failed network operation/);
  assert.equal(latestDiagnostic(context, "type1_retry_retry_last_turn_unavailable").reason, "network_or_timeout:retryLastTurn_missing");
});

test("Type1 falls back to sendUserMessage when retryLastTurn throws", async (t) => {
  const harness = await createHarness(t, { retryLastTurnMode: "throw" });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic socket timeout");
  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /Retry the last failed network operation/);
  assert.match(latestDiagnostic(context, "type1_retry_retry_last_turn_failed").detail, /synthetic retryLastTurn failure/);
});

test("Type1 exhaustion intentionally reuses one harness until escalation dispatches Type2 auto resume", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await pausedStop(harness, context, "error", `synthetic network timeout ${attempt}`);

    const pending = harness.timers.pendingTimers();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].delayMs, Math.min(2000 * 2 ** (attempt - 1), 30000));
    assert.equal(latestDiagnostic(context, "type1_retry_scheduled").attempt, attempt);

    await harness.timers.flushNextTimer();

    assert.equal(latestDiagnostic(context, "type1_retry_fired").attempt, attempt);
  }

  await pausedStop(harness, context, "error", "synthetic network timeout exhaustion");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.deepEqual(
    diagnosticsFor(context, "type1_escalate_to_type2_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
      escalation: payload.escalation,
    })),
    [{ retryType: "type2", attempt: 1, reason: "type1_exhausted", delayMs: 2000, escalation: "type1_to_type2" }],
  );

  await harness.timers.flushNextTimer();

  assert.equal(latestDiagnostic(context, "type1_escalate_to_type2_fired").escalation, "type1_to_type2");
  assert.equal(harness.retryLastTurnCalls.length, 10);
  assert.equal(harness.sendUserMessageCalls.at(-1).content, "/gsd auto");
});

test("fresh harness imports start Type1 retry counters at attempt 1", async (t) => {
  const firstHarness = await createHarness(t);
  const firstContext = createMockContext();

  await startSession(firstHarness, firstContext);
  await pausedStop(firstHarness, firstContext, "error", "synthetic network timeout mutates retry state");

  assert.equal(latestDiagnostic(firstContext, "type1_retry_scheduled").attempt, 1);

  const secondHarness = await createHarness(t);
  const secondContext = createMockContext();

  await startSession(secondHarness, secondContext);
  await pausedStop(secondHarness, secondContext, "error", "synthetic network timeout starts fresh");

  assert.equal(latestDiagnostic(secondContext, "type1_retry_scheduled").attempt, 1);
  assert.equal(secondHarness.timers.pendingTimers().length, 1);
  assert.equal(secondHarness.timers.pendingTimers()[0].delayMs, 2000);
});

test("Type2 official provider-pause terms schedule 5000ms auto resume attempts", async (t) => {
  for (const providerText of ["provider error", "rate limited", "server error (transient)"]) {
    await t.test(providerText, async (t) => {
      const harness = await createHarness(t);
      const context = createMockContext();

      await startSession(harness, context);
      await pausedStop(harness, context, "error", `${providerText}: synthetic provider pause`);

      const pending = harness.timers.pendingTimers();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].delayMs, 5000);
      assert.match(harness.sendMessageCalls.at(-1).message.content, /Type 2 detected/);
      assert.deepEqual(
        diagnosticsFor(context, "type2_retry_scheduled").map((payload) => ({
          retryType: payload.retryType,
          attempt: payload.attempt,
          reason: payload.reason,
          delayMs: payload.delayMs,
        })),
        [{ retryType: "type2", attempt: 1, reason: "error", delayMs: 5000 }],
      );

      await harness.timers.flushNextTimer();

      assert.equal(latestDiagnostic(context, "type2_retry_fired").attempt, 1);
      assert.equal(harness.retryLastTurnCalls.length, 0);
      assert.equal(harness.sendUserMessageCalls.length, 1);
      assert.equal(harness.sendUserMessageCalls[0].content, "/gsd auto");
    });
  }
});

test("unrelated blocked text falls through to Type3 instead of Type2", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "blocked", "synthetic blocked text unrelated to provider pause");

  assert.equal(diagnosticsFor(context, "type2_retry_scheduled").length, 0);
  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.deepEqual(
    diagnosticsFor(context, "type3_fix_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
      fixingType3: payload.fixingType3,
    })),
    [{ retryType: "type3", attempt: 1, reason: "blocked", delayMs: 2000, fixingType3: true }],
  );
});

test("Type1 entering resets observable Type2 retry counters", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "provider error: rate limited by synthetic provider");
  await harness.timers.flushNextTimer();
  await pausedStop(harness, context, "error", "synthetic network timeout after provider pause");

  assert.ok(
    diagnosticsFor(context, "retry_reset").some(
      (payload) => payload.retryType === "type2" && payload.reason === "type1_enter",
    ),
  );
  assert.equal(latestDiagnostic(context, "type1_retry_scheduled").attempt, 1);
});

test("Type1 entering resets observable schema-overload counters", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "consecutive tool validation failures exceeded cap");
  await pausedStop(harness, context, "error", "synthetic network timeout after prior retry state");

  assert.ok(
    diagnosticsFor(context, "schema_overload_reset").some(
      (payload) => payload.reason === "type1_enter",
    ),
  );
  assert.equal(latestDiagnostic(context, "type1_retry_pending").detail, "timer_already_scheduled");
});

test("Type2 entering resets observable Type1 retry counters", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "synthetic network timeout before provider pause");
  await pausedStop(harness, context, "error", "provider error: rate limited by synthetic provider");

  assert.ok(
    diagnosticsFor(context, "retry_reset").some(
      (payload) => payload.retryType === "type1" && payload.reason === "type2_enter",
    ),
  );
  assert.equal(latestDiagnostic(context, "timer_cancel").retryType, "type1");
  assert.equal(latestDiagnostic(context, "type2_retry_scheduled").attempt, 1);
});

test("Type2 entering resets observable schema-overload counters", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "consecutive tool validation failures exceeded cap");
  await pausedStop(harness, context, "error", "provider error: server error (transient) after prior retry state");

  assert.ok(
    diagnosticsFor(context, "schema_overload_reset").some(
      (payload) => payload.reason === "type2_enter",
    ),
  );
  assert.equal(latestDiagnostic(context, "timer_cancel").retryType, "type1");
  assert.equal(latestDiagnostic(context, "type2_retry_scheduled").attempt, 1);
});

test("schedules a Type3 fix prompt after auto-pause blocker context and resumes after the fix turn completes", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "blocked", "synthetic blocker needs a manual fix");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.deepEqual(
    diagnosticsFor(context, "type3_fix_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      delayMs: payload.delayMs,
      fixingType3: payload.fixingType3,
    })),
    [{ retryType: "type3", attempt: 1, delayMs: 2000, fixingType3: true }],
  );

  await harness.timers.flushNextTimer();

  assert.equal(latestDiagnostic(context, "type3_fix_fired").delayMs, 2000);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /manual recovery turn outside auto-mode/);
  assert.match(harness.sendUserMessageCalls[0].content, /Please diagnose and fix this specific issue/);

  await stopWith(harness, context, "completed");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 1500);
  assert.deepEqual(
    diagnosticsFor(context, "type3_resume_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      delayMs: payload.delayMs,
      fixingType3: payload.fixingType3,
    })),
    [{ retryType: "type3", attempt: 0, delayMs: 1500, fixingType3: false }],
  );
  assert.deepEqual(
    diagnosticsFor(context, "retry_reset")
      .filter((payload) => payload.reason === "type3_fix_completed")
      .map((payload) => payload.retryType),
    ["type1", "type2", "type3"],
  );
  assert.equal(latestDiagnostic(context, "schema_overload_reset").reason, "type3_fix_completed");

  await harness.timers.flushNextTimer();

  assert.equal(latestDiagnostic(context, "type3_resume_fired").delayMs, 1500);
  assert.equal(harness.sendUserMessageCalls.length, 2);
  assert.equal(harness.sendUserMessageCalls[1].content, "/gsd auto");
});

test("completed stop without a prior Type3 fix stands down without scheduling auto resume", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "completed");

  assert.deepEqual(harness.timers.pendingTimers(), []);
  assert.equal(harness.sendUserMessageCalls.some((call) => call.content === "/gsd auto"), false);
  assert.equal(latestDiagnostic(context, "recovery_stood_down").reason, "stop:completed");
  assert.equal(diagnosticsFor(context, "type3_resume_scheduled").length, 0);
});

test("unrelated blocked text becomes Type3 only with recent auto-pause context", async (t) => {
  const passThroughHarness = await createHarness(t);
  const passThroughContext = createMockContext();

  await startSession(passThroughHarness, passThroughContext);
  await stopWith(passThroughHarness, passThroughContext, "blocked", "synthetic blocker without pause context");

  assert.deepEqual(passThroughHarness.timers.pendingTimers(), []);
  assert.equal(diagnosticsFor(passThroughContext, "type3_fix_scheduled").length, 0);
  assert.equal(latestDiagnostic(passThroughContext, "stop_passthrough_no_recent_auto_pause").reason, "blocked");

  const type3Harness = await createHarness(t);
  const type3Context = createMockContext();

  await startSession(type3Harness, type3Context);
  await pausedStop(type3Harness, type3Context, "blocked", "synthetic blocker with pause context");

  assert.equal(type3Harness.timers.pendingTimers().length, 1);
  assert.equal(type3Harness.timers.pendingTimers()[0].delayMs, 2000);
  assert.equal(latestDiagnostic(type3Context, "type3_fix_scheduled").retryType, "type3");
});

test("repeated Type2 provider stops escalate to Type3 after exhaustion", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await pausedStop(harness, context, "error", `provider error: rate limited by synthetic provider ${attempt}`);

    assert.equal(latestDiagnostic(context, "type2_retry_scheduled").attempt, attempt);
    assert.equal(harness.timers.pendingTimers()[0].delayMs, 5000);

    await harness.timers.flushNextTimer();

    assert.equal(latestDiagnostic(context, "type2_retry_fired").attempt, attempt);
    assert.equal(harness.sendUserMessageCalls.at(-1).content, "/gsd auto");
  }

  await pausedStop(harness, context, "error", "provider error: rate limited by synthetic provider exhaustion");

  const escalation = latestDiagnostic(context, "type3_fix_scheduled");
  assert.equal(escalation.retryType, "type3");
  assert.equal(escalation.attempt, 1);
  assert.equal(escalation.delayMs, 2000);
  assert.equal(escalation.escalation, "type2_to_type3");
  assert.equal(latestDiagnostic(context, "retry_reset").reason, "type2_exhausted");
});

test("Type3 entry resets retry counters from Type1 Type2 and schema-overload paths", async (t) => {
  const type1Harness = await createHarness(t);
  const type1Context = createMockContext();

  await startSession(type1Harness, type1Context);
  await pausedStop(type1Harness, type1Context, "error", "synthetic network timeout");
  await pausedStop(type1Harness, type1Context, "blocked", "synthetic blocker after Type1");

  assert.ok(
    diagnosticsFor(type1Context, "retry_reset").some(
      (payload) => payload.retryType === "type1" && payload.reason === "type3_enter:blocked",
    ),
  );

  const type2Harness = await createHarness(t);
  const type2Context = createMockContext();

  await startSession(type2Harness, type2Context);
  await pausedStop(type2Harness, type2Context, "error", "provider error: rate limited by synthetic provider");
  await pausedStop(type2Harness, type2Context, "blocked", "synthetic blocker after Type2");

  assert.ok(
    diagnosticsFor(type2Context, "retry_reset").some(
      (payload) => payload.retryType === "type2" && payload.reason === "type3_enter:blocked",
    ),
  );

  const schemaHarness = await createHarness(t);
  const schemaContext = createMockContext();

  await startSession(schemaHarness, schemaContext);
  await pausedStop(schemaHarness, schemaContext, "error", "consecutive tool validation failures exceeded cap");
  await pausedStop(schemaHarness, schemaContext, "blocked", "synthetic blocker after prior retry state");

  assert.ok(
    diagnosticsFor(schemaContext, "schema_overload_reset").some(
      (payload) => payload.reason === "type3_enter:blocked",
    ),
  );
});

test("agent_end schema-overload errors are hijacked with a transient fetch marker", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();
  const assistantMessage = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "schema overload: consecutive turns with all tool calls failing on synthetic input",
  };

  await startSession(harness, context);
  await harness.getHandler("agent_end")({ type: "agent_end", messages: [{ role: "user", content: "synthetic" }, assistantMessage] }, context.ctx);

  assert.match(assistantMessage.errorMessage, /fetch failed/);
  assert.match(assistantMessage.errorMessage, /schema-overload-transient-hijack/);
  assert.equal(latestDiagnostic(context, "agent_end_schema_overload_hijack").reason, "schema_overload");
});

test("agent_end leaves network-like and non-schema assistant errors untouched", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();
  const networkLikeSchemaMessage = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "schema overload followed by synthetic fetch failed",
  };
  const nonSchemaMessage = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "ordinary synthetic validation failure without schema cap wording",
  };
  const nonErrorSchemaMessage = {
    role: "assistant",
    stopReason: "completed",
    errorMessage: "schema overload text inside a completed assistant message",
  };

  await startSession(harness, context);
  await harness.getHandler("agent_end")({ type: "agent_end", messages: [networkLikeSchemaMessage] }, context.ctx);
  await harness.getHandler("agent_end")({ type: "agent_end", messages: [nonSchemaMessage] }, context.ctx);
  await harness.getHandler("agent_end")({ type: "agent_end", messages: [nonErrorSchemaMessage] }, context.ctx);

  assert.equal(networkLikeSchemaMessage.errorMessage, "schema overload followed by synthetic fetch failed");
  assert.equal(nonSchemaMessage.errorMessage, "ordinary synthetic validation failure without schema cap wording");
  assert.equal(nonErrorSchemaMessage.errorMessage, "schema overload text inside a completed assistant message");
  assert.equal(diagnosticsFor(context, "agent_end_schema_overload_hijack").length, 0);
});

test("schema-overload stop schedules 1500ms retryLastTurn and resumes paused auto-mode", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "consecutive tool validation failures exceeded cap for synthetic schema overload");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 1500);
  assert.deepEqual(
    diagnosticsFor(context, "schema_overload_retry_scheduled").map((payload) => ({
      retryType: payload.retryType,
      attempt: payload.attempt,
      reason: payload.reason,
      delayMs: payload.delayMs,
    })),
    [{ retryType: "type1", attempt: 1, reason: "schema_overload", delayMs: 1500 }],
  );

  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls[0].content, "/gsd auto");
  assert.equal(latestDiagnostic(context, "schema_overload_retry_fired").attempt, 1);
  assert.equal(latestDiagnostic(context, "schema_overload_retry_retry_last_turn_called").reason, "schema_overload");
});

test("schema-overload retry failure still resumes paused auto-mode", async (t) => {
  const harness = await createHarness(t, { retryLastTurnMode: "throw" });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "consecutive tool validation failures exceeded cap for synthetic schema overload");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 1500);

  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.equal(harness.sendUserMessageCalls[0].content, "/gsd auto");
  assert.match(latestDiagnostic(context, "schema_overload_retry_retry_last_turn_failed").detail, /synthetic retryLastTurn failure/);
  assert.equal(
    diagnosticsFor(context, "schema_overload_resume_auto_send_user_message_failed").length,
    0,
    "normal resume dispatch should not emit failure diagnostics",
  );
});

test("schema-overload retry falls back to an in-session continuation when retryLastTurn is unavailable", async (t) => {
  const harness = await createHarness(t, { retryLastTurnMode: "missing" });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "blocked", "synthetic blocker activates Type3 before schema retry");
  await stopWith(harness, context, "error", "schema overload: consecutive turns with all tool calls failing on synthetic input");

  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 1500);

  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.notEqual(harness.sendUserMessageCalls[0].content, "/gsd auto");
  assert.match(harness.sendUserMessageCalls[0].content, /previous turn hit schema-overload/);
  assert.equal(latestDiagnostic(context, "schema_overload_retry_retry_last_turn_unavailable").reason, "schema_overload:retryLastTurn_missing");
});

test("schema-overload retry cap is honored from environment at import time", async (t) => {
  const harness = await createHarness(t, { schemaOverloadMaxRetries: 1 });
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "error", "schema overload synthetic cap first attempt");
  await harness.timers.flushNextTimer();
  await pausedStop(harness, context, "error", "schema overload synthetic cap second attempt");

  assert.equal(diagnosticsFor(context, "schema_overload_retry_scheduled").length, 1);
  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.ok(
    harness.sendMessageCalls.some((call) =>
      String(call.message.content).includes("Schema-overload retry exhausted (1/1)"),
    ),
  );
  assert.equal(latestDiagnostic(context, "recovery_stood_down").reason, "schema_overload_exhausted");
});

test("tool-error guard aborts after two consecutive all-error tool turns and continues without retryLastTurn", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 0, "first all-error tool turn must not abort");
  assert.equal(latestDiagnostic(context, "tool_error_guard_count").attempt, 1);

  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }, { isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 1);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /2 consecutive error-only tool turns/);
  assert.equal(latestDiagnostic(context, "tool_error_guard_abort_requested").detail, "ctx.abort");

  await stopWith(harness, context, "cancelled");

  assert.equal(latestDiagnostic(context, "tool_error_guard_abort_observed").reason, "tool_error_guard");
  assert.equal(harness.timers.pendingTimers().length, 1);
  assert.equal(harness.timers.pendingTimers()[0].delayMs, 300);
  assert.equal(harness.retryLastTurnCalls.length, 0);

  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /aborted by tool-error guard/);
  assert.equal(latestDiagnostic(context, "tool_error_guard_internal_continue_fired").reason, "tool_error_guard");
});

test("tool-error guard ctx.abort failure emits a diagnostic and disarms cancelled recovery", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext({ abortMode: "throw" });

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 1);
  assert.match(latestDiagnostic(context, "tool_error_guard_abort_failed").detail, /synthetic ctx\.abort failure/);

  await stopWith(harness, context, "cancelled");

  assert.equal(diagnosticsFor(context, "tool_error_guard_abort_observed").length, 0);
  assert.equal(diagnosticsFor(context, "tool_error_guard_internal_continue_scheduled").length, 0);
  assert.equal(harness.timers.pendingTimers().length, 0);
});

test("mixed success and error tool results reset the tool-error guard streak", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  await harness.getHandler("turn_end")(
    { type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }, { isError: false }] },
    context.ctx,
  );
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 3, toolResults: [{ isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 0);
  assert.equal(diagnosticsFor(context, "tool_error_guard_abort_requested").length, 0);
  assert.deepEqual(
    diagnosticsFor(context, "tool_error_guard_count").map((payload) => payload.attempt),
    [1, 1],
  );
});

test("empty and malformed tool results do not count or reset the tool-error guard streak", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [] }, context.ctx);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 3 }, context.ctx);
  await harness.getHandler("turn_end")(
    { type: "turn_end", turnIndex: 4, toolResults: [{ isError: true }, { malformed: true }] },
    context.ctx,
  );
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 5, toolResults: [{ isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 1);
  assert.deepEqual(
    diagnosticsFor(context, "tool_error_guard_count").map((payload) => payload.attempt),
    [1, 2],
  );
  assert.equal(latestDiagnostic(context, "tool_error_guard_abort_requested").attempt, 2);
});

test("tool-error guard ignores turn_end while Type3 recovery is in progress", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await pausedStop(harness, context, "blocked", "synthetic blocker activates Type3 before tool errors");
  assert.equal(latestDiagnostic(context, "type3_fix_scheduled").fixingType3, true);

  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }] }, context.ctx);

  assert.equal(context.abortCalls.length, 0);
  assert.equal(diagnosticsFor(context, "tool_error_guard_count").length, 0);
  assert.equal(diagnosticsFor(context, "tool_error_guard_abort_requested").length, 0);
});

test("AutoContinue diagnostic payloads keep stable required and optional keys", async (t) => {
  const fallbackHarness = await createHarness(t, {
    sendUserMessageMode: "throw",
    triggerTurnSendMessageMode: "throw",
  });
  const fallbackContext = createMockContext();

  await startSession(fallbackHarness, fallbackContext);
  await fallbackHarness.getHandler("notification")(
    { type: "notification", kind: "error", message: "tool invocation failed: validation failed for tool synthetic_tool" },
    fallbackContext.ctx,
  );
  await stopWith(fallbackHarness, fallbackContext, "error", "validation failed for tool synthetic_tool");
  await fallbackHarness.timers.flushNextTimer();

  assertDiagnosticPayloadKeys(
    fallbackContext,
    new Map([
      ["type0_continue_scheduled", ["detail", "delayMs"]],
      ["type0_continue_fired", ["detail", "delayMs"]],
      ["type0_continue_send_user_message_failed", ["detail"]],
      ["type0_continue_trigger_turn_failed", ["detail"]],
    ]),
  );

  const escalationHarness = await createHarness(t);
  const escalationContext = createMockContext();

  await startSession(escalationHarness, escalationContext);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await pausedStop(escalationHarness, escalationContext, "error", `provider error: rate limited by synthetic provider ${attempt}`);
    await escalationHarness.timers.flushNextTimer();
  }
  await pausedStop(escalationHarness, escalationContext, "error", "provider error: rate limited by synthetic provider exhaustion");

  assert.equal(latestDiagnostic(escalationContext, "type3_fix_scheduled").escalation, "type2_to_type3");
  assertDiagnosticPayloadKeys(
    escalationContext,
    new Map([["type3_fix_scheduled", ["detail", "delayMs", "escalation"]]]),
  );
});

test("behavior-test contract contains no implementation source-read regression patterns", () => {
  const forbiddenPattern = [
    ["read", "FileSync"].join(""),
    ["read", "File\\("].join(""),
    ["source", "includes"].join("\\."),
    ["assert", "match\\(source"].join("\\."),
  ].join("|");

  try {
    const output = execFileSync("rg", [forbiddenPattern, new URL(import.meta.url).pathname], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail(`forbidden implementation-inspection pattern found in behavior test file:\n${output}`);
  } catch (error) {
    assert.equal(error.status, 1, `pattern scan should find no matches; stderr=${error.stderr || ""}`);
  }
});
