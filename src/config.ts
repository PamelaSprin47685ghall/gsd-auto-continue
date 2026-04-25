import type { RuntimeConfig } from "./types.ts";

export const ESC_PAUSE_BANNER_RE = /\b(?:auto|step)-mode paused \(escape\)\b/i;
export const USER_INTERVENTION_RE = /stop directive detected|queued user message interrupted|manual intervention/i;
export const TYPE2_PROVIDER_SIGNAL_RE = /\bprovider error\b|\brate limited\b|\bserver error \(transient\)(?=$|[^a-z0-9_])/i;
export const TOOL_INVOCATION_PASSTHROUGH_RE = /^(?!.*(?:exceeded cap|consecutive)).*(?:tool invocation failed|structured argument generation failed|validation failed for tool)/i;
export const SCHEMA_OVERLOAD_RE = /schema overload|consecutive tool validation failures exceeded cap|consecutive turns with all tool calls failing/i;
export const AUTO_PAUSE_CONTEXT_RE = /(?:auto|step)-mode paused|paused \(escape\)/i;
export const NETWORK_RE = /network|timeout|econnreset|socket|fetch failed|stream idle/i;

export function createRuntimeConfig(): RuntimeConfig {
  const parsedSchemaOverloadMaxRetries = Number.parseInt(
    process.env.GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES || "0",
    10,
  );

  return {
    plugin: "gsd-auto-continue",
    maxNotifications: 5,
    retryLimits: {
      type1: 10,
      type2: 5,
      type3: 3,
    },
    schemaOverloadRetryDelayMs: 1500,
    schemaOverloadMaxRetries:
      Number.isFinite(parsedSchemaOverloadMaxRetries) && parsedSchemaOverloadMaxRetries > 0
        ? parsedSchemaOverloadMaxRetries
        : 0,
    maxToolErrorsBeforeAbort: 2,
  };
}
