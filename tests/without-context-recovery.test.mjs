import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, createContext, stop } from "./harness.mjs";

const { setGsdAutoSnapshotReaderForTests, setContextOverflowDetectorForTests } = await import(new URL("../gsd-auto-state.ts", import.meta.url).href);

function withGsdSnapshot(t, snapshot) {
  setGsdAutoSnapshotReaderForTests(async () => snapshot);
  t.after(() => setGsdAutoSnapshotReaderForTests(undefined));
}

function withContextOverflow(t, value = true) {
  setContextOverflowDetectorForTests(() => value);
  t.after(() => setContextOverflowDetectorForTests(undefined));
}

const gsdValidationFailure = {
  isError: true,
  result: { content: [{ type: "text", text: 'Validation failed for tool "gsd_plan_slice": missing tasks' }] },
};

test("GSD paused auto state uses without-context recovery and then resumes auto-mode", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "error", "verification failed", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Without-context recovery loop: 1\/unlimited/);
  assert.match(harness.userMessages.at(-1), /verification failed/);

  await stop(harness, "completed", "", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd auto");
});

test("GSD paused step mode resumes with /gsd next", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: true, basePath: "/repo" });
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "blocked", "pre-execution gate failed", context.ctx);
  await harness.timers.flushNext();
  await stop(harness, "completed", "", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd next");
});

test("GSD stopped with structured session-failed context uses without-context recovery", async (t) => {
  withGsdSnapshot(t, {
    active: false,
    paused: false,
    stepMode: false,
    basePath: "/repo",
    errorContext: { category: "session-failed", message: "Session creation failed: unknown", isTransient: true },
  });
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "cancelled", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /session-failed: Session creation failed: unknown/);
});

test("GSD session-failed recovery outranks programmatic abort fallback", async (t) => {
  withGsdSnapshot(t, {
    active: false,
    paused: false,
    stepMode: false,
    basePath: "/repo",
    errorContext: { category: "session-failed", message: "Session creation failed: unknown", isTransient: true },
  });
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...gsdValidationFailure }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...gsdValidationFailure }, context.ctx);
  await stop(harness, "cancelled", "Operation aborted", context.ctx);

  assert.equal(context.aborts.length, 0);
  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /session-failed: Session creation failed: unknown/);
  assert.doesNotMatch(harness.userMessages.at(-1), /tool_schema_guard/);
});

test("cancelled GSD pause with structured error context recovers", async (t) => {
  withGsdSnapshot(t, {
    active: false,
    paused: true,
    stepMode: false,
    basePath: "/repo",
    errorContext: { category: "provider", message: "no status code or body" },
  });
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "cancelled", "Operation aborted", context.ctx);
  await harness.timers.flushNext();

  assert.match(harness.userMessages.at(-1), /provider: no status code or body/);
});

test("cancelled GSD pause without structured error context is treated as manual interruption", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "cancelled", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
});

test("first context overflow stop stands down for Pi core recovery", async (t) => {
  withContextOverflow(t);
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "error", "Your input exceeds the context window of this model.", context.ctx);

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
  assert.match(context.notifications.at(-1).content, /Pi core runs its overflow compaction recovery/);
});

test("repeated context overflow stop falls back to without-context recovery", async (t) => {
  withContextOverflow(t);
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "error", "Your input exceeds the context window of this model.", context.ctx);
  await stop(harness, "error", "Your input exceeds the context window of this model.", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);
});

test("busy recovery dispatch waits visibly without hidden trigger turns", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);
  const context = createContext();
  context.ctx.isIdle = () => false;

  await stop(harness, "error", "UAT failure", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(context.notifications.at(-1).content, /Agent is already processing/);
});

test("sendUserMessage failures are reported visibly without hidden trigger turns", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t, { throwSendUserMessage: true });
  const context = createContext();

  await stop(harness, "error", "UAT failure", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(context.notifications.at(-1).content, /No hidden recovery turn was dispatched/);
});
