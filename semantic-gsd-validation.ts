import { importInstalledGsdModule, readGsdAutoSnapshot } from "./gsd-auto-state.ts";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; details?: unknown };
type AgentTool = {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<ToolResult>;
  [key: string]: unknown;
};
type AgentLike = {
  state?: { tools?: AgentTool[] };
  setTools?: (tools: AgentTool[]) => void;
};
type AgentClass = { prototype: Record<PropertyKey, unknown> };
type Validator = (tool: AgentTool, toolCall: { id: string; name: string; arguments: unknown }) => unknown;

type InstallOptions = {
  AgentClass?: AgentClass;
  validateToolArguments?: Validator;
  isEnabled?: () => boolean | Promise<boolean>;
};

type AgentMessageLike = {
  customType?: unknown;
};

const PATCH_MARKER = Symbol.for("gsd-auto-continue.semantic-gsd-validation.patch");
const TOOL_MARKER = Symbol.for("gsd-auto-continue.semantic-gsd-validation.tool");

const fallbackSchema = { type: "object", additionalProperties: true };

const isGsdTool = (tool: AgentTool) => /^gsd_/.test(tool.name);
const isGsdAutoMessage = (message: unknown) => typeof message === "object" && message !== null && (message as AgentMessageLike).customType === "gsd-auto";
const hasGsdAutoMessage = (value: unknown): boolean => Array.isArray(value) ? value.some(hasGsdAutoMessage) : isGsdAutoMessage(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNonEmptyString = (value: unknown) => typeof value === "string" && value.trim().length > 0;

const semanticParameters = (parameters: unknown) => ({
  anyOf: [parameters ?? fallbackSchema, fallbackSchema],
  "x-gsd-auto-continue-semantic-validation": true,
});

const validationSummary = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n\nReceived arguments:")[0].trim();
};

const resultText = (result: ToolResult) => result.content.map((item) => item.text).filter(Boolean).join("\n").trim();

const resultError = (result: ToolResult) => {
  const details = isRecord(result.details) ? result.details : {};
  const error = details.error;
  const text = resultText(result);
  if (typeof error === "string" && error.trim()) return error.trim();
  if (/^Error\b/i.test(text) || /\bvalidation failed:/i.test(text)) return text;
  return undefined;
};

const schemaDescription = (schema: unknown) => isRecord(schema) && typeof schema.description === "string" ? schema.description : "";

const pathSegment = (base: string, segment: string) => base ? `${base}.${segment}` : segment;

const collectConditionalRequiredIssues = (schema: unknown, value: unknown, path: string, issues: string[]) => {
  if (!isRecord(schema)) return;

  if (schema.type === "array" && Array.isArray(value)) {
    value.forEach((item, index) => collectConditionalRequiredIssues(schema.items, item, `${path}[${index}]`, issues));
    return;
  }

  if (!isRecord(schema.properties) || !isRecord(value)) return;

  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    const childPath = pathSegment(path, key);
    const description = schemaDescription(propertySchema);
    if (/required for full slices/i.test(description) && value.isSketch !== true && !isNonEmptyString(value[key])) {
      issues.push(`${childPath} must be a non-empty string unless isSketch is true`);
    }
    collectConditionalRequiredIssues(propertySchema, value[key], childPath, issues);
  }
};

