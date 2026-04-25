import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";

const REGISTERED_HOOKS = [
  "agent_end",
  "input",
  "notification",
  "session_end",
  "session_shutdown",
  "session_start",
  "stop",
  "tool_call",
  "turn_end",
];

test("registers only the hooks the extension actually uses", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual([...harness.handlers.keys()].sort(), REGISTERED_HOOKS.sort());
  assert.deepEqual(harness.systemMessages, []);
  assert.deepEqual(harness.userMessages, []);
  assert.deepEqual(harness.timers.pending(), []);
});
