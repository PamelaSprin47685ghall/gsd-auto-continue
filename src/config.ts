import type { RuntimeConfig } from "./types.ts";

export const OFFICIAL_AUTO_EXIT_PHRASES = [
  "auto-mode paused",
  "step-mode paused",
  "paused (escape)",
] as const;

export const MANUAL_INTERVENTION_PHRASES = [
  "stop directive detected",
  "queued user message interrupted",
  "manual intervention",
  "user interruption",
  "operator intervention",
] as const;

export function createRuntimeConfig(): RuntimeConfig {
  return {
    plugin: "gsd-auto-continue",
    maxNotifications: 5,
    type1MaxAttempts: 10,
    type1BackoffBaseMs: 1000,
    maxType1DelayMs: 60_000,
    maxToolErrorsBeforeAbort: 2,
    resumeCommand: "/gsd auto",
  };
}
