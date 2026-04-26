import test from "node:test";
import assert from "node:assert/strict";
import { createContext, createHarness, notify, stop } from "./harness.mjs";

const { matchesManualIntervention } = await import(new URL("../continuation-policy.ts", import.meta.url).href);

const validationError = (text = "Validation failed for tool \"write\": missing required property") => ({
  isError: true,
  content: [{ type: "text", text }],
});

const executionError = (text = "Command exited with code 1") => ({
  isError: true,
  content: [{ type: "text", text }],
});

const success = () => ({
  isError: false,
  content: [{ type: "text", text: "ok" }],
});

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

test("schema-preparation tool results abort before the provider can make a third call", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /schema failures are repeating/);

  await stop(harness, "error", "Operation aborted");
  await harness.timers.flushNext();

  assert.match(harness.userMessages.at(-1), /Two consecutive tool calls failed before execution/);
  assert.notEqual(harness.userMessages.at(-1).trim(), "/gsd auto");
  assert.doesNotMatch(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
});

test("schema-preparation guard recognizes validation errors after tool-name prefixes", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const prefixedValidationError = validationError('gsd_plan_slice\nValidation failed for tool "gsd_plan_slice":\n  - tasks: must be array');

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...prefixedValidationError }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...prefixedValidationError }, context.ctx);

  assert.equal(context.aborts.length, 1);
  assert.match(harness.systemMessages.at(-1).message.content, /schema failures are repeating/);
});

test("ordinary tool execution errors do not count toward the schema guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_result")({ type: "tool_result", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "bash", ...executionError() }, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("successful and execution-error tool results reset the schema guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_result")({ type: "tool_result", toolName: "read", ...success() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);
});

test("mixed preparation and successful tool results preserve but do not increment the schema guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "read", ...success() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);
});

test("successful tool results reset the schema guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "read", ...success() }, context.ctx);
  await harness.handler("tool_result")({ type: "tool_result", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("identical tool calls abort on the fourth call before GSD blocks the fifth", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const event = { type: "tool_call", toolName: "read", input: { path: "README.md" } };

  assert.equal(await harness.handler("tool_call")(event, context.ctx), undefined);
  assert.equal(await harness.handler("tool_call")(event, context.ctx), undefined);
  assert.equal(await harness.handler("tool_call")(event, context.ctx), undefined);

  const result = await harness.handler("tool_call")(event, context.ctx);
  assert.equal(context.aborts.length, 1);
  assert.equal(result.block, true);
  assert.match(result.reason, /called 4 consecutive times/);

  await stop(harness, "error", "Operation aborted");
  await harness.timers.flushNext();

  assert.match(harness.userMessages.at(-1), /identical_tool_call_guard/);
  assert.match(harness.userMessages.at(-1), /called 4 consecutive times/);
  assert.doesNotMatch(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
});

test("different tool arguments reset the identical-call guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input: { path: "A.md" } }, context.ctx);
  await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input: { path: "A.md" } }, context.ctx);
  await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input: { path: "B.md" } }, context.ctx);
  await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input: { path: "A.md" } }, context.ctx);
  await harness.handler("tool_call")({ type: "tool_call", toolName: "read", input: { path: "A.md" } }, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("agent boundaries reset the identical-call guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const event = { type: "tool_call", toolName: "read", input: { path: "README.md" } };

  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("agent_end")({ type: "agent_end" });
  await harness.handler("tool_call")(event, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("strict interactive duplicate tools are left to GSD's own guard", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const event = { type: "tool_call", toolName: "ask_user_questions", input: { questions: [{ id: "gate", options: [] }] } };

  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("manual intervention rule matching uses simple and-or conditions", () => {
  assert.equal(matchesManualIntervention("Stop directive: stop after this task"), true);
  assert.equal(matchesManualIntervention("Tool skipped: Skipped due to queued user message."), true);
  assert.equal(matchesManualIntervention("Post-execution checks failed — pausing for human review"), true);
  assert.equal(matchesManualIntervention("Auto-mode paused due to provider error: unauthorized"), false);
  assert.equal(matchesManualIntervention("Please stop the timer from re-rendering"), false);
  assert.equal(matchesManualIntervention("Queued background job completed"), false);
});

test("provider errors do not count as manual intervention", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "error", "temporary model outage");
  assert.equal(harness.timers.pending().length, 1);

  await notify(harness, "Auto-mode paused due to provider error: unauthorized", "warning");
  await stop(harness, "blocked", "Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.");

  assert.equal(harness.timers.pending().length, 1);
  assert.doesNotMatch(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
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

test("manual operation abort cancels pending with-context retry when it was not self-triggered", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "error", "temporary model outage");
  assert.equal(harness.timers.pending().length, 1);

  await stop(harness, "error", "Operation aborted");

  assert.equal(harness.timers.pending().length, 0);
  assert.match(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
});

test("official stop and review notifications cancel pending with-context retry", async (t) => {
  for (const message of [
    "Stop directive: stop after this task",
    "Backtrack directive: undo the last milestone",
    "Tool skipped for task: Skipped due to queued user message.",
    "Post-execution checks failed — cross-task consistency issue detected, pausing for human review",
    "Milestone M001 has an ambiguous SUMMARY. Auto-mode paused for manual review.",
    "Provider requires human input before continuing.",
    "Recovery stopped because operator action is required.",
  ]) {
    const harness = await createHarness(t);

    await stop(harness, "error", "temporary model outage");
    assert.equal(harness.timers.pending().length, 1);

    await notify(harness, message, "warning");
    await stop(harness, "blocked", "Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.");

    assert.equal(harness.timers.pending().length, 0);
    assert.match(harness.systemMessages.at(-1).message.content, /Manual intervention detected/);
  }
});
