import type { RuntimeConfig } from "./types.ts";

export const TYPE1_SIGNAL_PHRASES = [
  "econnreset",
  "fetch failed",
  "stream_exhausted_without_result",
  "stream_exhausted",
  "stream idle timeout",
  "partial response received",
  "rate limit",
  "rate limited",
  "429",
  "503",
  "api overload",
  "api overloaded",
  "overloaded",
  "json syntax",
  "invalid json",
  "syntaxerror",
  "unterminated string in json",
  "expected property name or",
  "tool invocation failed",
  "structured argument generation failed",
  "validation failed for tool",
  "schema overload",
  "consecutive tool validation failures exceeded cap",
  "consecutive turns with all tool calls failing",
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
