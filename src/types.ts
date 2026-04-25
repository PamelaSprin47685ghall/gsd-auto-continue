import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

export type RetryType = "none" | "type1" | "type2";
export type ManagedRetryType = Exclude<RetryType, "none">;
export type UiNotifyLevel = "info" | "warning" | "error" | "success";

export interface ScheduledRetryTimer {
  handle: ReturnType<typeof setTimeout>;
  phase: string;
  attempt: number;
  reason: string;
  delayMs: number;
  detail?: string;
}

export interface RuntimeState {
  lastNotifications: string[];
  type1Retries: number;
  type2Loops: number;
  isFixingType2: boolean;
  retryTimers: Map<ManagedRetryType, ScheduledRetryTimer>;
  consecutiveToolErrorTurns: number;
  toolErrorGuardAbortArmed: boolean;
}

export interface ToolErrorTurnEvent {
  toolResults?: Array<{ isError?: boolean }>;
  turnIndex?: number;
}

export interface RuntimeConfig {
  plugin: string;
  maxNotifications: number;
  type1MaxAttempts: number;
  maxType1DelayMs: number;
  type1BackoffBaseMs: number;
  maxToolErrorsBeforeAbort: number;
  resumeCommand: string;
}

export interface LifecycleLogOptions {
  retryType?: RetryType;
  attempt?: number;
  reason?: string;
  detail?: string;
  delayMs?: number;
}

export interface Diagnostics {
  bindUiNotifier(ctx?: ExtensionContext): void;
  logLifecycle(phase: string, options?: LifecycleLogOptions): void;
  normalizeError(error: unknown): string;
}

export interface TimerDependencies {
  cancelRetryTimer(retryType: ManagedRetryType, reason: string): void;
  cancelRetryTimersExcept(activeType: ManagedRetryType, reason: string): void;
  cancelAllRetryTimers(reason: string): void;
  scheduleRetryTimer(
    retryType: ManagedRetryType,
    delayMs: number,
    metadata: {
      phase: string;
      attempt: number;
      reason: string;
      detail?: string;
    },
    action: () => void,
  ): void;
}

export interface ActionDependencies {
  safeSendUserMessage(
    piApi: ExtensionAPI,
    content: string,
    metadata: {
      phase: string;
      retryType: ManagedRetryType;
      attempt: number;
      reason: string;
    },
  ): boolean;
  safeRetryLastTurn(
    piApi: ExtensionAPI,
    metadata: {
      phase: string;
      retryType: ManagedRetryType;
      attempt: number;
      reason: string;
    },
  ): boolean;
}

export interface FailureSignal {
  tier: "type1" | "type2";
  reason: string;
  detail: string;
}