const validateConditionalRuntimeContract = (tool: AgentTool, params: unknown) => {
  const issues: string[] = [];
  collectConditionalRequiredIssues(tool.parameters, params, "", issues);
  if (issues.length > 0) {
    throw new Error(`Validation failed for tool "${tool.name}":\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }
};

const gsdOperationFailure = (toolName: string, problem: string) => ({
  content: [
    {
      type: "text" as const,
      text: `🚨 GSD TOOL CALL DID NOT RUN.

The previous ${toolName} call reached the GSD tool but the GSD operation rejected the payload. This is a semantic failure result, not a successful GSD operation.

Validation problem:
${problem.trim()}

Retry ${toolName} now with a complete, valid payload. Do not treat the prior tool result as a completed GSD operation.`,
    },
  ],
  details: {
    semanticFailure: true,
    toolName,
    source: "gsd-auto-continue",
  },
});

const semanticFailure = (toolName: string, error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: `🚨 GSD TOOL CALL DID NOT RUN.

The previous ${toolName} call failed validation before execution. This is a semantic failure result, not a successful GSD operation. No GSD DB/state changes were made.

Validation problem:
${validationSummary(error)}

Retry ${toolName} now with a complete, valid payload. Do not repeat the same invalid arguments. If you are missing required fields, inspect the current GSD plan/context before calling the tool again.`,
    },
  ],
  details: {
    semanticFailure: true,
    toolName,
    source: "gsd-auto-continue",
  },
});

async function defaultValidator(tool: AgentTool, toolCall: { id: string; name: string; arguments: unknown }) {
  const module = await importInstalledGsdModule<{ validateToolArguments?: Validator }>("packages/pi-ai/dist/index.js");
  if (typeof module?.validateToolArguments !== "function") {
    throw new Error("Unable to load @gsd/pi-ai validateToolArguments from the installed GSD runtime.");
  }

  return module.validateToolArguments(tool, toolCall);
}

async function defaultEnabled() {
  return (await readGsdAutoSnapshot())?.active === true;
}

export function wrapGsdToolForSemanticValidation(tool: AgentTool, validateToolArguments: Validator): AgentTool {
  if (!isGsdTool(tool) || (tool as Record<PropertyKey, unknown>)[TOOL_MARKER]) return tool;

  return {
    ...tool,
    [TOOL_MARKER]: true,
    parameters: semanticParameters(tool.parameters),
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        const validatedParams = await validateToolArguments(tool, { id: toolCallId, name: tool.name, arguments: params });
        validateConditionalRuntimeContract(tool, validatedParams);
        const result = await tool.execute(toolCallId, validatedParams, signal, onUpdate);
        const error = resultError(result);
        return error ? gsdOperationFailure(tool.name, error) : result;
      } catch (error) {
        return semanticFailure(tool.name, error);
      }
    },
  };
}

async function shouldEnableSemanticValidation(agent: AgentLike, options: Required<InstallOptions>, runArgs: unknown[]) {
  return hasGsdAutoMessage(runArgs[0]) || hasGsdAutoMessage(agent.state?.messages) || await options.isEnabled();
}

async function withSemanticGsdValidation<T>(agent: AgentLike, options: Required<InstallOptions>, runArgs: unknown[], run: () => Promise<T>) {
  const tools = agent.state?.tools;
  if (!tools?.some(isGsdTool) || !(await shouldEnableSemanticValidation(agent, options, runArgs))) return run();

  const wrappedTools = tools.map((tool) => wrapGsdToolForSemanticValidation(tool, options.validateToolArguments));
  const setTools = agent.setTools?.bind(agent) ?? ((nextTools: AgentTool[]) => {
    if (agent.state) agent.state.tools = nextTools;
  });

  setTools(wrappedTools);
  try {
    return await run();
  } finally {
    setTools(tools);
  }
}

async function loadDefaultAgentClass() {
  const module = await importInstalledGsdModule<{ Agent?: AgentClass }>("packages/pi-agent-core/dist/index.js");
  if (!module?.Agent) {
    throw new Error("Unable to load @gsd/pi-agent-core Agent from the installed GSD runtime.");
  }

  return module.Agent;
}

export async function installSemanticGsdValidationPatch(options: InstallOptions = {}) {
  const AgentClass = options.AgentClass ?? await loadDefaultAgentClass();
  const prototype = AgentClass.prototype;
  if (prototype[PATCH_MARKER]) return false;

  const prompt = prototype.prompt;
  const continueRun = prototype.continue;
  if (typeof prompt !== "function" || typeof continueRun !== "function") {
    throw new Error("Agent prototype does not expose prompt/continue methods for semantic GSD validation patching.");
  }

  const patchOptions: Required<InstallOptions> = {
    AgentClass,
    validateToolArguments: options.validateToolArguments ?? defaultValidator,
    isEnabled: options.isEnabled ?? defaultEnabled,
  };

  prototype.prompt = function patchedPrompt(this: AgentLike, ...args: unknown[]) {
    return withSemanticGsdValidation(this, patchOptions, args, () => Reflect.apply(prompt, this, args) as Promise<unknown>);
  };

  prototype.continue = function patchedContinue(this: AgentLike, ...args: unknown[]) {
    return withSemanticGsdValidation(this, patchOptions, args, () => Reflect.apply(continueRun, this, args) as Promise<unknown>);
  };

  prototype[PATCH_MARKER] = true;
  return true;
}
