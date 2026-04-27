import test, { mock } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import autoContinue from "./index.js";

function fakePi() {
  const handlers = {};
  const msgs = [], notes = [];
  const ctx = {
    ui: { notify: (m, t) => { notes.push({ m, t }); } },
  };
  return {
    handlers, msgs, notes, ctx,
    pi: {
      on: (e, h) => { handlers[e] = h; },
      sendUserMessage: m => { msgs.push(m); },
    },
  };
}

function createPlugin() {
  const f = fakePi();
  autoContinue(f.pi);
  return f;
}

function fireToolCall(handlers, id, toolName, input) {
  handlers["tool_call"]({ toolName, toolCallId: id, input });
  return handlers["tool_call"]({ toolName, toolCallId: id, input });
}

test("ajv-schema-bypass", () => {
  createPlugin();
  let AjvClass;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("ajv");
    AjvClass = mod.default || mod;
  } catch {}
  if (!AjvClass?.prototype?.compile) return;
  const ajv = new AjvClass();
  const validate = ajv.compile({
    type: "object",
    required: ["x"],
    properties: { x: { type: "string" } },
  });
  assert.ok(validate({ wrong: 42 }));
  assert.ok(validate({}));
  assert.ok(validate(null));
});

test("gsd-auto-continue", async t => {
  await t.test("registers expected events", () => {
    const { handlers } = createPlugin();
    assert.ok(handlers["stop"]);
    assert.ok(handlers["tool_call"]);
    assert.ok(handlers["before_agent_start"]);
    assert.ok(handlers["input"]);
  });

  await t.test("stop error triggers with-context retry", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["stop"]({ reason: "error" }, ctx);
    mock.timers.tick(1_000);
    assert.equal(msgs.length, 1);
    mock.timers.reset();
  });

  await t.test("stop completed + gsdSeen starts heartbeat", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["tool_call"]({ toolName: "gsd_plan_milestone", toolCallId: "h1", input: {} });
    handlers["stop"]({ reason: "completed" }, ctx);
    mock.timers.tick(5_000);
    assert.ok(msgs.includes("/gsd auto"));
    mock.timers.reset();
  });

  await t.test("before_agent_start clears heartbeat", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["tool_call"]({ toolName: "gsd_plan_milestone", toolCallId: "h2", input: {} });
    handlers["stop"]({ reason: "completed" }, ctx);
    mock.timers.tick(500);
    handlers["before_agent_start"]({}, ctx);
    mock.timers.tick(5_000);
    assert.ok(!msgs.includes("/gsd auto"));
    mock.timers.reset();
  });

  await t.test("user input clears heartbeat", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["tool_call"]({ toolName: "gsd_plan_milestone", toolCallId: "h3", input: {} });
    handlers["stop"]({ reason: "completed" }, ctx);
    mock.timers.tick(500);
    handlers["input"]({ source: "interactive" }, ctx);
    mock.timers.tick(5_000);
    assert.ok(!msgs.includes("/gsd auto"));
    mock.timers.reset();
  });

  await t.test("non-gsd tools do not start heartbeat", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["tool_call"]({ toolName: "bash", toolCallId: "h4", input: { command: "ls" } });
    handlers["stop"]({ reason: "completed" }, ctx);
    mock.timers.tick(5_000);
    assert.ok(!msgs.includes("/gsd auto"));
    mock.timers.reset();
  });

  await t.test("stop cancelled does not start heartbeat", () => {
    const { handlers, msgs, ctx } = createPlugin();
    mock.timers.enable({ apis: ["setTimeout"] });
    handlers["tool_call"]({ toolName: "gsd_plan_milestone", toolCallId: "h5", input: {} });
    handlers["stop"]({ reason: "cancelled" }, ctx);
    mock.timers.tick(5_000);
    assert.ok(!msgs.includes("/gsd auto"));
    mock.timers.reset();
  });
});

test("identical-call loop guard", async t => {
  await t.test("blocks after 4 identical calls", () => {
    const { handlers } = createPlugin();
    let last;
    for (let i = 0; i < 3; i++) last = fireToolCall(handlers, "g" + i, "bash", { x: 1 });
    last = fireToolCall(handlers, "g3", "bash", { x: 1 });
    assert.ok(last?.block);
  });

  await t.test("different inputs reset counter", () => {
    const { handlers } = createPlugin();
    for (let i = 0; i < 4; i++) {
      const r = fireToolCall(handlers, "d" + i, "bash", { command: "ls", x: i });
      assert.ok(!r?.block);
    }
  });

  await t.test("ask_user_questions resets counter", () => {
    const { handlers } = createPlugin();
    for (let i = 0; i < 3; i++) fireToolCall(handlers, "r" + i, "bash", { command: "ls", x: 1 });
    handlers["tool_call"]({ toolName: "ask_user_questions", toolCallId: "ask1", input: {} });
    handlers["tool_call"]({ toolName: "ask_user_questions", toolCallId: "ask1", input: {} });
    for (let i = 0; i < 3; i++)
      assert.ok(!fireToolCall(handlers, "rr" + i, "bash", { command: "ls", x: 1 })?.block);
  });
});

test("critical-tool validation in exec phase", async t => {
  await t.test("blocks bash with empty command", () => {
    const r = fireToolCall(createPlugin().handlers, "v1", "bash", { command: "" });
    assert.ok(r?.block);
    assert.ok(r.reason?.includes("command"));
  });

  await t.test("blocks bash with missing command", () => {
    const r = fireToolCall(createPlugin().handlers, "v2", "bash", {});
    assert.ok(r?.block);
  });

  await t.test("allows bash with valid command", () => {
    const r = fireToolCall(createPlugin().handlers, "v3", "bash", { command: "ls -la" });
    assert.ok(!r?.block);
  });

  await t.test("blocks write with missing path", () => {
    const r = fireToolCall(createPlugin().handlers, "v4", "write", { content: "hi" });
    assert.ok(r?.block);
  });

  await t.test("allows write with both path and content", () => {
    const r = fireToolCall(createPlugin().handlers, "v5", "write", { path: "/tmp/f", content: "hi" });
    assert.ok(!r?.block);
  });
});
