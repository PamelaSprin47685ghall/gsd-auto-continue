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

test("cancelled official auto-mode pause banners still use without-context recovery", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "cancelled", "Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);
});

test("pre-execution check failures use without-context recovery when followed by the official pause banner", async (t) => {
  const harness = await createHarness(t);

  await notify(
    harness,
    "Error: Pre-execution checks failed: 3 blocking issues found. See S01-PRE-EXEC-VERIFY.json for full details.",
  );
  await stop(harness, "cancelled", "Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.");

  assert.equal(harness.timers.pending().length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /without-context recovery loop 1/);

  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Pre-execution checks failed/);
  assert.match(harness.userMessages.at(-1), /Auto-mode paused/);
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
