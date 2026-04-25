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

type ManagedMode = "inactive" | "auto" | "step";
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
  mode: ManagedMode;
  lastNotifications: string[];
  type1Retries: number;
  type2Retries: number;
  type3Retries: number;
  isFixingType3: boolean;
  retryTimers: Map<ManagedRetryType, ScheduledRetryTimer>;
}

const PLUGIN = "gsd-auto-continue";
const MAX_NOTIFICATIONS = 5;
const RETRY_LIMITS = {
  type1: 10,
  type2: 5,
  type3: 3,
} as const;

const AUTO_MODE_STARTED_RE = /\bauto-mode (started|resumed)\b/i;
const STEP_MODE_STARTED_RE = /\bstep-mode (started|resumed)\b/i;
const ESC_PAUSE_BANNER_RE = /\b(?:auto|step)-mode paused \(escape\)\b/i;

const USER_INTERVENTION_RE =
  /stop directive detected|queued user message interrupted|manual intervention|paused \(escape\)/i;

const TYPE3_RE =
  /pre-execution checks (failed|error)|post-execution checks failed|verification gate failed|needs-remediation|blocking progression|unresolved code conflicts|pre-dispatch health check failed|reconciliation failed/i;

const TYPE2_RE =
  /context overflow|auto-compaction failed|empty-turn recovery|rate.?limit|429|quota|unauthorized|overloaded|500|502|503/i;

const TOOL_INVOCATION_PASSTHROUGH_RE =
  /tool invocation failed|structured argument generation failed|validation failed for tool/i;

const NETWORK_RE = /network|timeout|econnreset|socket|fetch failed|stream idle/i;

