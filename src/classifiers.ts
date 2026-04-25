import type { AssistantMessage, StopEvent } from "@gsd/pi-coding-agent";
import {
  AUTO_PAUSE_CONTEXT_RE,
  ESC_PAUSE_BANNER_RE,
  NETWORK_RE,
  SCHEMA_OVERLOAD_RE,
  TOOL_INVOCATION_PASSTHROUGH_RE,
  TYPE2_PROVIDER_SIGNAL_RE,
  USER_INTERVENTION_RE,
} from "./config.ts";
import type { ClassifierDependencies } from "./types.ts";

export function getStopErrorMessage(event: StopEvent): string {
  const lastMessage = event.lastMessage as AssistantMessage | undefined;
  const maybeError = (lastMessage as { errorMessage?: unknown } | undefined)?.errorMessage;
  return typeof maybeError === "string" ? maybeError : "";
}

export function getAgentEndErrorMessage(event: { messages: unknown[] }): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastMessage = messages[messages.length - 1] as {
    errorMessage?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  } | undefined;

  const raw = typeof lastMessage?.errorMessage === "string" ? lastMessage.errorMessage : "";
  if (raw.trim()) return raw;

  const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text;
    }
  }

  return "";
}

export function createClassifierDependencies(): ClassifierDependencies {
  return {
    classifyAsSchemaOverload: (combinedLog) => SCHEMA_OVERLOAD_RE.test(combinedLog),
    classifyAsType2Provider: (combinedLog) => TYPE2_PROVIDER_SIGNAL_RE.test(combinedLog),
    classifyAsToolInvocationPassthrough: (combinedLog) => TOOL_INVOCATION_PASSTHROUGH_RE.test(combinedLog),
    classifyAsNetwork: (combinedLog) => NETWORK_RE.test(combinedLog),
    classifyAsUserIntervention: (combinedLog) => USER_INTERVENTION_RE.test(combinedLog),
    hasAutoPauseContext: (combinedLog) => AUTO_PAUSE_CONTEXT_RE.test(combinedLog),
    isEscapePauseBanner: (message) => ESC_PAUSE_BANNER_RE.test(message),
    getResumeCommand: () => "/gsd auto",
  };
}
