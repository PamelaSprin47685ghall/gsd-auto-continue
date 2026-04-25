export const CONTINUATION_POLICY = {
  maxNotifications: 5,
  withContextMaxAttempts: 10,
  withContextBackoffBaseMs: 1000,
  maxWithContextDelayMs: 60_000,
  maxToolErrorsBeforeAbort: 2,
  resumeCommand: "/gsd auto",
};

export const WITHOUT_CONTEXT_STOP_PHRASES = ["auto-mode paused", "step-mode paused", "paused (escape)"];

export const MANUAL_INTERVENTION_PHRASES = [
  "stop directive detected",
  "queued user message interrupted",
  "manual intervention",
  "user interruption",
  "operator intervention",
];
