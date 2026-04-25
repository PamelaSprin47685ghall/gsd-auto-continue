import type { Diagnostics, EscalationType, ManagedRetryType, RuntimeState, TimerDependencies } from "./types.ts";

export function createTimerDependencies(state: RuntimeState, diagnostics: Diagnostics): TimerDependencies {
  function cancelRetryTimer(retryType: ManagedRetryType, reason: string): void {
    const timer = state.retryTimers.get(retryType);
    if (!timer) return;

    clearTimeout(timer.handle);
    state.retryTimers.delete(retryType);

    diagnostics.logLifecycle("timer_cancel", {
      retryType,
      attempt: timer.attempt,
      reason,
      detail: timer.phase,
      delayMs: timer.delayMs,
      escalation: timer.escalation,
    });
  }

  return {
    cancelRetryTimer,

    cancelRetryTimersExcept(activeType: ManagedRetryType, reason: string): void {
      for (const retryType of Array.from(state.retryTimers.keys())) {
        if (retryType === activeType) continue;
        cancelRetryTimer(retryType, `${reason}:superseded`);
      }
    },

    cancelAllRetryTimers(reason: string): void {
      for (const retryType of Array.from(state.retryTimers.keys())) {
        cancelRetryTimer(retryType, reason);
      }
    },

    scheduleRetryTimer(
      retryType: ManagedRetryType,
      delayMs: number,
      {
        phase,
        attempt,
        reason,
        detail,
        escalation = "none",
      }: {
        phase: string;
        attempt: number;
        reason: string;
        detail?: string;
        escalation?: EscalationType;
      },
      action: () => void,
    ): void {
      cancelRetryTimer(retryType, `${phase}:replace_existing`);

      diagnostics.logLifecycle(`${phase}_scheduled`, {
        retryType,
        attempt,
        reason,
        detail,
        delayMs,
        escalation,
      });

      const timerHandle = setTimeout(() => {
        const current = state.retryTimers.get(retryType);
        if (!current || current.handle !== timerHandle) {
          diagnostics.logLifecycle(`${phase}_skip_stale`, {
            retryType,
            attempt,
            reason: `${reason}:stale_timer`,
            delayMs,
            escalation,
          });
          return;
        }

        state.retryTimers.delete(retryType);
        diagnostics.logLifecycle(`${phase}_fired`, {
          retryType,
          attempt,
          reason,
          detail,
          delayMs,
          escalation,
        });

        try {
          action();
        } catch (error) {
          diagnostics.logLifecycle(`${phase}_action_failed`, {
            retryType,
            attempt,
            reason,
            delayMs,
            escalation,
            detail: diagnostics.normalizeError(error),
          });
        }
      }, delayMs);

      state.retryTimers.set(retryType, {
        handle: timerHandle,
        phase,
        attempt,
        reason,
        delayMs,
        escalation,
        detail,
      });
    },
  };
}
