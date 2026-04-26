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

test("GSD paused auto state uses without-context recovery and then resumes auto-mode", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);

  await stop(harness, "error", "verification failed");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Without-context recovery loop: 1\/unlimited/);
  assert.match(harness.userMessages.at(-1), /verification failed/);

  await stop(harness, "completed");
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd auto");
});

test("GSD paused step mode resumes with /gsd next", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: true, basePath: "/repo" });
  const harness = await createHarness(t);

  await stop(harness, "blocked", "pre-execution gate failed");
  await harness.timers.flushNext();
  await stop(harness, "completed");
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

  await stop(harness, "cancelled", "Operation aborted");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /session-failed: Session creation failed: unknown/);
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

  await stop(harness, "cancelled", "Operation aborted");
  await harness.timers.flushNext();

  assert.match(harness.userMessages.at(-1), /provider: no status code or body/);
});

test("cancelled GSD pause without structured error context is treated as manual interruption", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);

  await stop(harness, "cancelled", "Operation aborted");

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
});

test("first context overflow stop stands down for Pi core recovery", async (t) => {
  withContextOverflow(t);
  const harness = await createHarness(t);

  await stop(harness, "error", "Your input exceeds the context window of this model.");

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
  assert.match(harness.systemMessages.at(-1).message.content, /Pi core runs its overflow compaction recovery/);
});

test("repeated context overflow stop falls back to without-context recovery", async (t) => {
  withContextOverflow(t);
  const harness = await createHarness(t);

  await stop(harness, "error", "Your input exceeds the context window of this model.");
  await stop(harness, "error", "Your input exceeds the context window of this model.");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);
});

test("busy recovery dispatch waits visibly without hidden trigger turns", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t);
  const { ctx } = createContext();
  ctx.isIdle = () => false;

  await stop(harness, "error", "UAT failure", ctx);
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(harness.systemMessages.at(-1).message.content, /Agent is already processing/);
});

test("sendUserMessage failures are reported visibly without hidden trigger turns", async (t) => {
  withGsdSnapshot(t, { active: false, paused: true, stepMode: false, basePath: "/repo" });
  const harness = await createHarness(t, { throwSendUserMessage: true });

  await stop(harness, "error", "UAT failure");
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.triggerTurns.length, 0);
  assert.match(harness.systemMessages.at(-1).message.content, /No hidden recovery turn was dispatched/);
});
