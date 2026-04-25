import type { Diagnostics, LifecycleLogOptions, RuntimeConfig, RuntimeState, UiNotifyLevel } from "./types.ts";

export function createDiagnostics(config: RuntimeConfig, state: RuntimeState): Diagnostics {
  let uiNotify: ((message: string, level?: UiNotifyLevel) => void) | null = null;

  function truncate(text: string, max = 240): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
  }

  function notifyLifecycleUi(payload: Record<string, unknown>): void {
    if (!uiNotify) return;
    uiNotify(`[AutoContinue] ${JSON.stringify(payload)}`, "info");
  }

  return {
    bindUiNotifier(ctx) {
      const maybeUi = (ctx as { ui?: { notify?: unknown } } | undefined)?.ui;
      const maybeNotify = maybeUi?.notify;
      if (typeof maybeNotify !== "function") return;

      uiNotify = (message: string, level: UiNotifyLevel = "info") => {
        try {
          maybeNotify.call(maybeUi, message, level);
        } catch {
          return;
        }
      };
    },

    logLifecycle(
      phase: string,
      {
        retryType = "none",
        attempt = 0,
        reason = "n/a",
        detail,
        delayMs,
        escalation = "none",
      }: LifecycleLogOptions = {},
    ): void {
      const payload: Record<string, unknown> = {
        plugin: config.plugin,
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
    },

    normalizeError(error: unknown): string {
      if (error instanceof Error) return `${error.name}: ${error.message}`;
      return String(error);
    },
  };
}
