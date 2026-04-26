import type { ExtensionAPI, ExtensionContext, InputEvent, NotificationEvent, SessionEndEvent, StopEvent } from "@gsd/pi-coding-agent";
import { CONTINUATION_POLICY, WITHOUT_CONTEXT_STOP_PHRASES, matchesManualIntervention } from "./continuation-policy.ts";
import { createWithContextContinuation, type ToolCallLoopEvent, type ToolResultEvent } from "./with-context-continuation.ts";
import { createWithoutContextRecovery } from "./without-context-recovery.ts";

const includesAny = (text: string, phrases: readonly string[]) =>
  phrases.some((phrase) => text.toLowerCase().includes(phrase));

const stopError = (event: StopEvent) => {
  const lastMessage = event.lastMessage as { errorMessage?: unknown } | undefined;
  return typeof lastMessage?.errorMessage === "string" ? lastMessage.errorMessage : "";
};

export function registerAutoModeStopRouter(pi: ExtensionAPI) {
  const notifications: string[] = [];
  let lastContext: ExtensionContext | undefined;

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const notifyFallback = (content: string, type: "info" | "warning" | "error" = "error") => {
    try {
      lastContext?.ui.notify(content, type);
    } catch {
    }
  };

  const sendSystem = (content: string, type: "info" | "warning" | "error" = "info") => {
    try {
      pi.sendMessage({ customType: "system", content, display: true });
      return true;
    } catch (error) {
      notifyFallback(content, type);
      console.error(`[AutoContinue] Failed to send visible status: ${errorText(error)}`);
      console.error(content);
      return false;
    }
  };

  const reportInternalFailure = (phase: string, error: unknown) => {
    sendSystem(
      `❌ [AutoContinue] Internal failure in ${phase}: ${errorText(error)}. AutoContinue is standing down for this event instead of silently blocking progress.`,
      "error",
    );
  };

  const sendUserMessage = (content: string) => {
    sendSystem("↪️ [AutoContinue] Dispatching recovery prompt.");

    try {
      pi.sendUserMessage(content);
      return;
    } catch (error) {
      sendSystem(`⚠️ [AutoContinue] sendUserMessage failed: ${errorText(error)}. Trying hidden trigger-turn fallback.`, "warning");
    }

    try {
      pi.sendMessage({ customType: "auto-continue-recovery", content, display: false }, { triggerTurn: true });
    } catch (error) {
      reportInternalFailure("sendUserMessage fallback", error);
    }
  };

  const withoutContext = createWithoutContextRecovery({ sendSystem, sendUserMessage });
  const withContext = createWithContextContinuation({
    sendSystem,
    sendUserMessage,
    isWithoutContextRecoveryRunning: () => withoutContext.recovering,
  });

  const drainDetail = (stopDetail: string) => {
    const detail = `${notifications.join(" | ")} ${stopDetail}`.trim();
    notifications.length = 0;
    return detail;
  };

  const rememberNotification = (message: string) => {
    notifications.push(message);
    if (notifications.length > CONTINUATION_POLICY.maxNotifications) notifications.shift();
  };

  const standDown = (notify: boolean) => {
    const wasActive = withContext.standDown() || withoutContext.standDown();
    notifications.length = 0;

    if (notify && wasActive) {
      sendSystem("ℹ️ [AutoContinue] Manual intervention detected. Recovery stopped.");
    }
  };

  const recoveringProgrammatically = () => withContext.active || withoutContext.active;

  const onSafe = (eventName: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => {
    pi.on(eventName as never, async (event: unknown, ctx?: ExtensionContext) => {
      if (ctx) lastContext = ctx;

      try {
        return await handler(event, ctx);
      } catch (error) {
        reportInternalFailure(eventName, error);
        return undefined;
      }
    });
  };

  onSafe("session_end", (event) => {
    const sessionEnd = event as SessionEndEvent;
    if (sessionEnd.reason === "programmatic" && recoveringProgrammatically()) return;
    standDown(false);
  });

  onSafe("session_shutdown", () => standDown(false));

  onSafe("session_start", () => {
    withContext.resetIdenticalToolCallLoop();
  });

  onSafe("agent_end", () => {
    withContext.resetIdenticalToolCallLoop();
  });

  onSafe("tool_call", (event, ctx) => {
    if (!ctx) return undefined;
    return withContext.handleToolCallLoop(event as ToolCallLoopEvent, ctx);
  });

  onSafe("tool_result", (event, ctx) => {
    if (!ctx) return;
    withContext.handleToolResult(event as ToolResultEvent, ctx);
  });

  onSafe("input", (event) => {
    const input = event as InputEvent;
    if (input.source === "interactive" && String(input.text || "").trim()) {
      standDown(true);
    }
  });

  onSafe("notification", (event) => {
    const notification = event as NotificationEvent;
    const message = String(notification.message || "");
    const kind = notification.kind || "error";
    if (kind !== "blocked" && kind !== "error" && kind !== "input_needed" && !message.trim()) return;

    rememberNotification(message);
  });

  onSafe("stop", (event) => {
    const stop = event as StopEvent;
    const detail = drainDetail(stopError(stop));

    if (withoutContext.recovering && stop.reason === "completed") {
      withoutContext.resumeAutoMode();
      return;
    }

    if (stop.reason === "completed") {
      standDown(false);
      return;
    }

    if (withContext.handleProgrammaticAbort()) return;

    if (/\boperation aborted\b/i.test(detail)) {
      standDown(true);
      return;
    }

    if (matchesManualIntervention(detail)) {
      standDown(true);
      return;
    }

    if (includesAny(detail, WITHOUT_CONTEXT_STOP_PHRASES)) {
      withContext.standDown();
      withoutContext.scheduleRecovery(detail || String(stop.reason));
      return;
    }

    if (stop.reason === "cancelled") {
      standDown(true);
      return;
    }

    withoutContext.cancelPending();
    withContext.scheduleRetry("failure", detail || String(stop.reason));
  });
}
