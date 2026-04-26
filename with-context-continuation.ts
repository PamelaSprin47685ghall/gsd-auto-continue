import { createHash } from "node:crypto";
import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { CONTINUATION_POLICY } from "./continuation-policy.ts";

type TextContent = { type?: string; text?: unknown };

export type ToolCallLoopEvent = {
  toolName?: unknown;
  input?: unknown;
};

export type ToolExecutionEndLoopEvent = {
  toolName?: unknown;
  isError?: boolean;
  result?: unknown;
};

type WithContextContinuationOptions = {
  sendSystem(content: string): void;
  sendUserMessage(content: string): void;
  isWithoutContextRecoveryRunning(): boolean;
};

type ArmedAbort = {
  reason: string;
  detail: string;
};

const PREPARATION_ERROR_PATTERNS = [
  /\bValidation failed for tool\b/i,
  /\bTool .+ not found\b/i,
  /\bTool execution was blocked\b/i,
  /\bTool loop detected:/i,
  /Blocking to prevent infinite loop/i,
];

const STRICT_IDENTICAL_LOOP_TOOLS = new Set(["ask_user_questions"]);

const resultText = (result: unknown) => {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  return (Array.isArray((result as { content?: TextContent[] }).content) ? (result as { content?: TextContent[] }).content : [])
    .filter((content) => content?.type === "text" && typeof content.text === "string")
    .map((content) => content.text as string)
    .join("\n")
    .trim();
};

const semanticFailureTextPattern = /GSD TOOL CALL DID NOT RUN/i;

const resultDetails = (result: unknown) => result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;

const isSemanticFailureResult = (event: ToolExecutionEndLoopEvent) => {
  const details = resultDetails(event.result);
  return isGsdToolName(event.toolName) && (
    (details && typeof details === "object" && (details as { semanticFailure?: unknown }).semanticFailure === true) ||
    semanticFailureTextPattern.test(resultText(event.result))
  );
};

const isGsdToolName = (toolName: unknown) => typeof toolName === "string" && toolName.startsWith("gsd_");

const isPreparationError = (event: ToolExecutionEndLoopEvent) =>
  isGsdToolName(event.toolName) &&
  (isSemanticFailureResult(event) ||
    event.isError === true && PREPARATION_ERROR_PATTERNS.some((pattern) => pattern.test(resultText(event.result))));

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((normalized, key) => {
      normalized[key] = normalize((value as Record<string, unknown>)[key]);
      return normalized;
    }, {});
};

const toolCallSignature = (toolName: string, input: unknown) => {
  const hash = createHash("sha256");
  hash.update(toolName);
  hash.update(JSON.stringify(normalize(input)));
  return hash.digest("hex").slice(0, 16);
};

const retryPrompt = (reason: string, detail: string) =>
  `Continue from the current context. The previous turn failed (${reason}):\n\n${detail}\n\nRetry only the failed operation. If tool arguments were invalid, regenerate valid arguments. Do not restart /gsd auto.`;

export function createWithContextContinuation({
  sendSystem,
  sendUserMessage,
  isWithoutContextRecoveryRunning,
}: WithContextContinuationOptions) {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutivePreparationToolResults = 0;
  let identicalToolCallCount = 0;
  let lastToolCallSignature = "";
  let armedAbort: ArmedAbort | null = null;

  const cancelTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const resetPreparationErrorGuard = () => {
    consecutivePreparationToolResults = 0;
  };

  const resetIdenticalToolCallLoop = () => {
    identicalToolCallCount = 0;
    lastToolCallSignature = "";
  };

  const resetRecoveryGuards = () => {
    resetPreparationErrorGuard();
    resetIdenticalToolCallLoop();
    armedAbort = null;
  };

  const retryDelay = (attempt: number) =>
    Math.min(
      CONTINUATION_POLICY.maxWithContextDelayMs,
      Math.round(CONTINUATION_POLICY.withContextBackoffBaseMs * 60 ** (attempt / CONTINUATION_POLICY.withContextMaxAttempts)),
    );

  const scheduleRetry = (reason: string, detail: string) => {
    if (timer) return;

    if (attempts >= CONTINUATION_POLICY.withContextMaxAttempts) {
      attempts = 0;
      resetRecoveryGuards();
      sendSystem("❌ [AutoContinue] Retry limit reached. Manual intervention required.");
      return;
    }

    const attempt = ++attempts;
    const delayMs = retryDelay(attempt);
    sendSystem(
      `♻️ [AutoContinue] Retrying with context in ${(delayMs / 1000).toFixed(1)}s (${attempt}/${CONTINUATION_POLICY.withContextMaxAttempts}).`,
    );

    timer = setTimeout(() => {
      timer = null;
      sendUserMessage(retryPrompt(reason, detail));
    }, delayMs);
  };

  const abortForRetry = (ctx: ExtensionContext, systemMessage: string, abort: ArmedAbort) => {
    if (armedAbort) return { block: true, reason: abort.detail };

    sendSystem(systemMessage);
    armedAbort = abort;

    try {
      ctx.abort();
    } catch {
      armedAbort = null;
      return undefined;
    }

    return { block: true, reason: abort.detail };
  };

  return {
    get active() {
      return timer !== null || attempts > 0 || armedAbort !== null;
    },

    standDown() {
      const wasActive = this.active;
      attempts = 0;
      resetRecoveryGuards();
      cancelTimer();
      return wasActive;
    },

    scheduleRetry,

    resetIdenticalToolCallLoop,

    handleToolCallLoop(event: ToolCallLoopEvent, ctx: ExtensionContext) {
      if (isWithoutContextRecoveryRunning()) return undefined;
      if (typeof event.toolName !== "string" || STRICT_IDENTICAL_LOOP_TOOLS.has(event.toolName)) {
        resetIdenticalToolCallLoop();
        return undefined;
      }

      const signature = toolCallSignature(event.toolName, event.input ?? {});
      identicalToolCallCount = signature === lastToolCallSignature ? identicalToolCallCount + 1 : 1;
      lastToolCallSignature = signature;

      if (identicalToolCallCount < CONTINUATION_POLICY.maxIdenticalToolCallsBeforeAbort) return undefined;

      return abortForRetry(
        ctx,
        `⚠️ [AutoContinue] ${event.toolName} is repeating identical arguments. Aborting this turn; recovery will dispatch after stop.`,
        {
          reason: "identical_tool_call_guard",
          detail: `${event.toolName} was called ${identicalToolCallCount} consecutive times with identical arguments; retry with a different approach before GSD's fifth-call loop guard fires.`,
        },
      );
    },

    handleToolExecutionEnd(event: ToolExecutionEndLoopEvent, ctx: ExtensionContext) {
      if (isWithoutContextRecoveryRunning()) return;

      if (typeof event.isError !== "boolean") return;

      if (isPreparationError(event)) {
        consecutivePreparationToolResults += 1;
      } else {
        consecutivePreparationToolResults = 0;
      }

      if (consecutivePreparationToolResults < CONTINUATION_POLICY.maxPreparationErrorTurnsBeforeAbort) return;

      abortForRetry(ctx, "⚠️ [AutoContinue] Tool-call schema failures are repeating. Aborting this turn; recovery will dispatch after stop.", {
        reason: "tool_schema_guard",
        detail:
          "Two consecutive tool calls failed before execution; retry with corrected tool arguments before Pi's three-turn schema-overload interrupt fires.",
      });
    },

    handleProgrammaticAbort() {
      if (!armedAbort) return false;

      const abort = armedAbort;
      resetRecoveryGuards();
      scheduleRetry(abort.reason, abort.detail);
      return true;
    },
  };
}
