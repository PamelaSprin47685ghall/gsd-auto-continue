import test from "node:test";
import assert from "node:assert/strict";
import { createContext, createHarness, notify, stop } from "./harness.mjs";

const { matchesManualIntervention } = await import(new URL("../continuation-policy.ts", import.meta.url).href);
const { setGsdAutoSnapshotReaderForTests } = await import(new URL("../gsd-auto-state.ts", import.meta.url).href);

function withAutoActive(t) {
  setGsdAutoSnapshotReaderForTests(async () => ({ active: true, paused: false, stepMode: false, basePath: "/repo" }));
  t.after(() => setGsdAutoSnapshotReaderForTests(undefined));
}

const validationError = (text = "Validation failed for tool \"write\": missing required property") => ({
  isError: true,
  result: { content: [{ type: "text", text }] },
});

const executionError = (text = "Command exited with code 1") => ({
  isError: true,
  result: { content: [{ type: "text", text }] },
});

const success = () => ({
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] },
});

test("ordinary stop errors do not trigger recovery", async (t) => {
  const harness = await createHarness(t);

  await stop(harness, "error", "ECONNRESET while fetching model stream");

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.systemMessages.length, 0);
});

test("schema-preparation tool results abort before the provider can make a third call", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 1);
  assert.match(context.notifications.at(-1).content, /schema failures are repeating/);

  await stop(harness, "error", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /Two consecutive tool calls failed before execution/);
  assert.doesNotMatch(context.notifications.at(-1).content, /Manual intervention detected/);
});

test("non-auto GSD schema-preparation failures do not trigger recovery", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await stop(harness, "error", "Operation aborted", context.ctx);

  assert.equal(context.aborts.length, 0);
  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
});

test("ordinary tool validation failures do not trigger recovery", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "lsp", ...validationError('Validation failed for tool "lsp": missing action') }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "lsp", ...validationError('Validation failed for tool "lsp": missing action') }, context.ctx);
  await stop(harness, "error", "Operation aborted");

  assert.equal(context.aborts.length, 0);
  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
});

test("schema-preparation guard recognizes validation errors after tool-name prefixes", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();
  const prefixedValidationError = validationError('gsd_plan_slice\nValidation failed for tool "gsd_plan_slice":\n  - tasks: must be array');

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...prefixedValidationError }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...prefixedValidationError }, context.ctx);

  assert.equal(context.aborts.length, 1);
  assert.match(context.notifications.at(-1).content, /schema failures are repeating/);
});

test("ordinary tool execution errors do not count toward the schema guard", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "bash", ...executionError() }, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("successful and execution-error tool results reset the schema guard", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "bash", ...executionError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "read", ...success() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);
});

test("mixed preparation and successful tool results preserve but do not increment the schema guard", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "read", ...success() }, context.ctx);
  assert.equal(context.aborts.length, 0);

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  assert.equal(context.aborts.length, 0);
});

test("successful tool results reset the schema guard", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t);
  const context = createContext();

  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "read", ...success() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);

  assert.equal(context.aborts.length, 0);
});

test("identical tool calls abort on the fourth call before GSD blocks the fifth", async (t) => {
  withAutoActive(t);
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

  await stop(harness, "error", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 1);
  await harness.timers.flushNext();
  assert.match(harness.userMessages.at(-1), /identical_tool_call_guard/);
  assert.match(harness.userMessages.at(-1), /called 4 consecutive times/);
  assert.doesNotMatch(context.notifications.at(-1).content, /Manual intervention detected/);
});

test("non-auto identical tool calls do not trigger recovery", async (t) => {
  const harness = await createHarness(t);
  const context = createContext();
  const event = { type: "tool_call", toolName: "read", input: { path: "README.md" } };

  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);
  await harness.handler("tool_call")(event, context.ctx);
  const result = await harness.handler("tool_call")(event, context.ctx);

  assert.equal(result, undefined);
  assert.equal(context.aborts.length, 0);
  assert.equal(harness.timers.pending().length, 0);
});

test("different tool arguments reset the identical-call guard", async (t) => {
  withAutoActive(t);
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
  withAutoActive(t);
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
  withAutoActive(t);
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

async function armFallbackSchemaRetry(harness, context = createContext()) {
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await harness.handler("tool_execution_end")({ type: "tool_execution_end", toolName: "gsd_plan_slice", ...validationError() }, context.ctx);
  await stop(harness, "error", "Operation aborted", context.ctx);
  assert.equal(harness.timers.pending().length, 1);
  return context;
}

test("provider errors do not count as manual intervention", async (t) => {
  const harness = await createHarness(t);

  await notify(harness, "Provider transport failed with a recoverable error", "warning");
  await stop(harness, "blocked", "provider transport failed");

  assert.equal(harness.timers.pending().length, 0);
  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.systemMessages.length, 0);
});

test("manual intervention cancels pending fallback retry", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t, { throwSendUserMessage: true });
  const context = await armFallbackSchemaRetry(harness);

  await notify(harness, "manual intervention requested by operator", "input_needed");
  await stop(harness, "error", "manual intervention requested by operator", context.ctx);

  assert.equal(harness.timers.pending().length, 0);
  assert.match(context.notifications.at(-1).content, /Manual intervention detected/);
});

test("manual operation abort cancels pending fallback retry when it was not self-triggered", async (t) => {
  withAutoActive(t);
  const harness = await createHarness(t, { throwSendUserMessage: true });
  const context = await armFallbackSchemaRetry(harness);

  await stop(harness, "error", "Operation aborted", context.ctx);

  assert.equal(harness.timers.pending().length, 0);
  assert.match(context.notifications.at(-1).content, /Manual intervention detected/);
});

test("official stop and review notifications cancel pending fallback retry", async (t) => {
  for (const message of [
    "Stop directive: stop after this task",
    "Backtrack directive: undo the last milestone",
    "Tool skipped for task: Skipped due to queued user message.",
    "Post-execution checks failed — cross-task consistency issue detected, pausing for human review",
    "Milestone M001 has an ambiguous SUMMARY. Auto-mode paused for manual review.",
    "Provider requires human input before continuing.",
    "Recovery stopped because operator action is required.",
  ]) {
    withAutoActive(t);
    const harness = await createHarness(t, { throwSendUserMessage: true });
    const context = await armFallbackSchemaRetry(harness);

    await notify(harness, message, "warning");
    await stop(harness, "blocked", "operator review required", context.ctx);

    assert.equal(harness.timers.pending().length, 0);
    assert.match(context.notifications.at(-1).content, /Manual intervention detected/);
  }
});
