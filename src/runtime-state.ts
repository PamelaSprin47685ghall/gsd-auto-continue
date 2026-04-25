import type { Diagnostics, ManagedRetryType, RuntimeState } from "./types.ts";

export function createRuntimeState(): RuntimeState {
  return {
    lastNotifications: [],
    type1Retries: 0,
    type2Loops: 0,
    isFixingType2: false,
    retryTimers: new Map(),
    consecutiveToolErrorTurns: 0,
    toolErrorGuardAbortArmed: false,
  };
}

export function getRetryCount(state: RuntimeState, retryType: ManagedRetryType): number {
  return retryType === "type1" ? state.type1Retries : state.type2Loops;
}

export function setRetryCount(state: RuntimeState, retryType: ManagedRetryType, value: number): void {
  if (retryType === "type1") {
    state.type1Retries = value;
    return;
  }

  state.type2Loops = value;
}

export function resetRetryCount(
  state: RuntimeState,
  diagnostics: Diagnostics,
  retryType: ManagedRetryType,
  reason: string,
  forceLog = false,
): void {
  if (getRetryCount(state, retryType) === 0 && !forceLog) return;

  setRetryCount(state, retryType, 0);
  diagnostics.logLifecycle("retry_reset", {
    retryType,
    attempt: 0,
    reason,
  });
}

export function resetRetries(
  state: RuntimeState,
  diagnostics: Diagnostics,
  reason: string,
  forceLog = false,
): void {
  resetRetryCount(state, diagnostics, "type1", reason, forceLog);
  resetRetryCount(state, diagnostics, "type2", reason, forceLog);
}

export function recordToolErrorTurn(state: RuntimeState): number {
  state.consecutiveToolErrorTurns += 1;
  return state.consecutiveToolErrorTurns;
}

export function resetToolErrorGuard(state: RuntimeState): void {
  state.consecutiveToolErrorTurns = 0;
  state.toolErrorGuardAbortArmed = false;
}

export function armToolErrorGuardAbort(state: RuntimeState): boolean {
  if (state.toolErrorGuardAbortArmed) return false;

  state.toolErrorGuardAbortArmed = true;
  return true;
}

export function disarmToolErrorGuardAbort(state: RuntimeState): void {
  state.toolErrorGuardAbortArmed = false;
}

export function rememberNotification(state: RuntimeState, message: string, maxNotifications: number): void {
  state.lastNotifications.push(message);
  if (state.lastNotifications.length > maxNotifications) {
    state.lastNotifications.shift();
  }
}

export function consumeStopDiagnostics(state: RuntimeState, errorMessage: string): string {
  const combined = `${state.lastNotifications.join(" | ")} ${errorMessage}`.trim();
  state.lastNotifications = [];
  return combined;
}
