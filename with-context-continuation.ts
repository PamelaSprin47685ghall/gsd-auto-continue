import type { ExtensionContext } from "@gsd/pi-coding-agent";
import { CONTINUATION_POLICY } from "./continuation-policy.ts";

export type ToolErrorTurnEvent = {
  toolResults?: Array<{ isError?: boolean }>;
};

type WithContextContinuationOptions = {
  sendSystem(content: string): void;
  sendUserMessage(content: string): void;
  isWithoutContextRecoveryRunning(): boolean;
};

export function createWithContextContinuation({
  sendSystem,
  sendUserMessage,
  isWithoutContextRecoveryRunning,
}: WithContextContinuationOptions) {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let toolErrorTurns = 0;
  let toolErrorAbortArmed = false;

  const cancelTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const resetToolErrorGuard = () => {
    toolErrorTurns = 0;
    toolErrorAbortArmed = false;
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
      resetToolErrorGuard();
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
      sendUserMessage(
        `Continue from the current context. The previous turn failed (${reason}):\n\n${detail}\n\nRetry only the failed operation. If tool arguments were invalid, regenerate valid arguments. Do not restart /gsd auto.`,
      );
    }, delayMs);
  };

  return {
    get active() {
      return timer !== null || attempts > 0 || toolErrorTurns > 0 || toolErrorAbortArmed;
    },

    standDown() {
      const wasActive = this.active;
      attempts = 0;
      resetToolErrorGuard();
      cancelTimer();
      return wasActive;
    },

    scheduleRetry,

    resetToolErrorGuardUnlessCancelled(reason: string) {
      if (reason !== "cancelled" && toolErrorAbortArmed) resetToolErrorGuard();
    },

    handleToolErrors(event: ToolErrorTurnEvent, ctx: ExtensionContext) {
      if (isWithoutContextRecoveryRunning()) return;

      const results = Array.isArray(event.toolResults) ? event.toolResults : [];
      if (results.length === 0 || results.some((result) => result == null || typeof result.isError !== "boolean")) return;

      if (!results.every((result) => result.isError)) {
        resetToolErrorGuard();
        return;
      }

      toolErrorTurns += 1;
      if (toolErrorTurns < CONTINUATION_POLICY.maxToolErrorsBeforeAbort || toolErrorAbortArmed) return;

      toolErrorAbortArmed = true;
      sendSystem("⚠️ [AutoContinue] Tool calls are failing repeatedly. Aborting this turn and retrying with context.");

      try {
        ctx.abort();
      } catch {
        toolErrorAbortArmed = false;
      }
    },

    handleCancelledToolGuard() {
      if (!toolErrorAbortArmed) return false;

      resetToolErrorGuard();
      scheduleRetry(
        "tool_error_guard",
        "Two consecutive tool-call turns returned only tool errors; retry with corrected tool arguments before the core interrupt fires.",
      );
      return true;
    },
  };
}
