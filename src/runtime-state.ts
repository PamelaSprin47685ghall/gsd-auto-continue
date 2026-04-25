import type { Diagnostics, ManagedRetryType, RuntimeConfig, RuntimeState } from "./types.ts";

export function createRuntimeState(): RuntimeState {
  return {
    lastNotifications: [],
    type1Retries: 0,
    type2Retries: 0,
    type3Retries: 0,
    schemaOverloadRetries: 0,
    isFixingType3: false,
    retryTimers: new Map(),
    consecutiveToolErrorTurns: 0,
    toolErrorGuardAbortArmed: false,
    autoPauseSignalArmedForStop: false,
  };
}

export function getRetryCount(state: RuntimeState, retryType: ManagedRetryType): number {
  switch (retryType) {
    case "type1":
      return state.type1Retries;
    case "type2":
      return state.type2Retries;
    case "type3":
      return state.type3Retries;
  }
}

export function setRetryCount(state: RuntimeState, retryType: ManagedRetryType, value: number): void {
  switch (retryType) {
    case "type1":
      state.type1Retries = value;
      break;
    case "type2":
      state.type2Retries = value;
      break;
    case "type3":
      state.type3Retries = value;
      break;
  }
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

export function resetSchemaOverloadRetries(
  state: RuntimeState,
  diagnostics: Diagnostics,
  reason: string,
  forceLog = false,
): void {
  if (state.schemaOverloadRetries === 0 && !forceLog) return;

  state.schemaOverloadRetries = 0;
  diagnostics.logLifecycle("schema_overload_reset", {
    retryType: "type1",
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
  resetRetryCount(state, diagnostics, "type3", reason, forceLog);
  resetSchemaOverloadRetries(state, diagnostics, reason, forceLog);
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

export function rememberNotification(state: RuntimeState, config: RuntimeConfig, message: string): void {
  state.lastNotifications.push(message);
  if (state.lastNotifications.length > config.maxNotifications) {
    state.lastNotifications.shift();
  }
}

export function consumeStopDiagnostics(state: RuntimeState, errorMessage: string): string {
  const combined = `${state.lastNotifications.join(" | ")} ${errorMessage}`.trim().toLowerCase();
  state.lastNotifications = [];
  return combined;
}

export function consumeAutoPauseSignalForStop(
  state: RuntimeState,
  hasAutoPauseContext: (combinedLog: string) => boolean,
  combinedLog: string,
): boolean {
  if (hasAutoPauseContext(combinedLog)) {
    state.autoPauseSignalArmedForStop = false;
    return true;
  }

  if (state.autoPauseSignalArmedForStop) {
    state.autoPauseSignalArmedForStop = false;
    return true;
  }

  return false;
}
