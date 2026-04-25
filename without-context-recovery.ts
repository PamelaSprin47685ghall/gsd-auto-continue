import { CONTINUATION_POLICY } from "./continuation-policy.ts";

type WithoutContextRecoveryOptions = {
  sendSystem(content: string): void;
  sendUserMessage(content: string): void;
};

export function createWithoutContextRecovery({ sendSystem, sendUserMessage }: WithoutContextRecoveryOptions) {
  let loops = 0;
  let recovering = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    get recovering() {
      return recovering;
    },

    get active() {
      return recovering || timer !== null || loops > 0;
    },

    cancelPending() {
      const wasActive = recovering || timer !== null;
      recovering = false;
      cancelTimer();
      return wasActive;
    },

    standDown() {
      const wasActive = this.active;
      loops = 0;
      recovering = false;
      cancelTimer();
      return wasActive;
    },

    scheduleRecovery(detail: string) {
      if (timer) return;

      const loop = ++loops;
      recovering = true;
      sendSystem(`🚨 [AutoContinue] Auto-mode paused. Starting without-context recovery loop ${loop}.`);

      timer = setTimeout(() => {
        timer = null;
        sendUserMessage(
          `Auto-mode stopped after the official engine exited auto-mode.\n\nFailure detail:\n${detail}\n\nWithout-context recovery loop: ${loop}/unlimited.\n\nDiagnose and fix the root cause without asking for confirmation. When this recovery turn completes, AutoContinue will resume auto-mode.`,
        );
      }, 2000);
    },

    resumeAutoMode() {
      recovering = false;
      sendSystem("✅ [AutoContinue] Without-context recovery completed. Resuming /gsd auto.");

      timer = setTimeout(() => {
        timer = null;
        sendUserMessage(CONTINUATION_POLICY.resumeCommand);
      }, 1500);
    },
  };
}
