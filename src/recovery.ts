import type { ExtensionAPI, ExtensionContext, StopEvent } from "@gsd/pi-coding-agent";
import { MANUAL_INTERVENTION_PHRASES, OFFICIAL_AUTO_EXIT_PHRASES } from "./config.ts";
import {
  armToolErrorGuardAbort,
  disarmToolErrorGuardAbort,
  recordToolErrorTurn,
  resetRetries,
  resetRetryCount,
  resetToolErrorGuard,
} from "./runtime-state.ts";
import type {
  ActionDependencies,
  Diagnostics,
  RecoveryFailure,
  RuntimeConfig,
  RuntimeState,
  TimerDependencies,
  ToolErrorTurnEvent,
} from "./types.ts";

export interface RecoveryDependencies {
  pi: ExtensionAPI;
  state: RuntimeState;
  config: RuntimeConfig;
  diagnostics: Diagnostics;
  timers: TimerDependencies;
  actions: ActionDependencies;
}

export function getStopErrorMessage(event: StopEvent): string {
  const lastMessage = event.lastMessage as { errorMessage?: unknown } | undefined;
  return typeof lastMessage?.errorMessage === "string" ? lastMessage.errorMessage : "";
}

export function getAgentEndErrorMessage(event: { messages: unknown[] }): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastMessage = messages[messages.length - 1] as {
    errorMessage?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  } | undefined;

  if (typeof lastMessage?.errorMessage === "string" && lastMessage.errorMessage.trim()) {
    return lastMessage.errorMessage;
  }

  const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text;
    }
  }

  return "";
}

