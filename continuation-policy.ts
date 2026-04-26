export const CONTINUATION_POLICY = {
  maxNotifications: 5,
  withContextMaxAttempts: 10,
  withContextBackoffBaseMs: 1000,
  maxWithContextDelayMs: 60_000,
  maxPreparationErrorTurnsBeforeAbort: 2,
  maxIdenticalToolCallsBeforeAbort: 4,
  resumeCommand: "/gsd auto",
};

type ManualInterventionRule = readonly RegExp[];

export const MANUAL_INTERVENTION_RULES: readonly ManualInterventionRule[] = [
  [/\b(?:stop|backtrack)\b/i, /\bdirective\b/i],
  [/\bqueued\b/i, /\buser message\b/i],
  [/\b(?:manual|human|operator)\b/i, /\b(?:intervention|review|action|input|required|needed)\b/i],
  [/\bpaus(?:e|ed|ing)\b/i, /\b(?:manual|human|operator)\b/i],
  [/\buser\b/i, /\b(?:interruption|interrupted|requested stop|cancelled|canceled)\b/i],
];

export const matchesManualIntervention = (text: string) => {
  const detail = text.trim();
  return detail.length > 0 && MANUAL_INTERVENTION_RULES.some((rule) => rule.every((pattern) => pattern.test(detail)));
};
