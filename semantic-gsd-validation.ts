import { importInstalledGsdModule, readGsdAutoSnapshot } from "./gsd-auto-state.ts";

type ToolContent = { type: "text"; text: string };
type AgentTool = {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<{ content: ToolContent[]; details?: unknown }>;
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

const semanticParameters = (parameters: unknown) => ({
  anyOf: [parameters ?? fallbackSchema, fallbackSchema],
  "x-gsd-auto-continue-semantic-validation": true,
});

const validationSummary = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n\nReceived arguments:")[0].trim();
};

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
        return tool.execute(toolCallId, validatedParams, signal, onUpdate);
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