export function createRecoveryOperations({ pi, state, config, diagnostics, timers, actions }: RecoveryDependencies) {
  function containsAnyPhrase(text: string, phrases: readonly string[]): boolean {
    const normalized = text.toLowerCase();
    return phrases.some((phrase) => normalized.includes(phrase));
  }

  function normalizeDetail(text: string, fallback: string): string {
    const trimmed = text.trim();
    return trimmed || fallback;
  }

  function createRecoveryFailure(combinedLog: string, stopReason: StopEvent["reason"]): RecoveryFailure {
    return {
      reason: "failure",
      detail: normalizeDetail(combinedLog, String(stopReason)),
    };
  }

  function computeType1DelayMs(attempt: number): number {
    const rawDelay = config.type1BackoffBaseMs * 60 ** (attempt / config.type1MaxAttempts);
    return Math.min(config.maxType1DelayMs, Math.round(rawDelay));
  }

  function standDown(reason: string, notify = false): void {
    const wasRecovering =
      state.isFixingType2 ||
      state.retryTimers.size > 0 ||
      state.toolErrorGuardAbortArmed ||
      state.consecutiveToolErrorTurns > 0 ||
      state.type1Retries > 0 ||
      state.type2Loops > 0;

    state.isFixingType2 = false;
    state.lastNotifications = [];
    resetToolErrorGuard(state);
    timers.cancelAllRetryTimers(`${reason}:stand_down`);
    resetRetries(state, diagnostics, `${reason}:stand_down`, true);

    diagnostics.logLifecycle("recovery_stood_down", {
      reason,
      detail: `wasRecovering=${wasRecovering ? "yes" : "no"}`,
    });

    if (notify && wasRecovering) {
      pi.sendMessage({
        customType: "system",
        content: "ℹ️ [AutoContinue] Manual intervention detected. Auto-recovery stood down.",
        display: true,
      });
    }
  }

  function scheduleType1(signal: RecoveryFailure): void {
    timers.cancelRetryTimersExcept("type1", "type1_enter");
    state.isFixingType2 = false;

    if (state.retryTimers.has("type1")) {
      diagnostics.logLifecycle("type1_retry_pending", {
        retryType: "type1",
        attempt: state.type1Retries,
        reason: signal.reason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    if (state.type1Retries >= config.type1MaxAttempts) {
      resetRetryCount(state, diagnostics, "type1", "type1_exhausted", true);
      pi.sendMessage({
        customType: "system",
        content: "❌ [AutoContinue] Type 1 preserve-context retries exhausted outside auto-mode. Auto-recovery stopped; manual intervention required.",
        display: true,
      });
      diagnostics.logLifecycle("type1_exhausted_stand_down", {
        retryType: "type1",
        attempt: config.type1MaxAttempts,
        reason: signal.reason,
        detail: signal.detail,
      });
      resetToolErrorGuard(state);
      return;
    }

    state.type1Retries += 1;
    const attempt = state.type1Retries;
    const delayMs = computeType1DelayMs(attempt);

    pi.sendMessage({
      customType: "system",
      content: `♻️ [AutoContinue] Type 1 preserve-context retry in ${(delayMs / 1000).toFixed(1)}s (Attempt ${attempt}/${config.type1MaxAttempts}). Context stays hot; no /gsd auto restart.`,
      display: true,
    });

    timers.scheduleRetryTimer(
      "type1",
      delayMs,
      {
        phase: "type1_preserve_context",
        attempt,
        reason: signal.reason,
        detail: signal.detail,
      },
      () => {
        pi.sendMessage({
          customType: "system",
          content: `♻️ [AutoContinue] Retrying Type 1 preserve-context failure now (Attempt ${attempt}/${config.type1MaxAttempts}).`,
          display: true,
        });

        actions.safeSendUserMessage(
          pi,
          `Continue from the current context. The previous turn hit a preserve-context failure (${signal.reason}):\n\n${signal.detail}\n\nRetry only the failed operation. If the failure involved JSON or tool arguments, regenerate valid JSON/tool arguments. Do not restart /gsd auto and do not discard the current context.`,
          {
            phase: "type1_preserve_context",
            retryType: "type1",
            attempt,
            reason: signal.reason,
          },
        );
      },
    );
  }

  function scheduleType2(signal: RecoveryFailure): void {
    timers.cancelRetryTimersExcept("type2", "type2_enter");
    resetRetryCount(state, diagnostics, "type1", "type2_enter");

    if (state.retryTimers.has("type2")) {
      diagnostics.logLifecycle("type2_loop_pending", {
        retryType: "type2",
        attempt: state.type2Loops,
        reason: signal.reason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    state.type2Loops += 1;
    state.isFixingType2 = true;
    const loop = state.type2Loops;

    pi.sendMessage({
      customType: "system",
      content: `🚨 [AutoContinue] Type 2 discard-context recovery required (Loop ${loop}/unlimited). Dispatching a root-cause fix turn...`,
      display: true,
    });

    const prompt = `Auto-mode stopped because the official engine already exited auto-mode before AutoContinue could preserve the hot context.\n\nFailure detail:\n${signal.detail}\n\nRecovery Loop: ${loop}/unlimited.\n\nYou are now in a recovery turn. Diagnose and fix the root cause using the necessary tools (for example: resolve git conflicts, repair failed checks, fix verification/UAT blockers, or adjust code/tests). Do not ask for confirmation. When this recovery turn completes, AutoContinue will resume auto-mode automatically.`;

    timers.scheduleRetryTimer(
      "type2",
      2000,
      {
        phase: "type2_discard_context",
        attempt: loop,
        reason: signal.reason,
        detail: signal.detail,
      },
      () => {
        actions.safeSendUserMessage(pi, prompt, {
          phase: "type2_discard_context",
          retryType: "type2",
          attempt: loop,
          reason: signal.reason,
        });
      },
    );
  }

  function handleToolErrorTurn(event: ToolErrorTurnEvent, ctx: ExtensionContext): void {
    if (state.isFixingType2) return;

    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    if (toolResults.length === 0) return;

    const hasMalformedResult = toolResults.some((result) => result == null || typeof result.isError !== "boolean");
    if (hasMalformedResult) return;

    const allToolErrors = toolResults.every((result) => result.isError === true);
    if (!allToolErrors) {
      resetToolErrorGuard(state);
      return;
    }

    const attempt = recordToolErrorTurn(state);

    diagnostics.logLifecycle("tool_error_guard_count", {
      retryType: "type1",
      attempt,
      reason: "tool_error_turn",
      detail: `turn=${event.turnIndex ?? "unknown"} toolResults=${toolResults.length}`,
    });

    if (attempt < config.maxToolErrorsBeforeAbort) return;
    if (!armToolErrorGuardAbort(state)) return;

    pi.sendMessage({
      customType: "system",
      content: "⚠️ [AutoContinue] Tool-call errors reached the Type 1 guard threshold. Aborting this turn before the core 3x interrupt, then retrying in the next turn.",
      display: true,
    });

    diagnostics.logLifecycle("tool_error_guard_abort_requested", {
      retryType: "type1",
      attempt,
      reason: "tool_error_guard",
      detail: "ctx.abort",
    });

    try {
      ctx.abort();
    } catch (error) {
      diagnostics.logLifecycle("tool_error_guard_abort_failed", {
        retryType: "type1",
        attempt,
        reason: "tool_error_guard",
        detail: diagnostics.normalizeError(error),
      });
      disarmToolErrorGuardAbort(state);
    }
  }

  function handleToolErrorGuardCancelled(): boolean {
    if (!state.toolErrorGuardAbortArmed) return false;

    const guardedAttempts = state.consecutiveToolErrorTurns;
    resetToolErrorGuard(state);

    diagnostics.logLifecycle("tool_error_guard_abort_observed", {
      retryType: "type1",
      attempt: guardedAttempts,
      reason: "tool_error_guard",
      detail: "stop:cancelled",
    });

    scheduleType1({
      reason: "tool_error_guard",
      detail: "Two consecutive tool-call turns returned only tool errors; retry with corrected tool arguments before the core 3x interrupt fires.",
    });
    return true;
  }

  function resumeAfterType2FixCompleted(): void {
    state.isFixingType2 = false;
    resetRetryCount(state, diagnostics, "type1", "type2_fix_completed", true);

    pi.sendMessage({
      customType: "system",
      content: "✅ [AutoContinue] Type 2 recovery turn completed. Resuming auto-mode...",
      display: true,
    });

    timers.scheduleRetryTimer(
      "type2",
      1500,
      {
        phase: "type2_resume_auto",
        attempt: state.type2Loops,
        reason: "type2_fix_completed",
        detail: config.resumeCommand,
      },
      () => {
        actions.safeSendUserMessage(pi, config.resumeCommand, {
          phase: "type2_resume_auto",
          retryType: "type2",
          attempt: state.type2Loops,
          reason: "type2_fix_completed",
        });
      },
    );
  }

  function handleStop(event: StopEvent, combinedLog: string): void {
    const reason = event.reason;

    if (state.toolErrorGuardAbortArmed && reason !== "cancelled") {
      diagnostics.logLifecycle("tool_error_guard_abort_cleared", {
        retryType: "type1",
        attempt: state.consecutiveToolErrorTurns,
        reason,
        detail: "non_cancelled_stop",
      });
      resetToolErrorGuard(state);
    }

    if (state.isFixingType2 && reason === "completed") {
      resumeAfterType2FixCompleted();
      return;
    }

    if (reason === "completed") {
      standDown("stop:completed", false);
      return;
    }

    if (reason === "cancelled") {
      if (handleToolErrorGuardCancelled()) return;
      standDown("stop:cancelled", true);
      return;
    }

    if (containsAnyPhrase(combinedLog, MANUAL_INTERVENTION_PHRASES)) {
      diagnostics.logLifecycle("stop_stand_down_manual_intervention", { reason, detail: combinedLog });
      standDown("stop:manual_intervention_detected", true);
      return;
    }

    const officialAutoModeExit = containsAnyPhrase(combinedLog, OFFICIAL_AUTO_EXIT_PHRASES);
    if (officialAutoModeExit) {
      diagnostics.logLifecycle("official_auto_mode_exit_consumed", {
        retryType: "type2",
        reason,
        detail: combinedLog || "official_auto_mode_exit",
      });
      scheduleType2({
        reason: "official_auto_mode_exit",
        detail: normalizeDetail(combinedLog, String(reason)),
      });
      return;
    }

    scheduleType1(createRecoveryFailure(combinedLog, reason));
  }

  return {
    standDown,
    handleToolErrorTurn,
    handleStop,
  };
}
