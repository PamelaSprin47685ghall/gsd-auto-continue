import test from "node:test";
import assert from "node:assert/strict";
import { createContext, createHarness } from "./harness.mjs";

const REGISTERED_HOOKS = [
  "agent_end",
  "input",
  "notification",
  "session_end",
  "session_shutdown",
  "session_start",
  "stop",
  "tool_call",
  "tool_execution_end",
];

test("registers only the hooks the extension actually uses", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual([...harness.handlers.keys()].sort(), REGISTERED_HOOKS.sort());
  assert.deepEqual(harness.systemMessages, []);
  assert.deepEqual(harness.userMessages, []);
  assert.deepEqual(harness.timers.pending(), []);
});

test("internal hook failures are visible and fail open", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const input = {};
  input.self = input;

  const result = await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input }, context.ctx);

  assert.equal(result, undefined);
  assert.match(harness.systemMessages.at(-1).message.content, /Internal failure in tool_call/);
});

test("status send failures do not kill tool guards", async (t) => {
  t.mock.method(console, "error", () => {});

  const harness = await createHarness(t, { throwSendMessage: true });
  const context = createContext();
  const validationError = {
    isError: true,
    result: { content: [{ type: "text", text: 'Validation failed for tool "gsd_plan_slice": missing tasks' }] },
  };

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError }, context.ctx);

  assert.equal(context.aborts.length, 1);
  assert.match(context.notifications.at(-1).content, /schema failures are repeating/);
});