const state: RuntimeState = {
  mode: "inactive",
  lastNotifications: [],
  type1Retries: 0,
  type2Retries: 0,
  type3Retries: 0,
  isFixingType3: false,
  retryTimers: new Map(),
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
    mode: state.mode,
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

function resetRetries(reason: string, forceLog = false): void {
  resetRetryCount("type1", reason, forceLog);
  resetRetryCount("type2", reason, forceLog);
  resetRetryCount("type3", reason, forceLog);
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

function transitionMode(next: ManagedMode, reason: string): void {
  if (state.mode === next) {
    logLifecycle("mode_noop", { reason, detail: `mode=${next}` });
    return;
  }

  const previous = state.mode;
  state.mode = next;

  logLifecycle("mode_transition", {
    reason,
    detail: `${previous} -> ${next}`,
  });

  if (next === "inactive") {
    state.isFixingType3 = false;
    cancelAllRetryTimers(`${reason}:inactive`);
    state.lastNotifications = [];
    resetRetries(`${reason}:inactive`, true);
    return;
  }

  cancelAllRetryTimers(`${reason}:active_boundary`);
  state.lastNotifications = [];
  resetRetries(`${reason}:active`, true);
}

function standDown(reason: string, pi: ExtensionAPI, notify = false): void {
  const wasActive = state.mode !== "inactive" || state.isFixingType3;
  transitionMode("inactive", reason);

  if (notify && wasActive) {
    pi.sendMessage({
      customType: "system",
      content: "ℹ️ [AutoContinue] User/manual intervention detected. Auto-recovery stood down.",
      display: true,
    });
  }
}

function parseModeFromCommand(text: string): ManagedMode | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/gsd")) return undefined;

  if (/^\/gsd\s+next\b/i.test(trimmed) || /^\/gsd\s+step\b/i.test(trimmed)) {
    return "step";
  }

  if (/^\/gsd\s+auto\b/i.test(trimmed)) {
    // Defensive parsing: support accidental "--step" usage as step intent.
    if (/\s--step\b/i.test(trimmed)) return "step";
    return "auto";
  }

  return undefined;
}

function resumeCommandForMode(mode: ManagedMode): string {
  return mode === "step" ? "/gsd next" : "/gsd auto";
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

function classifyAsType3(reason: StopEvent["reason"], combinedLog: string): boolean {
  return reason === "blocked" || TYPE3_RE.test(combinedLog);
}

function classifyAsType2(combinedLog: string): boolean {
  return TYPE2_RE.test(combinedLog);
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

  const prompt = `Auto-mode was paused due to a blocking issue or failed verification:\n\n${diagnosis}\n\nPlease diagnose and fix this specific issue. Use the necessary tools (e.g., edit files, resolve git conflicts, fix tests or adjust the plan). I will resume auto/step mode automatically once you finish this turn. Do not ask for confirmation.`;

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

  if (state.retryTimers.has("type2")) {
    logLifecycle("type2_retry_pending", {
      retryType: "type2",
      attempt: state.type2Retries,
      reason: stopReason,
      detail: "timer_already_scheduled",
    });
    return;
  }

  const resumeCommand = resumeCommandForMode(state.mode);

  if (state.type2Retries < RETRY_LIMITS.type2) {
    state.type2Retries += 1;

    const attempt = state.type2Retries;
    piApi.sendMessage({
      customType: "system",
      content: `⚠️ [AutoContinue] Provider/Syntax error. Type 2 restart in 5s (Attempt ${attempt}/${RETRY_LIMITS.type2})...`,
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

        const resumeCommand = resumeCommandForMode(state.mode);
        safeSendUserMessage(piApi, resumeCommand, {
          phase: "type1_retry_fallback",
          retryType: "type1",
          attempt,
          reason: `${reason}:retry_last_turn_fallback`,
        });
      },
    );
    return;
  }

  resetRetryCount("type1", "type1_exhausted", true);

  const resumeCommand = resumeCommandForMode(state.mode);
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
      content: "🚀 [AutoContinue] Verbose lifecycle mode enabled. Waiting for auto/step-mode boundaries...",
      display: true,
    });
  });

  pi.on("session_end", (event: SessionEndEvent) => {
    logLifecycle("hook_session_end", {
      reason: `session_end:${event.reason}`,
      detail: event.sessionFile,
    });
    standDown(`session_end:${event.reason}`, pi, false);
  });

  pi.on("session_shutdown", () => {
    logLifecycle("hook_session_shutdown", { reason: "session_shutdown" });
    standDown("session_shutdown", pi, false);
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    const modeFromPrompt = parseModeFromCommand(event.prompt || "");
    if (!modeFromPrompt) return;

    transitionMode(modeFromPrompt, `before_agent_start:${modeFromPrompt}`);
  });

  pi.on("input", (event: InputEvent) => {
    if (event.source !== "interactive") return;

    const text = String(event.text || "").trim();
    if (!text) return;

    const modeCommand = parseModeFromCommand(text);
    if (modeCommand) return;

    if (state.mode !== "inactive" && !state.isFixingType3) {
      logLifecycle("hook_input_manual_intervention", {
        reason: "interactive_input_while_mode_active",
        detail: text,
      });
      standDown("interactive_input", pi, true);
    }
  });

  // 持续收集 GSD 内部发出的 Notification，以精准捕获 pauseAuto 的原因
  pi.on("notification", (event: NotificationEvent) => {
    const msg = String(event.message || "");
    const kind = event.kind || "error";

    logLifecycle("hook_notification", {
      reason: kind,
      detail: msg,
    });

    if (AUTO_MODE_STARTED_RE.test(msg)) {
      transitionMode("auto", "notification:auto_started_or_resumed");
      return;
    }

    if (STEP_MODE_STARTED_RE.test(msg)) {
      transitionMode("step", "notification:step_started_or_resumed");
      return;
    }

    // Stop/cancel/retry decisions must be based on the structured stop reason.
    // Notification text like "auto-mode paused" can appear on non-manual failures,
    // so we only use it as diagnostics and wait for the stop hook classification.

    const isEscPauseBanner = ESC_PAUSE_BANNER_RE.test(msg);

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

    // Type 3 修复回合结束，按进入时模式恢复。
    if (state.isFixingType3 && reason === "completed") {
      state.isFixingType3 = false;
      resetRetries("type3_fix_completed", true);

      const resumeCommand = resumeCommandForMode(state.mode);
      pi.sendMessage({
        customType: "system",
        content: `✅ [AutoContinue] Type 3 fix completed. Resuming ${state.mode === "step" ? "Step" : "Auto"}-mode...`,
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
      // GSD 正常完成当前自动化阶段，退出托管模式。
      standDown("stop:completed", pi, false);
      return;
    }

    if (TOOL_INVOCATION_PASSTHROUGH_RE.test(combinedLog)) {
      // 工具参数/调用失败由核心 auto-loop 处理，这里不做 Type 分类或强行接管。
      logLifecycle("stop_passthrough_tool_invocation", {
        reason,
        detail: combinedLog || "(empty)",
      });
      return;
    }

    if (reason === "cancelled") {
      // 取消通常意味着人工介入或显式中止，直接撤防。
      standDown("stop:cancelled", pi, true);
      return;
    }

    if (state.mode === "inactive") {
      logLifecycle("stop_ignored", {
        reason,
        detail: "mode_inactive",
      });
      return;
    }

    // Exclude: 用户主动介入 (绝不恢复)
    if (USER_INTERVENTION_RE.test(combinedLog)) {
      logLifecycle("stop_stand_down_user_intervention", {
        reason,
      });
      standDown("stop:user_intervention_detected", pi, true);
      return;
    }

    // ==========================================
    // Type 3: State Corruption / Code Blocker
    // ==========================================
    if (state.isFixingType3 || classifyAsType3(reason, combinedLog)) {
      handleType3(pi, reason, combinedLog, {
        triggerReason: state.isFixingType3 ? `type3_in_progress:${reason}` : reason,
      });
      return;
    }

    // ==========================================
    // Type 2: Provider / Context / LLM Syntax
    // ==========================================
    if (classifyAsType2(combinedLog)) {
      handleType2(pi, reason, combinedLog);
      return;
    }

    // ==========================================
    // Type 1: Network Transient / Timeout
    // ==========================================
    handleType1(pi, reason, combinedLog);
  });
}
