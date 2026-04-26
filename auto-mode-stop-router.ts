import type { ExtensionAPI, ExtensionContext, InputEvent, NotificationEvent, SessionEndEvent, StopEvent, ToolExecutionEndEvent } from "@gsd/pi-coding-agent";
import { CONTINUATION_POLICY, matchesManualIntervention } from "./continuation-policy.ts";
import { createWithContextContinuation, type ToolCallLoopEvent, type ToolExecutionEndLoopEvent } from "./with-context-continuation.ts";
import { createWithoutContextRecovery } from "./without-context-recovery.ts";
import { readGsdAutoSnapshot, isContextOverflow } from "./gsd-auto-state.ts";

const stopError = (event: StopEvent) => {
  const lastMessage = event.lastMessage as { errorMessage?: unknown } | undefined;
  return typeof lastMessage?.errorMessage === "string" ? lastMessage.errorMessage : "";
};

export function registerAutoModeStopRouter(pi: ExtensionAPI) {
  const notifications: string[] = [];
  let lastContext: ExtensionContext | undefined;
  let overflowDelegatedToCore = false;

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const notifyFallback = (content: string, type: "info" | "warning" | "error" = "error") => {
    if (!lastContext) {
      console.error(content);
      return false;
    }

    try {
      lastContext.ui.notify(content, type);
      return true;
    } catch (error) {
      console.error(`[AutoContinue] Failed to send visible status: ${errorText(error)}`);
      console.error(content);
      return false;
    }
  };

  const sendSystem = (content: string, type: "info" | "warning" | "error" = "info") => notifyFallback(content, type);

  const reportInternalFailure = (phase: string, error: unknown) => {
    sendSystem(
      `❌ [AutoContinue] Internal failure in ${phase}: ${errorText(error)}. AutoContinue is standing down for this event instead of silently blocking progress.`,
      "error",
    );
  };

  const sendUserMessage = (content: string) => {
    sendSystem("↪️ [AutoContinue] Dispatching recovery prompt.");

    try {
      if (lastContext && !lastContext.isIdle()) {
        sendSystem("ℹ️ [AutoContinue] Agent is already processing. Waiting for the active turn to finish before sending another recovery message.");
        return;
      }
    } catch (error) {
      reportInternalFailure("idle check", error);
      return;
    }

    try {
      pi.sendUserMessage(content);
    } catch (error) {
      sendSystem(`❌ [AutoContinue] sendUserMessage failed visibly: ${errorText(error)}. No hidden recovery turn was dispatched.`, "error");
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
  const resumeCommand = (stepMode: boolean) => (stepMode ? "/gsd next" : CONTINUATION_POLICY.resumeCommand);
  const recoverableGsdPause = (reason: StopEvent["reason"], errorContext: unknown) => reason !== "cancelled" || errorContext !== undefined;
  const isAutoGuardEnabled = (snapshot: Awaited<ReturnType<typeof readGsdAutoSnapshot>>) => snapshot?.active === true;

  const isGsdPaused = (snapshot: Awaited<ReturnType<typeof readGsdAutoSnapshot>>) =>
    snapshot?.paused === true && snapshot.active === false ? snapshot : undefined;

  const isRecoverableGsdStop = (snapshot: Awaited<ReturnType<typeof readGsdAutoSnapshot>>) =>
    snapshot?.active === false &&
    (snapshot.errorContext?.category === "session-failed" || snapshot.errorContext?.category === "timeout");

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

  onSafe("tool_call", async (event, ctx) => {
    if (!ctx) return undefined;
    if (!isAutoGuardEnabled(await readGsdAutoSnapshot())) return undefined;
    return withContext.handleToolCallLoop(event as ToolCallLoopEvent, ctx);
  });

  onSafe("tool_execution_end", async (event, ctx) => {
    if (!ctx) return;
    if (!isAutoGuardEnabled(await readGsdAutoSnapshot())) return;
    withContext.handleToolExecutionEnd(event as ToolExecutionEndLoopEvent & ToolExecutionEndEvent, ctx);
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

  onSafe("stop", async (event) => {
    const stop = event as StopEvent;
    const detail = drainDetail(stopError(stop));

    if (withoutContext.recovering && stop.reason === "completed") {
      overflowDelegatedToCore = false;
      withoutContext.resumeAutoMode();
      return;
    }

    if (stop.reason === "completed") {
      overflowDelegatedToCore = false;
      standDown(false);
      return;
    }

    const gsdSnapshot = await readGsdAutoSnapshot();
    const pausedAuto = isGsdPaused(gsdSnapshot);
    if (pausedAuto && recoverableGsdPause(stop.reason, pausedAuto.errorContext)) {
      withContext.standDown();
      withoutContext.scheduleRecovery(
        pausedAuto.errorContext ? `${pausedAuto.errorContext.category}: ${pausedAuto.errorContext.message}` : detail || String(stop.reason),
        resumeCommand(pausedAuto.stepMode),
      );
      return;
    }

    if (isRecoverableGsdStop(gsdSnapshot)) {
      withContext.standDown();
      withoutContext.scheduleRecovery(
        `${gsdSnapshot.errorContext!.category}: ${gsdSnapshot.errorContext!.message}`,
        resumeCommand(gsdSnapshot.stepMode),
      );
      return;
    }

    if (withContext.handleProgrammaticAbort()) return;

    if (await isContextOverflow(stop.lastMessage, lastContext?.getContextUsage()?.contextWindow)) {
      withContext.standDown();

      if (!overflowDelegatedToCore) {
        overflowDelegatedToCore = true;
        withoutContext.cancelPending();
        sendSystem("ℹ️ [AutoContinue] Context overflow detected. Standing down while Pi core runs its overflow compaction recovery.");
        return;
      }

      withoutContext.scheduleRecovery(detail || "context overflow");
      return;
    }

    overflowDelegatedToCore = false;

    if (/\boperation aborted\b/i.test(detail)) {
      standDown(true);
      return;
    }

    if (matchesManualIntervention(detail)) {
      standDown(true);
      return;
    }

    if (stop.reason === "cancelled") {
      standDown(true);
      return;
    }

    if (gsdSnapshot?.active === true && stop.reason === "error") {
      withoutContext.cancelPending();
      withContext.scheduleRetry("auto_stop_error", detail || "GSD auto-mode stopped with an error before completing the current turn.");
      return;
    }

    withoutContext.cancelPending();
    standDown(false);
  });
}
