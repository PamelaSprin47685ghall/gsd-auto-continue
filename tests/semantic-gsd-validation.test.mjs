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

test("semantic GSD wrapper decodes JSON strings for schema array fields before validation", async () => {
  const tool = {
    name: "gsd_plan_slice",
    parameters: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId", "files"],
            properties: {
              taskId: { type: "string" },
              files: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: `${params.tasks.length}:${params.tasks[0].files.length}` }] }),
  };
  const wrapped = wrapGsdToolForSemanticValidation(tool, (_tool, toolCall) => {
    assert.equal(Array.isArray(toolCall.arguments.tasks), true);
    assert.equal(Array.isArray(toolCall.arguments.tasks[0].files), true);
    return toolCall.arguments;
  });

  const result = await wrapped.execute(
    "call-1",
    { tasks: JSON.stringify([{ taskId: "T01", files: JSON.stringify(["src/A.kt"]) }]) },
    undefined,
    undefined,
  );

  assert.equal(result.content[0].text, "1:1");
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

test("semantic GSD wrapper validates schema-described full-slice fields before execution", async () => {
  let executed = false;
  const tool = {
    name: "gsd_plan_milestone",
    parameters: {
      type: "object",
      required: ["slices"],
      properties: {
        slices: {
          type: "array",
          items: {
            type: "object",
            required: ["sliceId"],
            properties: {
              sliceId: { type: "string" },
              isSketch: { type: "boolean" },
              successCriteria: { type: "string", description: "Slice success criteria block (required for full slices; omit for sketches)" },
              proofLevel: { type: "string", description: "Slice proof level (required for full slices; omit for sketches)" },
              integrationClosure: { type: "string", description: "Slice integration closure (required for full slices; omit for sketches)" },
              observabilityImpact: { type: "string", description: "Slice observability impact (required for full slices; omit for sketches)" },
            },
          },
        },
      },
    },
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "planned" }] };
    },
  };
  const wrapped = wrapGsdToolForSemanticValidation(tool, (_tool, toolCall) => toolCall.arguments);

  const result = await wrapped.execute("call-1", { slices: [{ sliceId: "S01" }] }, undefined, undefined);

  assert.equal(executed, false);
  assert.equal(result.details.semanticFailure, true);
  assert.match(result.content[0].text, /slices\[0\]\.successCriteria/);
  assert.match(result.content[0].text, /slices\[0\]\.proofLevel/);
  assert.match(result.content[0].text, /slices\[0\]\.integrationClosure/);
  assert.match(result.content[0].text, /slices\[0\]\.observabilityImpact/);
});

test("semantic GSD wrapper allows schema-described fields to be omitted for sketch slices", async () => {
  let executed = false;
  const tool = {
    name: "gsd_plan_milestone",
    parameters: {
      type: "object",
      properties: {
        slices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              isSketch: { type: "boolean" },
              successCriteria: { type: "string", description: "Slice success criteria block (required for full slices; omit for sketches)" },
            },
          },
        },
      },
    },
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "planned" }] };
    },
  };
  const wrapped = wrapGsdToolForSemanticValidation(tool, (_tool, toolCall) => toolCall.arguments);

  const result = await wrapped.execute("call-1", { slices: [{ isSketch: true }] }, undefined, undefined);

  assert.equal(executed, true);
  assert.equal(result.content[0].text, "planned");
});

test("semantic GSD wrapper normalizes GSD operation validation failures", async () => {
  const wrapped = wrapGsdToolForSemanticValidation(gsdTool(async () => ({
    content: [{ type: "text", text: "Error planning milestone: validation failed: slices[0].proofLevel must be a non-empty string" }],
    details: { operation: "plan_milestone", error: "validation failed: slices[0].proofLevel must be a non-empty string" },
  })), () => ({ ok: "valid" }));

  const result = await wrapped.execute("call-1", { ok: "raw" }, undefined, undefined);

  assert.equal(result.details.semanticFailure, true);
  assert.match(result.content[0].text, /GSD TOOL CALL DID NOT RUN/);
  assert.match(result.content[0].text, /slices\[0\]\.proofLevel/);
  assert.doesNotMatch(result.content[0].text, /^Error planning milestone/);
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

test("agent patch exposes original schemas to provider while keeping internal semantic wrappers", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = { tools };
      this.streamFn = async (_model, context) => {
        this.providerTools = context.tools;
      };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt() {
      this.internalTools = this.state.tools;
      await this.streamFn({}, { tools: this.state.tools }, {});
    }

    async continue() {}
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => ({ ok: "validated" }),
    isEnabled: () => true,
  });

  const originalGsdTool = gsdTool();
  const agent = new FakeAgent([originalGsdTool]);

  await agent.prompt();

  assert.notEqual(agent.internalTools[0], originalGsdTool);
  assert.deepEqual(agent.internalTools[0].parameters.anyOf[0], originalGsdTool.parameters);
  assert.equal(agent.providerTools[0], originalGsdTool);
  assert.deepEqual(agent.providerTools[0].parameters, originalGsdTool.parameters);
  assert.equal(agent.state.tools[0], originalGsdTool);
});

test("agent patch wraps current gsd-auto custom prompt without global state", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = { tools, messages: [] };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt(message) {
      this.promptMessage = message;
      this.promptTools = this.state.tools;
    }

    async continue() {}
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => ({ ok: "validated" }),
    isEnabled: () => false,
  });

  const originalGsdTool = gsdTool();
  const agent = new FakeAgent([originalGsdTool]);

  await agent.prompt({ role: "custom", customType: "gsd-auto", content: "plan milestone", display: false });

  assert.notEqual(agent.promptTools[0], originalGsdTool);
  assert.deepEqual(agent.promptTools[0].parameters.anyOf[0], originalGsdTool.parameters);
  assert.equal(agent.state.tools[0], originalGsdTool);
});

test("agent patch ignores historical gsd-auto messages outside active auto-mode", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = {
        tools,
        messages: [{ role: "custom", customType: "gsd-auto", content: "plan milestone", display: false }],
      };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt() {}

    async continue() {
      this.continueTools = this.state.tools;
    }
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => ({ ok: "validated" }),
    isEnabled: () => false,
  });

  const originalGsdTool = gsdTool();
  const agent = new FakeAgent([originalGsdTool]);

  await agent.continue();

  assert.equal(agent.continueTools[0], originalGsdTool);
  assert.equal(agent.state.tools[0], originalGsdTool);
});

test("agent patch wraps continue only when local auto-mode is active", async () => {
  class FakeAgent {
    constructor(tools) {
      this.state = { tools };
    }

    setTools(tools) {
      this.state.tools = tools;
    }

    async prompt() {}

    async continue() {
      this.continueTools = this.state.tools;
    }
  }

  await installSemanticGsdValidationPatch({
    AgentClass: FakeAgent,
    validateToolArguments: () => ({ ok: "validated" }),
    isEnabled: () => true,
  });

  const originalGsdTool = gsdTool();
  const agent = new FakeAgent([originalGsdTool]);

  await agent.continue();

  assert.notEqual(agent.continueTools[0], originalGsdTool);
  assert.deepEqual(agent.continueTools[0].parameters.anyOf[0], originalGsdTool.parameters);
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
