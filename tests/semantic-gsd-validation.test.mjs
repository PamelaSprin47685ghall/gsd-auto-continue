import test from "node:test";
import assert from "node:assert/strict";

const { installSemanticGsdValidationPatch, wrapGsdToolForSemanticValidation } = await import(new URL("../semantic-gsd-validation.ts", import.meta.url).href);

const gsdTool = (execute = async (_toolCallId, params) => ({ content: [{ type: "text", text: `ran ${params.ok}` }], details: undefined })) => ({
  name: "gsd_plan_slice",
  label: "Plan slice",
  description: "Plan a slice",
  parameters: {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "string" } },
  },
  execute,
});

const validationError = () => new Error('Validation failed for tool "gsd_plan_slice":\n  - ok: must have required property ok\n\nReceived arguments:\n{}');

test("semantic GSD wrapper returns a transport-successful semantic failure for invalid args", async () => {
  let executed = false;
  const wrapped = wrapGsdToolForSemanticValidation(gsdTool(async () => {
    executed = true;
    return { content: [{ type: "text", text: "ran" }] };
  }), () => {
    throw validationError();
  });

  const result = await wrapped.execute("call-1", {}, undefined, undefined);

  assert.equal(executed, false);
  assert.equal(result.details.semanticFailure, true);
  assert.match(result.content[0].text, /GSD TOOL CALL DID NOT RUN/);
  assert.match(result.content[0].text, /Retry gsd_plan_slice now with a complete, valid payload/);
  assert.doesNotMatch(result.content[0].text, /Received arguments/);
});

test("semantic GSD wrapper runs original tool with validated args", async () => {
  const wrapped = wrapGsdToolForSemanticValidation(gsdTool(), () => ({ ok: "validated" }));

  const result = await wrapped.execute("call-1", { ok: "raw" }, undefined, undefined);

  assert.equal(result.content[0].text, "ran validated");
});

test("semantic GSD wrapper follows the current runtime schema without hardcoded fields", async () => {
  const upgradedTool = {
    ...gsdTool(),
    parameters: {
      type: "object",
      required: ["newRequiredField"],
      properties: { newRequiredField: { type: "string" } },
    },
    execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: `ran ${params.newRequiredField}` }] }),
  };
  const seenSchemas = [];
  const wrapped = wrapGsdToolForSemanticValidation(upgradedTool, (tool, toolCall) => {
    seenSchemas.push(tool.parameters);
    if (!toolCall.arguments.newRequiredField) {
      throw new Error('Validation failed for tool "gsd_plan_slice":\n  - newRequiredField: must have required property newRequiredField');
    }
    return toolCall.arguments;
  });

  const failed = await wrapped.execute("call-1", {}, undefined, undefined);
  const passed = await wrapped.execute("call-2", { newRequiredField: "current-schema" }, undefined, undefined);

  assert.equal(seenSchemas[0], upgradedTool.parameters);
  assert.match(failed.content[0].text, /newRequiredField/);
  assert.equal(passed.content[0].text, "ran current-schema");
});

test("agent patch wraps gsd tools only during active auto-mode prompt", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = { tools };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt() {
      this.promptTools = this.state.tools;
    }

    async continue() {}
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => ({ ok: "validated" }),
    isEnabled: () => true,
  });

  const originalGsdTool = gsdTool();
  const ordinaryTool = { name: "read", parameters: { type: "object" }, execute: async () => ({ content: [] }) };
  const agent = new FakeAgent([originalGsdTool, ordinaryTool]);

  await agent.prompt();

  assert.notEqual(agent.promptTools[0], originalGsdTool);
  assert.deepEqual(agent.promptTools[0].parameters.anyOf[0], originalGsdTool.parameters);
  assert.equal(agent.promptTools[1], ordinaryTool);
  assert.equal(agent.state.tools[0], originalGsdTool);
});

test("agent patch is inert outside active auto-mode", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = { tools };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt() {
      this.promptTools = this.state.tools;
    }

    async continue() {}
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => {
      throw validationError();
    },
    isEnabled: () => false,
  });

  const originalGsdTool = gsdTool();
  const agent = new FakeAgent([originalGsdTool]);

  await agent.prompt();

  assert.equal(agent.promptTools[0], originalGsdTool);
  assert.equal(agent.state.tools[0], originalGsdTool);
});
