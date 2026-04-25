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

async function importExtension() {
  const importPath = new URL(`./index.ts?two-tier-harness=${Date.now()}-${importCounter++}`, import.meta.url).href;
  const module = await import(importPath);
  assert.equal(typeof module.default, "function", "default export must be the Pi extension factory");
  return module.default;
}

function createFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  let nextId = 1;

  globalThis.setTimeout = (callback, delayMs = 0, ...args) => {
    const timer = { id: nextId++, delayMs, callback, args, cancelled: false, fired: false };
    timers.push(timer);
    return timer;
  };

  globalThis.clearTimeout = (handle) => {
    const timer = timers.find((candidate) => candidate === handle || candidate.id === handle);
    if (timer) timer.cancelled = true;
  };

  async function flushNextTimer() {
    const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
    assert.ok(timer, "expected a pending timer");
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
  return JSON.parse(message.slice(prefix.length));
}

function createMockPi({ sendUserMessageMode = "record", triggerTurnSendMessageMode = "record" } = {}) {
  const handlers = new Map();
  const sendMessageCalls = [];
  const sendUserMessageCalls = [];
  const retryLastTurnCalls = [];

  const pi = {
    on(eventName, handler) {
      assert.equal(typeof eventName, "string");
      assert.equal(typeof handler, "function");
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
    retryLastTurn(...args) {
      retryLastTurnCalls.push(args);
    },
  };

  function getHandler(eventName) {
    const handler = handlers.get(eventName);
    assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
    return handler;
  }

  return { pi, handlers, getHandler, sendMessageCalls, sendUserMessageCalls, retryLastTurnCalls };
}

function createMockContext({ withUi = true, abortMode = "record" } = {}) {
  const rawNotifications = [];
  const diagnostics = [];
  const abortCalls = [];

  const ctx = {
    abort() {
      abortCalls.push({});
      if (abortMode === "throw") throw new Error("synthetic ctx.abort failure");
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

async function createHarness(t, options) {
  const timers = createFakeTimers();
  t.after(() => timers.cleanup());
  const mockPi = createMockPi(options);
  const registerExtension = await importExtension();
  await registerExtension(mockPi.pi);
  return { ...mockPi, timers };
}

async function startSession(harness, context) {
  await harness.getHandler("session_start")({ type: "session_start" }, context.ctx);
}

async function emitNotification(harness, context, message, kind = "error") {
  await harness.getHandler("notification")({ type: "notification", kind, message }, context.ctx);
}

async function stopWith(harness, context, reason, errorMessage = "") {
  await harness.getHandler("stop")(
    { type: "stop", reason, lastMessage: errorMessage ? { errorMessage } : undefined },
    context.ctx,
  );
}

function latestDiagnostic(context, phase) {
  const matches = context.diagnostics.filter((payload) => payload.phase === phase);
  assert.ok(matches.length > 0, `expected diagnostic phase ${phase}`);
  return matches[matches.length - 1];
}

function diagnosticsFor(context, phase) {
  return context.diagnostics.filter((payload) => payload.phase === phase);
}

function findTriggerTurnMessage(harness) {
  return harness.sendMessageCalls.find((call) => call.options?.triggerTurn === true);
}

async function exhaustManualType1(harness, context, startAttempt, detailPrefix) {
  for (let attempt = startAttempt; attempt <= 10; attempt += 1) {
    await stopWith(harness, context, "error", `${detailPrefix} attempt ${attempt}`);
    assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").attempt, attempt);
    await harness.timers.flushNextTimer();
  }

  await stopWith(harness, context, "error", `${detailPrefix} after Type 1 budget`);
}

function assertNoAutoModeResume(harness, context) {
  assert.equal(diagnosticsFor(context, "type2_discard_context_scheduled").length, 0);
  assert.equal(diagnosticsFor(context, "type2_resume_auto_scheduled").length, 0);
  assert.equal(harness.sendUserMessageCalls.some((call) => call.content === "/gsd auto"), false);
}

test("registers lifecycle hooks through a quiet factory", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual([...harness.handlers.keys()].sort(), [...REQUIRED_LIFECYCLE_HOOKS].sort());
  assert.deepEqual(harness.sendMessageCalls, []);
  assert.deepEqual(harness.sendUserMessageCalls, []);
  assert.deepEqual(harness.retryLastTurnCalls, []);
  assert.deepEqual(harness.timers.pendingTimers(), []);
});

test("session_start announces the two-tier runtime and binds structured diagnostics", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);

  assert.equal(harness.sendMessageCalls.length, 1);
  assert.match(harness.sendMessageCalls[0].message.content, /Two-tier recovery enabled/);
  assert.deepEqual(latestDiagnostic(context, "hook_session_start"), {
    plugin: "gsd-auto-continue",
    phase: "hook_session_start",
    retryType: "none",
    attempt: 0,
    reason: "session_start",
    fixingType2: false,
  });
});

test("Type 1 preserve-context recovery handles transient errors without auto-pause or /gsd auto", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "error", "ECONNRESET while fetching model stream");

  const pending = harness.timers.pendingTimers();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delayMs, Math.round(1000 * 60 ** (1 / 10)));
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Type 1 preserve-context retry/);
  assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").reason, "failure");

  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 0, "Type 1 must not use same-turn retryLastTurn");
  assert.equal(harness.sendUserMessageCalls.length, 1);
  assert.match(harness.sendUserMessageCalls[0].content, /Continue from the current context/);
  assert.match(harness.sendUserMessageCalls[0].content, /Do not restart \/gsd auto/);
  assert.notEqual(harness.sendUserMessageCalls[0].content.trim(), "/gsd auto");
  assert.equal(latestDiagnostic(context, "type1_preserve_context_fired").delayMs, pending[0].delayMs);
});

