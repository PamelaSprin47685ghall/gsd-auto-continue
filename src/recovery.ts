import type { ExtensionAPI, ExtensionContext, StopEvent } from "@gsd/pi-coding-agent";
import {
  armToolErrorGuardAbort,
  consumeAutoPauseSignalForStop,
  disarmToolErrorGuardAbort,
  recordToolErrorTurn,
  resetRetries,
  resetRetryCount,
  resetSchemaOverloadRetries,
  resetToolErrorGuard,
} from "./runtime-state.ts";
import type {
  ActionDependencies,
  ClassifierDependencies,
  Diagnostics,
  EscalationType,
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
  classifiers: ClassifierDependencies;
}

export function createRecoveryOperations({
  pi,
  state,
  config,
  diagnostics,
  timers,
  actions,
  classifiers,
}: RecoveryDependencies) {
  function standDown(reason: string, notify = false): void {
    const wasRecovering =
      state.isFixingType3 ||
      state.retryTimers.size > 0 ||
      state.toolErrorGuardAbortArmed ||
      state.consecutiveToolErrorTurns > 0;

    state.isFixingType3 = false;
    resetToolErrorGuard(state);
    state.autoPauseSignalArmedForStop = false;
    timers.cancelAllRetryTimers(`${reason}:stand_down`);
    state.lastNotifications = [];
    resetRetries(state, diagnostics, `${reason}:stand_down`, true);

    diagnostics.logLifecycle("recovery_stood_down", {
      reason,
      detail: `wasRecovering=${wasRecovering ? "yes" : "no"}`,
    });

    if (notify && wasRecovering) {
      pi.sendMessage({
        customType: "system",
        content: "ℹ️ [AutoContinue] User/manual intervention detected. Auto-recovery stood down.",
        display: true,
      });
    }
  }

  function handleSchemaOverload(stopReason: StopEvent["reason"], combinedLog: string): void {
    timers.cancelRetryTimersExcept("type1", "schema_overload_enter");
    resetRetryCount(state, diagnostics, "type1", "schema_overload_enter");
    resetRetryCount(state, diagnostics, "type2", "schema_overload_enter");
    resetRetryCount(state, diagnostics, "type3", "schema_overload_enter");

    if (state.retryTimers.has("type1")) {
      diagnostics.logLifecycle("schema_overload_retry_pending", {
        retryType: "type1",
        attempt: state.schemaOverloadRetries,
        reason: stopReason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    const nextAttempt = state.schemaOverloadRetries + 1;
    const unlimitedRetries = config.schemaOverloadMaxRetries === 0;

    if (!unlimitedRetries && nextAttempt > config.schemaOverloadMaxRetries) {
      pi.sendMessage({
        customType: "system",
        content: `❌ [AutoContinue] Schema-overload retry exhausted (${config.schemaOverloadMaxRetries}/${config.schemaOverloadMaxRetries}). Manual intervention required.`,
        display: true,
      });
      standDown("schema_overload_exhausted", false);
      return;
    }

    state.schemaOverloadRetries = nextAttempt;
    const attemptLabel = unlimitedRetries ? `${nextAttempt}` : `${nextAttempt}/${config.schemaOverloadMaxRetries}`;

    pi.sendMessage({
      customType: "system",
      content: `♻️ [AutoContinue] Core schema-overload cap hit. In-place retryLastTurn in ${config.schemaOverloadRetryDelayMs / 1000}s (Attempt ${attemptLabel})...`,
      display: true,
    });

    const pausedAutoLikely = classifiers.hasAutoPauseContext(combinedLog);
    const resumeCommand = classifiers.getResumeCommand();

    timers.scheduleRetryTimer(
      "type1",
      config.schemaOverloadRetryDelayMs,
      {
        phase: "schema_overload_retry",
        attempt: nextAttempt,
        reason: "schema_overload",
        detail: combinedLog || stopReason,
      },
      () => {
        const retryCalled = actions.safeRetryLastTurn(pi, {
          phase: "schema_overload_retry",
          retryType: "type1",
          attempt: nextAttempt,
          reason: "schema_overload",
        });

        if (pausedAutoLikely) {
          actions.safeSendUserMessage(pi, resumeCommand, {
            phase: "schema_overload_resume_auto",
            retryType: "type1",
            attempt: nextAttempt,
            reason: retryCalled
              ? "schema_overload:paused_auto_after_retry_last_turn"
              : "schema_overload:paused_auto_after_retry_last_turn_failed",
          });
          return;
        }

        if (retryCalled) return;

        actions.safeSendUserMessage(
          pi,
          "Continue from the current context. The previous turn hit schema-overload due to tool argument validation failures. Regenerate valid tool arguments and proceed without restarting auto-mode.",
          {
            phase: "schema_overload_retry_fallback",
            retryType: "type1",
            attempt: nextAttempt,
            reason: "schema_overload:retry_last_turn_fallback",
          },
        );
      },
    );
  }

  function handleType0(stopReason: StopEvent["reason"], combinedLog: string): void {
    timers.cancelRetryTimersExcept("type1", "type0_enter");
    resetRetryCount(state, diagnostics, "type2", "type0_enter");
    resetRetryCount(state, diagnostics, "type3", "type0_enter");

    if (state.retryTimers.has("type1")) {
      diagnostics.logLifecycle("type0_continue_pending", {
        retryType: "type1",
        attempt: state.type1Retries,
        reason: stopReason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    pi.sendMessage({
      customType: "system",
      content: "🧰 [AutoContinue] Type 0 detected (tool-use/validation issue). Continuing in-session with corrected tool arguments...",
      display: true,
    });

    timers.scheduleRetryTimer(
      "type1",
      300,
      {
        phase: "type0_continue",
        attempt: 0,
        reason: stopReason,
        detail: combinedLog || "tool_use_error",
      },
      () => {
        actions.safeSendUserMessage(
          pi,
          "Continue execution from current context. The previous turn failed due to tool invocation/validation errors. Regenerate valid tool arguments and continue.",
          {
            phase: "type0_continue",
            retryType: "type1",
            attempt: 0,
            reason: "tool_use_error",
          },
        );
      },
    );
  }

  function handleType3(
    stopReason: StopEvent["reason"],
    combinedLog: string,
    {
      triggerReason,
      escalation = "none",
    }: {
      triggerReason: string;
      escalation?: EscalationType;
    },
  ): void {
    timers.cancelRetryTimersExcept("type3", `type3_enter:${triggerReason}`);
    resetRetryCount(state, diagnostics, "type1", `type3_enter:${triggerReason}`);
    resetRetryCount(state, diagnostics, "type2", `type3_enter:${triggerReason}`);
    resetSchemaOverloadRetries(state, diagnostics, `type3_enter:${triggerReason}`);

    if (state.retryTimers.has("type3")) {
      diagnostics.logLifecycle("type3_retry_pending", {
        retryType: "type3",
        attempt: state.type3Retries,
        reason: triggerReason,
        escalation,
        detail: "timer_already_scheduled",
      });
      return;
    }

    if (state.type3Retries >= config.retryLimits.type3) {
      pi.sendMessage({
        customType: "system",
        content: `❌ [AutoContinue] Type 3 fix exhausted (${config.retryLimits.type3}/${config.retryLimits.type3}). Manual intervention required.`,
        display: true,
      });
      standDown("type3_exhausted", false);
      return;
    }

    state.type3Retries += 1;
    state.isFixingType3 = true;

    const attempt = state.type3Retries;
    const diagnosis = combinedLog || stopReason;

    pi.sendMessage({
      customType: "system",
      content: `🚨 [AutoContinue] Blocker/State issue detected. Dispatching Type 3 LLM fix (Attempt ${attempt}/${config.retryLimits.type3})...`,
      display: true,
    });

    const prompt = `Auto-mode has been paused due to a blocking issue or failed verification:\n\n${diagnosis}\n\nYou are now in a manual recovery turn outside auto-mode. Please diagnose and fix this specific issue using the necessary tools (e.g., edit files, resolve git conflicts, fix tests or adjust the plan). I will resume auto-mode automatically after this recovery turn completes. Do not ask for confirmation.`;

    timers.scheduleRetryTimer(
      "type3",
      2000,
      {
        phase: "type3_fix",
        attempt,
        reason: triggerReason,
        detail: "dispatch_llm_fix_prompt",
        escalation,
      },
      () => {
        actions.safeSendUserMessage(pi, prompt, {
          phase: "type3_fix",
          retryType: "type3",
          attempt,
          reason: triggerReason,
          escalation,
        });
      },
    );
  }

  function handleType2(stopReason: StopEvent["reason"], combinedLog: string): void {
    timers.cancelRetryTimersExcept("type2", "type2_enter");
    resetRetryCount(state, diagnostics, "type1", "type2_enter");
    resetRetryCount(state, diagnostics, "type3", "type2_enter");
    resetSchemaOverloadRetries(state, diagnostics, "type2_enter");

    if (state.retryTimers.has("type2")) {
      diagnostics.logLifecycle("type2_retry_pending", {
        retryType: "type2",
        attempt: state.type2Retries,
        reason: stopReason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    const resumeCommand = classifiers.getResumeCommand();

    if (state.type2Retries < config.retryLimits.type2) {
      state.type2Retries += 1;

      const attempt = state.type2Retries;
      pi.sendMessage({
        customType: "system",
        content: `⚠️ [AutoContinue] Type 2 detected (official provider-pause signal). Exiting auto-mode and jumping back in 5s (Attempt ${attempt}/${config.retryLimits.type2})...`,
        display: true,
      });

      timers.scheduleRetryTimer(
        "type2",
        5000,
        {
          phase: "type2_retry",
          attempt,
          reason: stopReason,
          detail: resumeCommand,
        },
        () => {
          actions.safeSendUserMessage(pi, resumeCommand, {
            phase: "type2_retry",
            retryType: "type2",
            attempt,
            reason: stopReason,
          });
        },
      );
      return;
    }

    resetRetryCount(state, diagnostics, "type2", "type2_exhausted", true);

    pi.sendMessage({
      customType: "system",
      content: "⚠️ [AutoContinue] Type 2 exhausted. Escalating to Type 3...",
      display: true,
    });

    handleType3(stopReason, combinedLog, {
      triggerReason: "type2_exhausted",
      escalation: "type2_to_type3",
    });
  }

  function handleType1(stopReason: StopEvent["reason"], combinedLog: string): void {
    timers.cancelRetryTimersExcept("type1", "type1_enter");
    resetRetryCount(state, diagnostics, "type2", "type1_enter");
    resetRetryCount(state, diagnostics, "type3", "type1_enter");
    resetSchemaOverloadRetries(state, diagnostics, "type1_enter");

    if (state.retryTimers.has("type1")) {
      diagnostics.logLifecycle("type1_retry_pending", {
        retryType: "type1",
        attempt: state.type1Retries,
        reason: stopReason,
        detail: "timer_already_scheduled",
      });
      return;
    }

    const networkLike = classifiers.classifyAsNetwork(combinedLog);
    const reason = networkLike ? "network_or_timeout" : stopReason;

    if (state.type1Retries < config.retryLimits.type1) {
      state.type1Retries += 1;
      const attempt = state.type1Retries;
      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 30000);

      pi.sendMessage({
        customType: "system",
        content: `📶 [AutoContinue] Transient error. Type 1 retry in ${delayMs / 1000}s (Attempt ${attempt}/${config.retryLimits.type1})...`,
        display: true,
      });

      timers.scheduleRetryTimer(
        "type1",
        delayMs,
        {
          phase: "type1_retry",
          attempt,
          reason,
          detail: networkLike ? "retryLastTurn" : "fallback_resume_command",
        },
        () => {
          if (
            actions.safeRetryLastTurn(pi, {
              phase: "type1_retry",
              retryType: "type1",
              attempt,
              reason,
            })
          ) {
            return;
          }

          actions.safeSendUserMessage(
            pi,
            "Continue execution from current context. Retry the last failed network operation without switching modes.",
            {
              phase: "type1_retry_fallback",
              retryType: "type1",
              attempt,
              reason: `${reason}:retry_last_turn_fallback`,
            },
          );
        },
      );
      return;
    }

    resetRetryCount(state, diagnostics, "type1", "type1_exhausted", true);

    const resumeCommand = classifiers.getResumeCommand();
    const attempt = Math.min(state.type2Retries + 1, config.retryLimits.type2);
    state.type2Retries = attempt;

    pi.sendMessage({
      customType: "system",
      content: "⚠️ [AutoContinue] Type 1 exhausted. Escalating to Type 2...",
      display: true,
    });

    timers.scheduleRetryTimer(
      "type2",
      2000,
      {
        phase: "type1_escalate_to_type2",
        attempt,
        reason: "type1_exhausted",
        detail: resumeCommand,
        escalation: "type1_to_type2",
      },
      () => {
        actions.safeSendUserMessage(pi, resumeCommand, {
          phase: "type1_escalate_to_type2",
          retryType: "type2",
          attempt,
          reason: "type1_exhausted",
          escalation: "type1_to_type2",
        });
      },
    );
  }

  function handleToolErrorTurn(event: ToolErrorTurnEvent, ctx: ExtensionContext): void {
    if (state.isFixingType3) return;

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
      content: "⚠️ [AutoContinue] 2 consecutive error-only tool turns detected. Aborting now to avoid schema-overload cap, then continuing in-session.",
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

    timers.scheduleRetryTimer(
      "type1",
      300,
      {
        phase: "tool_error_guard_internal_continue",
        attempt: 0,
        reason: "tool_error_guard",
        detail: "sendUserMessage",
      },
      () => {
        actions.safeSendUserMessage(
          pi,
          "Continue execution from current context. The previous turn was aborted by tool-error guard after consecutive tool failures. Read the last tool validation errors and retry with corrected arguments.",
          {
            phase: "tool_error_guard_internal_continue",
            retryType: "type1",
            attempt: 0,
            reason: "tool_error_guard",
          },
        );
      },
    );
    return true;
  }

  function resumeAfterType3FixCompleted(): void {
    state.isFixingType3 = false;
    resetRetries(state, diagnostics, "type3_fix_completed", true);

    const resumeCommand = classifiers.getResumeCommand();
    pi.sendMessage({
      customType: "system",
      content: "✅ [AutoContinue] Type 3 fix completed outside auto-mode. Resuming auto-mode...",
      display: true,
    });

    timers.scheduleRetryTimer(
      "type3",
      1500,
      {
        phase: "type3_resume",
        attempt: 0,
        reason: "type3_fix_completed",
        detail: resumeCommand,
      },
      () => {
        actions.safeSendUserMessage(pi, resumeCommand, {
          phase: "type3_resume",
          retryType: "type3",
          attempt: 0,
          reason: "type3_fix_completed",
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

    if (state.isFixingType3 && reason === "completed") {
      resumeAfterType3FixCompleted();
      return;
    }

    if (reason === "completed") {
      standDown("stop:completed", false);
      return;
    }

    if (classifiers.classifyAsToolInvocationPassthrough(combinedLog)) {
      handleType0(reason, combinedLog);
      return;
    }

    if (reason === "cancelled") {
      if (handleToolErrorGuardCancelled()) return;
      standDown("stop:cancelled", true);
      return;
    }

    if (classifiers.classifyAsUserIntervention(combinedLog)) {
      diagnostics.logLifecycle("stop_stand_down_user_intervention", { reason });
      standDown("stop:user_intervention_detected", true);
      return;
    }

    const hasAutoPauseSignal = consumeAutoPauseSignalForStop(state, classifiers.hasAutoPauseContext, combinedLog);
    if (!hasAutoPauseSignal && !state.isFixingType3) {
      diagnostics.logLifecycle("stop_passthrough_no_recent_auto_pause", {
        reason,
        detail: "pause_signal_missing_for_this_stop_turn",
      });
      return;
    }

    if (classifiers.classifyAsSchemaOverload(combinedLog)) {
      handleSchemaOverload(reason, combinedLog);
      return;
    }

    if (classifiers.classifyAsNetwork(combinedLog)) {
      handleType1(reason, combinedLog);
      return;
    }

    if (classifiers.classifyAsType2Provider(combinedLog)) {
      handleType2(reason, combinedLog);
      return;
    }

    handleType3(reason, combinedLog, {
      triggerReason: state.isFixingType3 ? `type3_in_progress:${reason}` : reason,
    });
  }

  return {
    standDown,
    handleSchemaOverload,
    handleType0,
    handleType1,
    handleType2,
    handleType3,
    handleToolErrorTurn,
    handleStop,
  };
}
