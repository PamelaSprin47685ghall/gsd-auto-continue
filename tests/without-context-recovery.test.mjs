import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, createContext, notify, stop } from "./harness.mjs";

const { setContextOverflowDetectorForTests } = await import(new URL("../gsd-auto-state.ts", import.meta.url).href);

async function markAutoActive(harness, overrides = {}) {
  await harness.handler("unit_start")({
    type: "unit_start",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    milestoneId: "M001",
    cwd: "/repo",
    ...overrides,
  });
}

async function markAutoUnitEnded(harness, status = "failed", overrides = {}) {
  await harness.handler("unit_end")({
    type: "unit_end",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    milestoneId: "M001",
    status,
    cwd: "/repo",
    ...overrides,
  });
}

function withContextOverflow(t, value = true) {
  setContextOverflowDetectorForTests(() => value);
  t.after(() => setContextOverflowDetectorForTests(undefined));
}

const gsdValidationFailure = {
  isError: true,
  result: { content: [{ type: "text", text: 'Validation failed for tool "gsd_plan_slice": missing tasks' }] },
};

test("non-auto cancelled stops never consult GSD runtime detectors", async (t) => {
  setContextOverflowDetectorForTests(() => {
    throw new Error("GSD runtime detectors must not be consulted by non-auto Esc");
  });
  t.after(() => setContextOverflowDetectorForTests(undefined));
  const harness = await createHarness(t);
  const context = createContext();

  await stop(harness, "cancelled", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
  assert.equal(context.notifications.length, 0);
});

test("local GSD auto unit failure uses without-context recovery and then resumes auto-mode", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await markAutoActive(harness);
  await notify(harness, "verification failed", "error");
  await markAutoUnitEnded(harness, "failed", { unitType: "plan-slice", unitId: "M001/S02" });
  await stop(harness, "error", "verification failed", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Without-context recovery loop: 1\/unlimited/);
  assert.match(harness.userMessages.at(-1), /session-failed: verification failed/);

  await stop(harness, "completed", "", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd auto");
});

test("local GSD auto step-mode unit resumes with /gsd next", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await markAutoActive(harness, { unitType: "step" });
  await markAutoUnitEnded(harness, "blocked", { unitType: "step", unitId: "M001/S01/T01" });
  await stop(harness, "blocked", "pre-execution gate failed", context.ctx);
  await harness.timers.flushNext();
  await stop(harness, "completed", "", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd next");
});

test("local failed unit recovery outranks programmatic abort fallback", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await markAutoActive(harness);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...gsdValidationFailure }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...gsdValidationFailure }, context.ctx);
  await markAutoUnitEnded(harness, "failed", { unitType: "plan-slice", unitId: "M001/S02" });
  await stop(harness, "error", "Session creation failed: unknown", context.ctx);

  assert.equal(context.aborts.length, 1);
  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /session-failed: Session creation failed: unknown/);
  assert.doesNotMatch(harness.userMessages.at(-1), /tool_schema_guard/);
});

test("local blocked unit context uses without-context recovery", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await markAutoActive(harness);
  await notify(harness, "Task T04 references missing perf-metrics.json", "blocked");
  await markAutoUnitEnded(harness, "blocked", { unitType: "plan-slice", unitId: "M001/S02" });
  await stop(harness, "blocked", "", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  assert.match(context.notifications.at(-1).content, /without-context recovery loop 1/);
  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /pre-execution: Task T04 references missing perf-metrics\.json/);
});

test("cancelled GSD unit without local recoverable failure is treated as manual interruption", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await markAutoActive(harness);
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
  const harness = await createHarness(t);
  const context = createContext();
  context.ctx.isIdle = () => false;

  await markAutoActive(harness);
  await markAutoUnitEnded(harness, "failed", { unitType: "plan-slice", unitId: "M001/S02" });
  await stop(harness, "error", "UAT failure", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(context.notifications.at(-1).content, /Agent is already processing/);
});

test("sendUserMessage failures are reported visibly without hidden trigger turns", async (t) => {
  const harness = await createHarness(t, { throwSendUserMessage: true });
  const context = createContext();

  await markAutoActive(harness);
  await markAutoUnitEnded(harness, "failed", { unitType: "plan-slice", unitId: "M001/S02" });
  await stop(harness, "error", "UAT failure", context.ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(context.notifications.at(-1).content, /No hidden recovery turn was dispatched/);
});