test("schema-overload is treated as Type 1 and stays in-place", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await emitNotification(harness, context, "Schema overload: consecutive tool validation failures exceeded cap");
  await stopWith(harness, context, "error", "consecutive turns with all tool calls failing");

  assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").reason, "failure");
  await harness.timers.flushNextTimer();

  assert.equal(harness.retryLastTurnCalls.length, 0);
  assert.match(harness.sendUserMessageCalls[0].content, /consecutive tool validation failures exceeded cap/);
  assert.notEqual(harness.sendUserMessageCalls[0].content.trim(), "/gsd auto");
});

test("official auto-mode exit goes directly to Type 2 because hot context is already gone", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await emitNotification(harness, context, "auto-mode paused after failed post-execution check");
  await stopWith(harness, context, "blocked", "post-execution check failed");

  assert.equal(diagnosticsFor(context, "type1_preserve_context_scheduled").length, 0);
  assert.equal(latestDiagnostic(context, "official_auto_mode_exit_observed").detail, "current_stop_diagnostic_only");
  assert.equal(latestDiagnostic(context, "official_auto_mode_exit_consumed").retryType, "type2");
  assert.equal(latestDiagnostic(context, "type2_discard_context_scheduled").reason, "official_auto_mode_exit");
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Loop 1\/unlimited/);
});

test("tool-error guard cancellation still uses Type 1 even if an official pause banner is observed", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }] }, context.ctx);
  await emitNotification(harness, context, "auto-mode paused after tool validation failures");
  await stopWith(harness, context, "cancelled");

  assert.equal(context.abortCalls.length, 1);
  assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").reason, "tool_error_guard");
  assert.equal(diagnosticsFor(context, "type2_discard_context_scheduled").length, 0);
});

test("manual-mode Type 1 exhaustion gives up without Type 2 or /gsd auto", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await exhaustManualType1(harness, context, 1, "fetch failed transient");

  assert.equal(latestDiagnostic(context, "retry_reset").reason, "type1_exhausted");
  assert.equal(latestDiagnostic(context, "type1_exhausted_stand_down").retryType, "type1");
  assertNoAutoModeResume(harness, context);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /manual intervention required/);
});

test("manual-mode network, tool, and database failures never enter Type 2 or /gsd auto", async (t) => {
  await t.test("network", async (t) => {
    const harness = await createHarness(t);
    const context = createMockContext();

    await startSession(harness, context);
    await exhaustManualType1(harness, context, 1, "network fetch failed");

    assert.equal(latestDiagnostic(context, "type1_exhausted_stand_down").reason, "failure");
    assertNoAutoModeResume(harness, context);
  });

  await t.test("database", async (t) => {
    const harness = await createHarness(t);
    const context = createMockContext();

    await startSession(harness, context);
    await exhaustManualType1(harness, context, 1, "database corruption detected");

    assert.equal(latestDiagnostic(context, "type1_exhausted_stand_down").reason, "failure");
    assertNoAutoModeResume(harness, context);
  });

  await t.test("tool", async (t) => {
    const harness = await createHarness(t);
    const context = createMockContext();

    await startSession(harness, context);
    await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
    await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }] }, context.ctx);
    await stopWith(harness, context, "cancelled");
    assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").reason, "tool_error_guard");
    await harness.timers.flushNextTimer();

    await exhaustManualType1(harness, context, 2, "tool validation failed");

    assert.equal(latestDiagnostic(context, "type1_exhausted_stand_down").reason, "failure");
    assertNoAutoModeResume(harness, context);
  });
});

