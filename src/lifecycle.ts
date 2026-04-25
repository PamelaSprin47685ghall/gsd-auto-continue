import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  NotificationEvent,
  SessionEndEvent,
  StopEvent,
} from "@gsd/pi-coding-agent";
import { getAgentEndErrorMessage, getStopErrorMessage } from "./classifiers.ts";
import type { createRecoveryOperations } from "./recovery.ts";
import { consumeStopDiagnostics, rememberNotification } from "./runtime-state.ts";
import type { ClassifierDependencies, Diagnostics, RuntimeConfig, RuntimeState, ToolErrorTurnEvent } from "./types.ts";

type RecoveryOperations = ReturnType<typeof createRecoveryOperations>;

export interface LifecycleRuntimeContext {
  state: RuntimeState;
  config: RuntimeConfig;
  diagnostics: Diagnostics;
  classifiers: ClassifierDependencies;
  recovery: RecoveryOperations;
}

export function registerLifecycleHooks(pi: ExtensionAPI, runtimeContext: LifecycleRuntimeContext): void {
  const { state, config, diagnostics, classifiers, recovery } = runtimeContext;

  pi.on("session_start", (_event, ctx) => {
    diagnostics.bindUiNotifier(ctx);
    diagnostics.logLifecycle("hook_session_start", { reason: "session_start" });
    pi.sendMessage({
      customType: "system",
      content: "🚀 [AutoContinue] Verbose lifecycle mode enabled. Waiting for stop/error recovery signals...",
      display: true,
    });
  });

  pi.on("session_end", (event: SessionEndEvent) => {
    diagnostics.logLifecycle("hook_session_end", {
      reason: `session_end:${event.reason}`,
      detail: event.sessionFile,
    });

    if (event.reason === "programmatic" && (state.isFixingType3 || state.retryTimers.size > 0)) {
      diagnostics.logLifecycle("session_end_recovery_preserved", {
        reason: "session_end:programmatic",
        detail: "recovery_pipeline_continues_across_session_boundary",
      });
      return;
    }

    recovery.standDown(`session_end:${event.reason}`, false);
  });

  pi.on("session_shutdown", () => {
    diagnostics.logLifecycle("hook_session_shutdown", { reason: "session_shutdown" });
    recovery.standDown("session_shutdown", false);
  });

  pi.on("before_agent_start", (_event: BeforeAgentStartEvent) => {});

  pi.on("agent_end", (event: { messages: unknown[] }) => {
    const errorMessage = getAgentEndErrorMessage(event);
    if (!errorMessage) return;
    if (!classifiers.classifyAsSchemaOverload(errorMessage.toLowerCase())) return;

    const messages = Array.isArray(event.messages) ? event.messages : [];
    const lastMessage = messages[messages.length - 1] as {
      stopReason?: unknown;
      errorMessage?: unknown;
    } | undefined;

    if (!lastMessage || lastMessage.stopReason !== "error") return;

    const rawError = typeof lastMessage.errorMessage === "string" ? lastMessage.errorMessage : "";
    if (classifiers.classifyAsNetwork(rawError)) return;

    const hijackedError = rawError
      ? `${rawError} | fetch failed (schema-overload-transient-hijack)`
      : "fetch failed (schema-overload-transient-hijack)";

    lastMessage.errorMessage = hijackedError;

    diagnostics.logLifecycle("agent_end_schema_overload_hijack", {
      reason: "schema_overload",
      detail: hijackedError,
    });
  });

  pi.on("turn_end", (event: ToolErrorTurnEvent, ctx: ExtensionContext) => {
    recovery.handleToolErrorTurn(event, ctx);
  });

  pi.on("input", (event: InputEvent) => {
    if (event.source !== "interactive") return;

    const text = String(event.text || "").trim();
    if (!text) return;

    if (state.retryTimers.size > 0 && !state.isFixingType3) {
      diagnostics.logLifecycle("hook_input_manual_intervention", {
        reason: "interactive_input_while_recovery_active",
        detail: text,
      });
      recovery.standDown("interactive_input", true);
    }
  });

  pi.on("notification", (event: NotificationEvent) => {
    const message = String(event.message || "");
    const kind = event.kind || "error";

    diagnostics.logLifecycle("hook_notification", {
      reason: kind,
      detail: message,
    });

    const hasAutoPauseSignal = classifiers.hasAutoPauseContext(message);
    const isEscapePauseBanner = classifiers.isEscapePauseBanner(message);

    if (hasAutoPauseSignal) {
      state.autoPauseSignalArmedForStop = true;
      diagnostics.logLifecycle("auto_pause_signal_observed", {
        reason: kind,
        detail: "armed_for_next_stop_turn",
      });
    }

    if (kind === "blocked" || kind === "error" || kind === "input_needed" || isEscapePauseBanner) {
      rememberNotification(state, config, message);
      diagnostics.logLifecycle("notification_stashed", {
        reason: isEscapePauseBanner ? `${kind}:escape_pause_banner` : kind,
        detail: `count=${state.lastNotifications.length}`,
      });
    }
  });

  pi.on("stop", (event: StopEvent) => {
    const errorMessage = getStopErrorMessage(event);
    const combinedLog = consumeStopDiagnostics(state, errorMessage);

    diagnostics.logLifecycle("hook_stop", {
      reason: event.reason,
      detail: combinedLog || "(empty)",
    });

    recovery.handleStop(event, combinedLog);
  });
}
