import type {
  AssistantMessage,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  NotificationEvent,
  SessionEndEvent,
  StopEvent,
} from "@gsd/pi-coding-agent";

type RetryType = "none" | "type1" | "type2" | "type3";
type ManagedRetryType = Exclude<RetryType, "none">;
type EscalationType = "none" | "type1_to_type2" | "type2_to_type3";

interface ScheduledRetryTimer {
  handle: ReturnType<typeof setTimeout>;
  phase: string;
  attempt: number;
  reason: string;
  delayMs: number;
  escalation: EscalationType;
  detail?: string;
}

interface RuntimeState {
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

const PLUGIN = "gsd-auto-continue";
const MAX_NOTIFICATIONS = 5;
const RETRY_LIMITS = {
  type1: 10,
  type2: 5,
  type3: 3,
} as const;
const SCHEMA_OVERLOAD_RETRY_DELAY_MS = 1500;
const SCHEMA_OVERLOAD_MAX_RETRIES_RAW = Number.parseInt(
  process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES || "0",
  10,
);
const SCHEMA_OVERLOAD_MAX_RETRIES =
  Number.isFinite(SCHEMA_OVERLOAD_MAX_RETRIES_RAW) && SCHEMA_OVERLOAD_MAX_RETRIES_RAW > 0
    ? SCHEMA_OVERLOAD_MAX_RETRIES_RAW
    : 0;
const MAX_TOOL_ERRORS_BEFORE_ABORT = 2;

const ESC_PAUSE_BANNER_RE = /\b(?:auto|step)-mode paused \(escape\)\b/i;

const USER_INTERVENTION_RE =
  /stop directive detected|queued user message interrupted|manual intervention/i;

const TYPE2_PROVIDER_SIGNAL_RE =
  /\bprovider error\b|\brate limited\b|\bserver error \(transient\)\b/i;

const TOOL_INVOCATION_PASSTHROUGH_RE =
  /^(?!.*(?:exceeded cap|consecutive)).*(?:tool invocation failed|structured argument generation failed|validation failed for tool)/i;

const SCHEMA_OVERLOAD_RE =
  /schema overload|consecutive tool validation failures exceeded cap|consecutive turns with all tool calls failing/i;

const AUTO_PAUSE_CONTEXT_RE = /(?:auto|step)-mode paused|paused \(escape\)/i;

const NETWORK_RE = /network|timeout|econnreset|socket|fetch failed|stream idle/i;

const state: RuntimeState = {
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

type UiNotifyLevel = "info" | "warning" | "error" | "success";

let uiNotify: ((message: string, level?: UiNotifyLevel) => void) | null = null;

function bindUiNotifier(ctx?: ExtensionContext): void {
  const maybeUi = (ctx as { ui?: { notify?: unknown } } | undefined)?.ui;
  const maybeNotify = maybeUi?.notify;
  if (typeof maybeNotify !== "function") return;

  uiNotify = (message: string, level: UiNotifyLevel = "info") => {
    try {
      maybeNotify.call(maybeUi, message, level);
    } catch {
      // Ignore UI notify failures; recovery flow must stay non-blocking.
    }
  };
}

function notifyLifecycleUi(payload: Record<string, unknown>): void {
  if (!uiNotify) return;
  uiNotify(`[AutoContinue] ${JSON.stringify(payload)}`, "info");
}

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function logLifecycle(
  phase: string,
  {
    retryType = "none",
    attempt = 0,
    reason = "n/a",
    detail,
    delayMs,
    escalation = "none",
  }: {
    retryType?: RetryType;
    attempt?: number;
    reason?: string;
    detail?: string;
    delayMs?: number;
    escalation?: EscalationType;
  } = {},
): void {
  const payload: Record<string, unknown> = {
    plugin: PLUGIN,
    phase,
    retryType,
    attempt,
    reason,
    fixingType3: state.isFixingType3,
  };

  if (detail) payload.detail = truncate(detail, 320);
  if (typeof delayMs === "number") payload.delayMs = delayMs;
  if (escalation !== "none") payload.escalation = escalation;

  notifyLifecycleUi(payload);
}

function getRetryCount(retryType: ManagedRetryType): number {
  switch (retryType) {
    case "type1":
      return state.type1Retries;
    case "type2":
      return state.type2Retries;
    case "type3":
      return state.type3Retries;
  }
}

function setRetryCount(retryType: ManagedRetryType, value: number): void {
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

function resetRetryCount(retryType: ManagedRetryType, reason: string, forceLog = false): void {
  const current = getRetryCount(retryType);
  if (current === 0 && !forceLog) return;

  setRetryCount(retryType, 0);
  logLifecycle("retry_reset", {
    retryType,
    attempt: 0,
    reason,
  });
}

function resetSchemaOverloadRetries(reason: string, forceLog = false): void {
  if (state.schemaOverloadRetries === 0 && !forceLog) return;

  state.schemaOverloadRetries = 0;
  logLifecycle("schema_overload_reset", {
    retryType: "type1",
    attempt: 0,
    reason,
  });
}

function resetRetries(reason: string, forceLog = false): void {
  resetRetryCount("type1", reason, forceLog);
  resetRetryCount("type2", reason, forceLog);
  resetRetryCount("type3", reason, forceLog);
  resetSchemaOverloadRetries(reason, forceLog);
}

function rememberNotification(message: string): void {
  state.lastNotifications.push(message);
  if (state.lastNotifications.length > MAX_NOTIFICATIONS) {
    state.lastNotifications.shift();
  }
}

function consumeStopDiagnostics(errorMessage: string): string {
  const combined = `${state.lastNotifications.join(" | ")} ${errorMessage}`.trim().toLowerCase();
  state.lastNotifications = [];
  return combined;
}

function consumeAutoPauseSignalForStop(combinedLog: string): boolean {
  if (AUTO_PAUSE_CONTEXT_RE.test(combinedLog)) {
    state.autoPauseSignalArmedForStop = false;
    return true;
  }

  if (state.autoPauseSignalArmedForStop) {
    state.autoPauseSignalArmedForStop = false;
    return true;
  }

  return false;
}

function cancelRetryTimer(retryType: ManagedRetryType, reason: string): void {
  const timer = state.retryTimers.get(retryType);
  if (!timer) return;

  clearTimeout(timer.handle);
  state.retryTimers.delete(retryType);

  logLifecycle("timer_cancel", {
    retryType,
    attempt: timer.attempt,
    reason,
    detail: timer.phase,
    delayMs: timer.delayMs,
    escalation: timer.escalation,
  });
}

function cancelRetryTimersExcept(activeType: ManagedRetryType, reason: string): void {
  for (const retryType of Array.from(state.retryTimers.keys())) {
    if (retryType === activeType) continue;
    cancelRetryTimer(retryType, `${reason}:superseded`);
  }
}

function cancelAllRetryTimers(reason: string): void {
  for (const retryType of Array.from(state.retryTimers.keys())) {
    cancelRetryTimer(retryType, reason);
  }
}

function scheduleRetryTimer(
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

  logLifecycle(`${phase}_scheduled`, {
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
      logLifecycle(`${phase}_skip_stale`, {
        retryType,
        attempt,
        reason: `${reason}:stale_timer`,
        delayMs,
        escalation,
      });
      return;
    }

    state.retryTimers.delete(retryType);
    logLifecycle(`${phase}_fired`, {
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
      logLifecycle(`${phase}_action_failed`, {
        retryType,
        attempt,
        reason,
        delayMs,
        escalation,
        detail: normalizeError(error),
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
}

function standDown(reason: string, pi: ExtensionAPI, notify = false): void {
  const wasRecovering =
    state.isFixingType3 || state.retryTimers.size > 0 || state.toolErrorGuardAbortArmed || state.consecutiveToolErrorTurns > 0;

  state.isFixingType3 = false;
  state.consecutiveToolErrorTurns = 0;
  state.toolErrorGuardAbortArmed = false;
  state.autoPauseSignalArmedForStop = false;
  cancelAllRetryTimers(`${reason}:stand_down`);
  state.lastNotifications = [];
  resetRetries(`${reason}:stand_down`, true);

  logLifecycle("recovery_stood_down", {
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

function getResumeCommand(): string {
  return "/gsd auto";
}

function safeSendUserMessage(
  piApi: ExtensionAPI,
  content: string,
  {
    phase,
    retryType,
    attempt,
    reason,
    escalation = "none",
  }: {
    phase: string;
    retryType: ManagedRetryType;
    attempt: number;
    reason: string;
    escalation?: EscalationType;
  },
): boolean {
  try {
    piApi.sendUserMessage(content);
    return true;
  } catch (error) {
    logLifecycle(`${phase}_send_user_message_failed`, {
      retryType,
      attempt,
      reason,
      escalation,
      detail: normalizeError(error),
    });
  }

  const maybeSendMessage = (piApi as { sendMessage?: unknown }).sendMessage;
  if (typeof maybeSendMessage !== "function") {
    logLifecycle(`${phase}_trigger_turn_unavailable`, {
      retryType,
      attempt,
      reason,
      escalation,
      detail: "sendMessage_missing",
    });
    return false;
  }

  try {
    maybeSendMessage.call(
      piApi,
      { customType: "auto-continue-recovery", content, display: false },
      { triggerTurn: true },
    );
    logLifecycle(`${phase}_trigger_turn_called`, {
      retryType,
      attempt,
      reason,
      escalation,
      detail: "fallback_sendMessage_triggerTurn",
    });
    return true;
  } catch (error) {
    logLifecycle(`${phase}_trigger_turn_failed`, {
      retryType,
      attempt,
      reason,
      escalation,
      detail: normalizeError(error),
    });
    return false;
  }
}

function safeRetryLastTurn(
  piApi: ExtensionAPI,
  {
    phase,
    retryType,
    attempt,
    reason,
  }: {
    phase: string;
    retryType: ManagedRetryType;
    attempt: number;
    reason: string;
  },
): boolean {
  const maybeRetry = (piApi as { retryLastTurn?: unknown }).retryLastTurn;
  if (typeof maybeRetry !== "function") {
    logLifecycle(`${phase}_retry_last_turn_unavailable`, {
      retryType,
      attempt,
      reason: `${reason}:retryLastTurn_missing`,
    });
    return false;
  }

  try {
    maybeRetry.call(piApi);
    logLifecycle(`${phase}_retry_last_turn_called`, {
      retryType,
      attempt,
      reason,
    });
    return true;
  } catch (error) {
    logLifecycle(`${phase}_retry_last_turn_failed`, {
      retryType,
      attempt,
      reason,
      detail: normalizeError(error),
    });
    return false;
  }
}

function getStopErrorMessage(event: StopEvent): string {
  const lastMsg = event.lastMessage as AssistantMessage | undefined;
  const maybeError = (lastMsg as { errorMessage?: unknown } | undefined)?.errorMessage;
  return typeof maybeError === "string" ? maybeError : "";
}

function getAgentEndErrorMessage(event: { messages: unknown[] }): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastMsg = messages[messages.length - 1] as {
    errorMessage?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  } | undefined;

  const raw = typeof lastMsg?.errorMessage === "string" ? lastMsg.errorMessage : "";
  if (raw.trim()) return raw;

  const blocks = Array.isArray(lastMsg?.content) ? lastMsg.content : [];
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return block.text;
    }
  }

  return "";
}

function classifyAsType2Provider(combinedLog: string): boolean {
  return TYPE2_PROVIDER_SIGNAL_RE.test(combinedLog);
}

function classifyAsSchemaOverload(combinedLog: string): boolean {
  return SCHEMA_OVERLOAD_RE.test(combinedLog);
}

function handleSchemaOverload(piApi: ExtensionAPI, stopReason: StopEvent["reason"], combinedLog: string): void {
  cancelRetryTimersExcept("type1", "schema_overload_enter");
  resetRetryCount("type1", "schema_overload_enter");
  resetRetryCount("type2", "schema_overload_enter");
  resetRetryCount("type3", "schema_overload_enter");

  if (state.retryTimers.has("type1")) {
    logLifecycle("schema_overload_retry_pending", {
      retryType: "type1",
      attempt: state.schemaOverloadRetries,
      reason: stopReason,
      detail: "timer_already_scheduled",
    });
    return;
  }

  const nextAttempt = state.schemaOverloadRetries + 1;
  const unlimitedRetries = SCHEMA_OVERLOAD_MAX_RETRIES === 0;

  if (!unlimitedRetries && nextAttempt > SCHEMA_OVERLOAD_MAX_RETRIES) {
    piApi.sendMessage({
      customType: "system",
      content: `❌ [AutoContinue] Schema-overload retry exhausted (${SCHEMA_OVERLOAD_MAX_RETRIES}/${SCHEMA_OVERLOAD_MAX_RETRIES}). Manual intervention required.`,
      display: true,
    });
    standDown("schema_overload_exhausted", piApi, false);
    return;
  }

  state.schemaOverloadRetries = nextAttempt;
  const attemptLabel = unlimitedRetries
    ? `${nextAttempt}`
    : `${nextAttempt}/${SCHEMA_OVERLOAD_MAX_RETRIES}`;

  piApi.sendMessage({
    customType: "system",
    content: `♻️ [AutoContinue] Core schema-overload cap hit. In-place retryLastTurn in ${SCHEMA_OVERLOAD_RETRY_DELAY_MS / 1000}s (Attempt ${attemptLabel})...`,
    display: true,
  });

  const pausedAutoLikely = AUTO_PAUSE_CONTEXT_RE.test(combinedLog);
  const resumeCommand = getResumeCommand();

  scheduleRetryTimer(
    "type1",
    SCHEMA_OVERLOAD_RETRY_DELAY_MS,
    {
      phase: "schema_overload_retry",
      attempt: nextAttempt,
      reason: "schema_overload",
      detail: combinedLog || stopReason,
    },
    () => {
      const retryCalled = safeRetryLastTurn(piApi, {
        phase: "schema_overload_retry",
        retryType: "type1",
        attempt: nextAttempt,
        reason: "schema_overload",
      });

      if (pausedAutoLikely) {
        safeSendUserMessage(piApi, resumeCommand, {
          phase: "schema_overload_resume_auto",
          retryType: "type1",
          attempt: nextAttempt,
          reason: retryCalled
            ? "schema_overload:paused_auto_after_retry_last_turn"
            : "schema_overload:paused_auto_after_retry_last_turn_failed",
        });
        return;
      }

      if (retryCalled) {
        return;
      }

      safeSendUserMessage(
        piApi,
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

function handleType0(piApi: ExtensionAPI, stopReason: StopEvent["reason"], combinedLog: string): void {
  cancelRetryTimersExcept("type1", "type0_enter");
  resetRetryCount("type2", "type0_enter");
  resetRetryCount("type3", "type0_enter");

  if (state.retryTimers.has("type1")) {
    logLifecycle("type0_continue_pending", {
      retryType: "type1",
      attempt: state.type1Retries,
      reason: stopReason,
      detail: "timer_already_scheduled",
    });
    return;
  }

  piApi.sendMessage({
    customType: "system",
    content: "🧰 [AutoContinue] Type 0 detected (tool-use/validation issue). Continuing in-session with corrected tool arguments...",
    display: true,
  });

  scheduleRetryTimer(
    "type1",
    300,
    {
      phase: "type0_continue",
      attempt: 0,
      reason: stopReason,
      detail: combinedLog || "tool_use_error",
    },
    () => {
      safeSendUserMessage(
        piApi,
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
  piApi: ExtensionAPI,
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
  cancelRetryTimersExcept("type3", `type3_enter:${triggerReason}`);
  resetRetryCount("type1", `type3_enter:${triggerReason}`);
  resetRetryCount("type2", `type3_enter:${triggerReason}`);
  resetSchemaOverloadRetries(`type3_enter:${triggerReason}`);

  if (state.retryTimers.has("type3")) {
    logLifecycle("type3_retry_pending", {
      retryType: "type3",
      attempt: state.type3Retries,
      reason: triggerReason,
      escalation,
      detail: "timer_already_scheduled",
    });
    return;
  }

  if (state.type3Retries >= RETRY_LIMITS.type3) {
    piApi.sendMessage({
      customType: "system",
      content: `❌ [AutoContinue] Type 3 fix exhausted (${RETRY_LIMITS.type3}/${RETRY_LIMITS.type3}). Manual intervention required.`,
      display: true,
    });
    standDown("type3_exhausted", piApi, false);
    return;
  }

  state.type3Retries += 1;
  state.isFixingType3 = true;

  const attempt = state.type3Retries;
  const diagnosis = combinedLog || stopReason;

  piApi.sendMessage({
    customType: "system",
    content: `🚨 [AutoContinue] Blocker/State issue detected. Dispatching Type 3 LLM fix (Attempt ${attempt}/${RETRY_LIMITS.type3})...`,
    display: true,
  });

  const prompt = `Auto-mode has been paused due to a blocking issue or failed verification:\n\n${diagnosis}\n\nYou are now in a manual recovery turn outside auto-mode. Please diagnose and fix this specific issue using the necessary tools (e.g., edit files, resolve git conflicts, fix tests or adjust the plan). I will resume auto-mode automatically after this recovery turn completes. Do not ask for confirmation.`;

  scheduleRetryTimer(
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
      safeSendUserMessage(piApi, prompt, {
        phase: "type3_fix",
        retryType: "type3",
        attempt,
        reason: triggerReason,
        escalation,
      });
    },
  );
}

function handleType2(piApi: ExtensionAPI, stopReason: StopEvent["reason"], combinedLog: string): void {
  cancelRetryTimersExcept("type2", "type2_enter");
  resetRetryCount("type1", "type2_enter");
  resetRetryCount("type3", "type2_enter");
  resetSchemaOverloadRetries("type2_enter");

  if (state.retryTimers.has("type2")) {
    logLifecycle("type2_retry_pending", {
      retryType: "type2",
      attempt: state.type2Retries,
      reason: stopReason,
      detail: "timer_already_scheduled",
    });
    return;
  }

  const resumeCommand = getResumeCommand();

  if (state.type2Retries < RETRY_LIMITS.type2) {
    state.type2Retries += 1;

    const attempt = state.type2Retries;
    piApi.sendMessage({
      customType: "system",
      content: `⚠️ [AutoContinue] Type 2 detected (official provider-pause signal). Exiting auto-mode and jumping back in 5s (Attempt ${attempt}/${RETRY_LIMITS.type2})...`,
      display: true,
    });

    scheduleRetryTimer(
      "type2",
      5000,
      {
        phase: "type2_retry",
        attempt,
        reason: stopReason,
        detail: resumeCommand,
      },
      () => {
        safeSendUserMessage(piApi, resumeCommand, {
          phase: "type2_retry",
          retryType: "type2",
          attempt,
          reason: stopReason,
        });
      },
    );
    return;
  }

  resetRetryCount("type2", "type2_exhausted", true);

  piApi.sendMessage({
    customType: "system",
    content: "⚠️ [AutoContinue] Type 2 exhausted. Escalating to Type 3...",
    display: true,
  });

  handleType3(piApi, stopReason, combinedLog, {
    triggerReason: "type2_exhausted",
    escalation: "type2_to_type3",
  });
}

function handleType1(piApi: ExtensionAPI, stopReason: StopEvent["reason"], combinedLog: string): void {
  cancelRetryTimersExcept("type1", "type1_enter");
  resetRetryCount("type2", "type1_enter");
  resetRetryCount("type3", "type1_enter");
  resetSchemaOverloadRetries("type1_enter");

  if (state.retryTimers.has("type1")) {
    logLifecycle("type1_retry_pending", {
      retryType: "type1",
      attempt: state.type1Retries,
      reason: stopReason,
      detail: "timer_already_scheduled",
    });
    return;
  }

  const networkLike = NETWORK_RE.test(combinedLog);
  const reason = networkLike ? "network_or_timeout" : stopReason;

  if (state.type1Retries < RETRY_LIMITS.type1) {
    state.type1Retries += 1;
    const attempt = state.type1Retries;

    // 指数退避: 2s, 4s, 8s... 封顶 30s
    const delayMs = Math.min(2000 * 2 ** (attempt - 1), 30000);

    piApi.sendMessage({
      customType: "system",
      content: `📶 [AutoContinue] Transient error. Type 1 retry in ${delayMs / 1000}s (Attempt ${attempt}/${RETRY_LIMITS.type1})...`,
      display: true,
    });

    scheduleRetryTimer(
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
          safeRetryLastTurn(piApi, {
            phase: "type1_retry",
            retryType: "type1",
            attempt,
            reason,
          })
        ) {
          return;
        }

        safeSendUserMessage(
          piApi,
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

  resetRetryCount("type1", "type1_exhausted", true);

  const resumeCommand = getResumeCommand();
  const attempt = Math.min(state.type2Retries + 1, RETRY_LIMITS.type2);
  state.type2Retries = attempt;

  piApi.sendMessage({
    customType: "system",
    content: "⚠️ [AutoContinue] Type 1 exhausted. Escalating to Type 2...",
    display: true,
  });

  scheduleRetryTimer(
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
      safeSendUserMessage(piApi, resumeCommand, {
        phase: "type1_escalate_to_type2",
        retryType: "type2",
        attempt,
        reason: "type1_exhausted",
        escalation: "type1_to_type2",
      });
    },
  );
}

export default async function registerExtension(pi: ExtensionAPI) {
  logLifecycle("factory_registered", {
    reason: "extension_factory_initialized",
  });

  // Avoid side effects in factory init; announce only after a real session starts.
  pi.on("session_start", (_event, ctx) => {
    bindUiNotifier(ctx);
    logLifecycle("hook_session_start", { reason: "session_start" });
    pi.sendMessage({
      customType: "system",
      content: "🚀 [AutoContinue] Verbose lifecycle mode enabled. Waiting for stop/error recovery signals...",
      display: true,
    });
  });

  pi.on("session_end", (event: SessionEndEvent) => {
    logLifecycle("hook_session_end", {
      reason: `session_end:${event.reason}`,
      detail: event.sessionFile,
    });

    if (event.reason === "programmatic" && (state.isFixingType3 || state.retryTimers.size > 0)) {
      logLifecycle("session_end_recovery_preserved", {
        reason: "session_end:programmatic",
        detail: "recovery_pipeline_continues_across_session_boundary",
      });
      return;
    }

    standDown(`session_end:${event.reason}`, pi, false);
  });

  pi.on("session_shutdown", () => {
    logLifecycle("hook_session_shutdown", { reason: "session_shutdown" });
    standDown("session_shutdown", pi, false);
  });

  pi.on("before_agent_start", (_event: BeforeAgentStartEvent) => {
    // Reserved hook for future pre-turn recovery context wiring.
  });

  pi.on("agent_end", (event: { messages: unknown[] }) => {
    const errorMsg = getAgentEndErrorMessage(event);
    if (!errorMsg) return;
    if (!classifyAsSchemaOverload(errorMsg.toLowerCase())) return;

    const messages = Array.isArray(event.messages) ? event.messages : [];
    const lastMsg = messages[messages.length - 1] as {
      stopReason?: unknown;
      errorMessage?: unknown;
    } | undefined;

    if (!lastMsg || lastMsg.stopReason !== "error") return;

    const rawError = typeof lastMsg.errorMessage === "string" ? lastMsg.errorMessage : "";
    if (NETWORK_RE.test(rawError)) return;

    const hijackedError = rawError
      ? `${rawError} | fetch failed (schema-overload-transient-hijack)`
      : "fetch failed (schema-overload-transient-hijack)";

    lastMsg.errorMessage = hijackedError;

    logLifecycle("agent_end_schema_overload_hijack", {
      reason: "schema_overload",
      detail: hijackedError,
    });
  });

  pi.on("turn_end", (event: { toolResults?: Array<{ isError?: boolean }>; turnIndex?: number }, ctx: ExtensionContext) => {
    if (state.isFixingType3) return;

    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    if (toolResults.length === 0) {
      return;
    }

    const allToolErrors = toolResults.every((result) => result?.isError === true);
    if (!allToolErrors) {
      state.consecutiveToolErrorTurns = 0;
      state.toolErrorGuardAbortArmed = false;
      return;
    }

    state.consecutiveToolErrorTurns += 1;

    logLifecycle("tool_error_guard_count", {
      retryType: "type1",
      attempt: state.consecutiveToolErrorTurns,
      reason: "tool_error_turn",
      detail: `turn=${event.turnIndex ?? "unknown"} toolResults=${toolResults.length}`,
    });

    if (state.consecutiveToolErrorTurns < MAX_TOOL_ERRORS_BEFORE_ABORT) {
      return;
    }

    if (state.toolErrorGuardAbortArmed) {
      return;
    }

    state.toolErrorGuardAbortArmed = true;

    pi.sendMessage({
      customType: "system",
      content: "⚠️ [AutoContinue] 2 consecutive error-only tool turns detected. Aborting now to avoid schema-overload cap, then continuing in-session.",
      display: true,
    });

    logLifecycle("tool_error_guard_abort_requested", {
      retryType: "type1",
      attempt: state.consecutiveToolErrorTurns,
      reason: "tool_error_guard",
      detail: "ctx.abort",
    });

    try {
      ctx.abort();
    } catch (error) {
      logLifecycle("tool_error_guard_abort_failed", {
        retryType: "type1",
        attempt: state.consecutiveToolErrorTurns,
        reason: "tool_error_guard",
        detail: normalizeError(error),
      });
      state.toolErrorGuardAbortArmed = false;
    }
  });

  pi.on("input", (event: InputEvent) => {
    if (event.source !== "interactive") return;

    const text = String(event.text || "").trim();
    if (!text) return;

    if (state.retryTimers.size > 0 && !state.isFixingType3) {
      logLifecycle("hook_input_manual_intervention", {
        reason: "interactive_input_while_recovery_active",
        detail: text,
      });
      standDown("interactive_input", pi, true);
    }
  });

  // 持续收集 GSD 内部发出的 Notification，作为 stop 时诊断拼接输入
  pi.on("notification", (event: NotificationEvent) => {
    const msg = String(event.message || "");
    const kind = event.kind || "error";

    logLifecycle("hook_notification", {
      reason: kind,
      detail: msg,
    });

    const hasAutoPauseSignal = AUTO_PAUSE_CONTEXT_RE.test(msg);
    const isEscPauseBanner = ESC_PAUSE_BANNER_RE.test(msg);

    if (hasAutoPauseSignal) {
      state.autoPauseSignalArmedForStop = true;
      logLifecycle("auto_pause_signal_observed", {
        reason: kind,
        detail: "armed_for_next_stop_turn",
      });
    }

    if (kind === "blocked" || kind === "error" || kind === "input_needed" || isEscPauseBanner) {
      rememberNotification(msg);
      logLifecycle("notification_stashed", {
        reason: isEscPauseBanner ? `${kind}:escape_pause_banner` : kind,
        detail: `count=${state.lastNotifications.length}`,
      });
    }
  });

  // 拦截核心 Stop 事件
  pi.on("stop", (event: StopEvent) => {
    const reason = event.reason;
    const errorMsg = getStopErrorMessage(event);
    const combinedLog = consumeStopDiagnostics(errorMsg);

    logLifecycle("hook_stop", {
      reason,
      detail: combinedLog || "(empty)",
    });

    if (state.toolErrorGuardAbortArmed && reason !== "cancelled") {
      logLifecycle("tool_error_guard_abort_cleared", {
        retryType: "type1",
        attempt: state.consecutiveToolErrorTurns,
        reason,
        detail: "non_cancelled_stop",
      });
      state.toolErrorGuardAbortArmed = false;
      state.consecutiveToolErrorTurns = 0;
    }

    // Type 3 修复回合结束后自动续跑。
    if (state.isFixingType3 && reason === "completed") {
      state.isFixingType3 = false;
      resetRetries("type3_fix_completed", true);

      const resumeCommand = getResumeCommand();
      pi.sendMessage({
        customType: "system",
        content: "✅ [AutoContinue] Type 3 fix completed outside auto-mode. Resuming auto-mode...",
        display: true,
      });

      scheduleRetryTimer(
        "type3",
        1500,
        {
          phase: "type3_resume",
          attempt: 0,
          reason: "type3_fix_completed",
          detail: resumeCommand,
        },
        () => {
          safeSendUserMessage(pi, resumeCommand, {
            phase: "type3_resume",
            retryType: "type3",
            attempt: 0,
            reason: "type3_fix_completed",
          });
        },
      );
      return;
    }

    if (reason === "completed") {
      standDown("stop:completed", pi, false);
      return;
    }

    if (TOOL_INVOCATION_PASSTHROUGH_RE.test(combinedLog)) {
      handleType0(pi, reason, combinedLog);
      return;
    }

    if (reason === "cancelled") {
      if (state.toolErrorGuardAbortArmed) {
        const guardedAttempts = state.consecutiveToolErrorTurns;

        state.toolErrorGuardAbortArmed = false;
        state.consecutiveToolErrorTurns = 0;

        logLifecycle("tool_error_guard_abort_observed", {
          retryType: "type1",
          attempt: guardedAttempts,
          reason: "tool_error_guard",
          detail: "stop:cancelled",
        });

        scheduleRetryTimer(
          "type1",
          300,
          {
            phase: "tool_error_guard_internal_continue",
            attempt: 0,
            reason: "tool_error_guard",
            detail: "sendUserMessage",
          },
          () => {
            safeSendUserMessage(
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
        return;
      }

      standDown("stop:cancelled", pi, true);
      return;
    }

    if (USER_INTERVENTION_RE.test(combinedLog)) {
      logLifecycle("stop_stand_down_user_intervention", {
        reason,
      });
      standDown("stop:user_intervention_detected", pi, true);
      return;
    }

    const hasAutoPauseSignal = consumeAutoPauseSignalForStop(combinedLog);
    if (!hasAutoPauseSignal && !state.isFixingType3) {
      logLifecycle("stop_passthrough_no_recent_auto_pause", {
        reason,
        detail: "pause_signal_missing_for_this_stop_turn",
      });
      return;
    }

    // ==========================================
    // Decision chain: schema-overload -> network(T1) -> transient(T2) -> fallback(T3)
    // ==========================================

    if (classifyAsSchemaOverload(combinedLog)) {
      handleSchemaOverload(pi, reason, combinedLog);
      return;
    }

    if (NETWORK_RE.test(combinedLog)) {
      handleType1(pi, reason, combinedLog);
      return;
    }

    if (classifyAsType2Provider(combinedLog)) {
      handleType2(pi, reason, combinedLog);
      return;
    }

    handleType3(pi, reason, combinedLog, {
      triggerReason: state.isFixingType3 ? `type3_in_progress:${reason}` : reason,
    });
  });
}