test("tool-call error guard aborts on the second all-error turn and retries next turn as Type 1", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 1, toolResults: [{ isError: true }] }, context.ctx);
  assert.equal(context.abortCalls.length, 0);

  await harness.getHandler("turn_end")({ type: "turn_end", turnIndex: 2, toolResults: [{ isError: true }] }, context.ctx);
  assert.equal(context.abortCalls.length, 1);
  assert.equal(latestDiagnostic(context, "tool_error_guard_abort_requested").detail, "ctx.abort");

  await stopWith(harness, context, "cancelled");

  assert.equal(latestDiagnostic(context, "tool_error_guard_abort_observed").reason, "tool_error_guard");
  assert.equal(latestDiagnostic(context, "type1_preserve_context_scheduled").reason, "tool_error_guard");
  await harness.timers.flushNextTimer();

  assert.match(harness.sendUserMessageCalls[0].content, /Two consecutive tool-call turns/);
});

test("official auto-mode exits use Type 2 and resume auto-mode for each current paused failure", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await emitNotification(harness, context, "auto-mode paused after git conflict in generated summary file");
  await stopWith(harness, context, "blocked", "git conflict in generated summary file");

  assert.equal(latestDiagnostic(context, "type2_discard_context_scheduled").attempt, 1);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Loop 1\/unlimited/);
  await harness.timers.flushNextTimer();

  assert.match(harness.sendUserMessageCalls.at(-1).content, /Recovery Loop: 1\/unlimited/);
  assert.match(harness.sendUserMessageCalls.at(-1).content, /official engine already exited auto-mode/);

  await stopWith(harness, context, "completed");
  assert.equal(latestDiagnostic(context, "type2_resume_auto_scheduled").attempt, 1);
  await harness.timers.flushNextTimer();
  assert.equal(harness.sendUserMessageCalls.at(-1).content, "/gsd auto");

  await emitNotification(harness, context, "auto-mode paused after verification gate failure");
  await stopWith(harness, context, "blocked", "verification gate failure after resume");
  assert.equal(latestDiagnostic(context, "type2_discard_context_scheduled").attempt, 2);
  assert.match(harness.sendMessageCalls.at(-1).message.content, /Loop 2\/unlimited/);
});

test("manual intervention cancels pending recovery and emits a stand-down message only while active", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "error", "fetch failed before operator interrupts");
  assert.equal(harness.timers.pendingTimers().length, 1);

  await emitNotification(harness, context, "manual intervention requested by operator", "input_needed");
  await stopWith(harness, context, "error", "manual intervention requested by operator");

  assert.equal(harness.timers.pendingTimers().length, 0);
  assert.equal(harness.timers.timers[0].cancelled, true);
  assert.equal(latestDiagnostic(context, "stop_stand_down_manual_intervention").reason, "error");
  assert.ok(
    harness.sendMessageCalls.some((call) => String(call.message.content).includes("Manual intervention detected")),
    "active recovery should notify that it stood down",
  );
});

test("sendUserMessage failures use the hidden trigger-turn fallback", async (t) => {
  const harness = await createHarness(t, { sendUserMessageMode: "throw" });
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "blocked", "UAT block uses Type 1 before any Type 2 root-cause loop");
  await harness.timers.flushNextTimer();

  assert.equal(harness.sendUserMessageCalls.length, 1);
  const triggerTurnCall = findTriggerTurnMessage(harness);
  assert.ok(triggerTurnCall, "failed direct dispatch should use hidden trigger-turn fallback");
  assert.equal(triggerTurnCall.message.customType, "auto-continue-recovery");
  assert.equal(triggerTurnCall.message.display, false);
  assert.deepEqual(triggerTurnCall.options, { triggerTurn: true });
  assert.match(latestDiagnostic(context, "type1_preserve_context_send_user_message_failed").detail, /synthetic sendUserMessage failure/);
  assert.equal(latestDiagnostic(context, "type1_preserve_context_trigger_turn_called").detail, "fallback_sendMessage_triggerTurn");
});

test("diagnostic payloads expose stable two-tier fields", async (t) => {
  const harness = await createHarness(t);
  const context = createMockContext();

  await startSession(harness, context);
  await stopWith(harness, context, "error", "503 API overload");

  for (const payload of context.diagnostics) {
    assert.equal(payload.plugin, "gsd-auto-continue");
    assert.equal(typeof payload.phase, "string");
    assert.equal(typeof payload.retryType, "string");
    assert.equal(typeof payload.attempt, "number");
    assert.equal(typeof payload.reason, "string");
    assert.equal(typeof payload.fixingType2, "boolean");
    assert.ok(!Object.hasOwn(payload, "fixingType3"), "legacy Type 3 diagnostic key must not exist");
  }
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
