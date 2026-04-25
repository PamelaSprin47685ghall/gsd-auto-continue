import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

export type RetryType = "none" | "type1" | "type2" | "type3";
export type ManagedRetryType = Exclude<RetryType, "none">;
export type EscalationType = "none" | "type1_to_type2" | "type2_to_type3";
export type UiNotifyLevel = "info" | "warning" | "error" | "success";

export interface ScheduledRetryTimer {
  handle: ReturnType<typeof setTimeout>;
  phase: string;
  attempt: number;
  reason: string;
  delayMs: number;
  escalation: EscalationType;
  detail?: string;
}

export interface RuntimeState {
  lastNotifications: string[];
  type1Retries: number;
  type2Retries: number;
  type3Retries: number;
  schemaOverloadRetries: number;
  isFixingType3: boolean;
  retryTimers: Map<ManagedRetryType, ScheduledRetryTimer>;
  consecutiveToolErrorTurns: number;
  toolErrorGuardAbortArmed: boolean;
  autoPauseSignalArmedForStop: boolean;
}

export interface ToolErrorTurnEvent {
  toolResults?: Array<{ isError?: boolean }>;
  turnIndex?: number;
}

export interface RuntimeConfig {
  plugin: string;
  maxNotifications: number;
  retryLimits: Record<ManagedRetryType, number>;
  schemaOverloadRetryDelayMs: number;
  schemaOverloadMaxRetries: number;
  maxToolErrorsBeforeAbort: number;
}

export interface LifecycleLogOptions {
  retryType?: RetryType;
  attempt?: number;
  reason?: string;
  detail?: string;
  delayMs?: number;
  escalation?: EscalationType;
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
      escalation?: EscalationType;
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
      escalation?: EscalationType;
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

export interface ClassifierDependencies {
  classifyAsSchemaOverload(combinedLog: string): boolean;
  classifyAsType2Provider(combinedLog: string): boolean;
  classifyAsToolInvocationPassthrough(combinedLog: string): boolean;
  classifyAsNetwork(combinedLog: string): boolean;
  classifyAsUserIntervention(combinedLog: string): boolean;
  hasAutoPauseContext(combinedLog: string): boolean;
  isEscapePauseBanner(message: string): boolean;
  getResumeCommand(): string;
}
