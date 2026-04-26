import type { ExtensionAPI, InputEvent, NotificationEvent, SessionEndEvent, StopEvent } from "@gsd/pi-coding-agent";
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

  const sendSystem = (content: string) => {
    pi.sendMessage({ customType: "system", content, display: true });
  };

  const sendUserMessage = (content: string) => {
    try {
      pi.sendUserMessage(content);
    } catch {
      const sendMessage = (pi as { sendMessage?: unknown }).sendMessage;
      if (typeof sendMessage === "function") {
        sendMessage.call(pi, { customType: "auto-continue-recovery", content, display: false }, { triggerTurn: true });
      }
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

  pi.on("session_end", (event: SessionEndEvent) => {
    if (event.reason === "programmatic" && recoveringProgrammatically()) return;
    standDown(false);
  });

  pi.on("session_shutdown", () => standDown(false));

  pi.on("session_start", () => {
    withContext.resetIdenticalToolCallLoop();
  });

  pi.on("agent_end", () => {
    withContext.resetIdenticalToolCallLoop();
  });

  pi.on("tool_call", (event: ToolCallLoopEvent, ctx) => withContext.handleToolCallLoop(event, ctx));

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    withContext.handleToolResult(event, ctx);
  });

  pi.on("input", (event: InputEvent) => {
    if (event.source === "interactive" && String(event.text || "").trim()) {
      standDown(true);
    }
  });

  pi.on("notification", (event: NotificationEvent) => {
    const message = String(event.message || "");
    const kind = event.kind || "error";
    if (kind !== "blocked" && kind !== "error" && kind !== "input_needed" && !message.trim()) return;

    rememberNotification(message);
  });

  pi.on("stop", (event: StopEvent) => {
    const detail = drainDetail(stopError(event));

    if (withoutContext.recovering && event.reason === "completed") {
      withoutContext.resumeAutoMode();
      return;
    }

    if (event.reason === "completed") {
      standDown(false);
      return;
    }

    if (withContext.handleProgrammaticAbort()) return;

    if (event.reason === "cancelled") {
      standDown(true);
      return;
    }

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
      withoutContext.scheduleRecovery(detail || String(event.reason));
      return;
    }

    withoutContext.cancelPending();
    withContext.scheduleRetry("failure", detail || String(event.reason));
  });
}
