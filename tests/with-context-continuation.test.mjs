import test from "node:test";
import assert from "node:assert/strict";
import { createContext, createHarness, notify, stop } from "./harness.mjs";

test("ordinary failures retry in the current context and do not restart auto-mode", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "error", "ECONNRESET while fetching model stream");

  const [timer] = harness.timers.pending();
  assert.equal(timer.delayMs, Math.round(1000 * 60 ** (1 / 10)));
  assert.match(harness.systemMessages.at(-1).message.content, /Retrying with context in/);

  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 1);
  assert.match(harness.userMessages[0], /Continue from the current context/);
  assert.match(harness.userMessages[0], /ECONNRESET/);
  assert.notEqual(harness.userMessages[0].trim(), "/gsd auto");
});

test("repeated all-error tool turns abort once and retry with context", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("turn_end")({ type: "turn_end", toolResults: [{ isError: true }] }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("turn_end")({ type: "turn_end", toolResults: [{ isError: true }] }, context.ctx);
  assert.equal(context.aborts.length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /Tool calls are failing repeatedly/);

  await stop(harness, "cancelled");
  await harness.timers.flushNext();

  assert.match(harness.userMessages.at(-1), /Two consecutive tool-call turns/);
  assert.notEqual(harness.userMessages.at(-1).trim(), "/gsd auto");
});

test("manual intervention cancels pending with-context retry", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "error", "temporary model outage");
  assert.equal(harness.timers.pending().length, 1);

  await notify(harness, "manual intervention requested by operator", "input_needed");
  await stop(harness, "error", "manual intervention requested by operator");

  assert.equal(harness.timers.pending().length, 0);
  assert.match(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
});
