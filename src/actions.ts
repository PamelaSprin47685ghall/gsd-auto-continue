import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { ActionDependencies, Diagnostics, EscalationType, ManagedRetryType } from "./types.ts";

export function createActionDependencies(diagnostics: Diagnostics): ActionDependencies {
  return {
    safeSendUserMessage(
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
        diagnostics.logLifecycle(`${phase}_send_user_message_failed`, {
          retryType,
          attempt,
          reason,
          escalation,
          detail: diagnostics.normalizeError(error),
        });
      }

      const maybeSendMessage = (piApi as { sendMessage?: unknown }).sendMessage;
      if (typeof maybeSendMessage !== "function") {
        diagnostics.logLifecycle(`${phase}_trigger_turn_unavailable`, {
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
        diagnostics.logLifecycle(`${phase}_trigger_turn_called`, {
          retryType,
          attempt,
          reason,
          escalation,
          detail: "fallback_sendMessage_triggerTurn",
        });
        return true;
      } catch (error) {
        diagnostics.logLifecycle(`${phase}_trigger_turn_failed`, {
          retryType,
          attempt,
          reason,
          escalation,
          detail: diagnostics.normalizeError(error),
        });
        return false;
      }
    },

    safeRetryLastTurn(
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
        diagnostics.logLifecycle(`${phase}_retry_last_turn_unavailable`, {
          retryType,
          attempt,
          reason: `${reason}:retryLastTurn_missing`,
        });
        return false;
      }

      try {
        maybeRetry.call(piApi);
        diagnostics.logLifecycle(`${phase}_retry_last_turn_called`, {
          retryType,
          attempt,
          reason,
        });
        return true;
      } catch (error) {
        diagnostics.logLifecycle(`${phase}_retry_last_turn_failed`, {
          retryType,
          attempt,
          reason,
          detail: diagnostics.normalizeError(error),
        });
        return false;
      }
    },
  };
}
