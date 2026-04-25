import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, notify, stop } from "./harness.mjs";

test("official auto-mode pauses use without-context recovery and then resume auto-mode", async (t) => {
  const harness = await createHarness(t);

  await notify(harness, "auto-mode paused after verification failed");
  await stop(harness, "blocked", "verification failed");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Without-context recovery loop: 1\/unlimited/);
  assert.match(harness.userMessages.at(-1), /verification failed/);

  await stop(harness, "completed");
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.at(-1), "/gsd auto");
});

test("sendUserMessage failures fall back to a hidden trigger turn", async (t) => {
  const harness = await createHarness(t, { throwSendUserMessage: true });

  await stop(harness, "error", "UAT failure");
  await harness.timers.flushNext();

  assert.equal(harness.userMessages.length, 1);
  assert.equal(harness.triggerTurns.length, 1);
  assert.equal(harness.triggerTurns[0].message.customType, "auto-continue-recovery");
  assert.deepEqual(harness.triggerTurns[0].options, { triggerTurn: true });
});
