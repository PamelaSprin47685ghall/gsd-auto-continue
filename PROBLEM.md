# PROBLEM: AutoContinue cannot create a reliable next turn after GSD steals the session

## Summary

`gsd-auto-continue` cannot reliably recover repeated GSD tool schema failures from the extension layer once GSD auto-mode has already decided the unit/session failed. The root problem is not missing retry logic. The root problem is that the intended recovery turn may no longer exist: GSD/Pi can emit failure, abort, mark the unit as failed, and switch/reset the session before AutoContinue can deliver a visible follow-up or normal user message.

## Observed failure

During `plan-slice M008/S04`, the model repeatedly called `gsd_plan_slice` with empty arguments:

```text
gsd_plan_slice({})
Validation failed for tool "gsd_plan_slice":
  - milestoneId: must have required property 'milestoneId'
  - sliceId: must have required property 'sliceId'
  - goal: must have required property 'goal'
  - tasks: must have required property 'tasks'
```

After repeated failures, GSD reported:

```text
Warning: Session creation failed for plan-slice M008/S04: unknown. Stopping auto-mode.
Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.
Operation aborted
Auto-mode stopped — Session creation failed: unknown.
```

AutoContinue had already logged that a recovery follow-up was queued, but no useful recovery turn ran. The queued follow-up did not provide a reliable handoff.

## Why extension-layer recovery is insufficient

AutoContinue tried several extension-level recovery strategies. Each fails for structural reasons.

### `tool_execution_end` is too late

The repeated schema failures are visible to extensions through `tool_execution_end`, but this event is emitted through Pi's session event queue. It is not the synchronous control point that determines whether the agent loop continues.

By the time AutoContinue sees the event, the agent loop may already have:

- appended the failed tool result to context;
- advanced to the next provider request;
- incremented the schema-overload counter;
- produced another bad tool call.

### `followUp` is not a delivery guarantee

`sendUserMessage(..., { deliverAs: "followUp" })` queues a message on the active agent/session. That queue can be made irrelevant by abort/session switching.

When GSD/Pi calls `abort()` or `newSession()` as part of official failure handling, queued follow-ups may be cleared, left behind in the wrong session, or never become the next agent turn.

### `steer` does not reset Pi core's schema counter

Pi core tracks repeated preparation/schema failures inside the agent loop with a local counter similar to:

```ts
let consecutiveAllToolErrorTurns = 0;
```

A steering message does not reset this counter. The counter only resets when a subsequent assistant/tool turn has no preparation errors. If the model emits another invalid `gsd_plan_slice({})`, the official schema-overload path still fires.

### `stop` is already too late

A normal `sendUserMessage()` after `stop` only works if the original session is still intact and idle. In the failing GSD auto-mode path, official GSD handling may already have marked the unit failed and switched/reset the session before AutoContinue can send anything.

At that point AutoContinue can resume `/gsd auto`, but it cannot preserve the original plan-slice turn context. This is the core "session steal" failure.

### `before_provider_request` can influence the next request but cannot solve the root counter/session issue

`before_provider_request` can mutate the payload before the next provider call, but it cannot reset Pi core's local schema-overload counter. It also cannot guarantee the model will stop emitting invalid tool calls. If the model repeats the bad call, official failure still wins.

## Root cause

The missing primitive is a core-level, awaited recovery seam inside Pi's agent loop before schema-overload hard stop and before GSD sees a terminal failed session.

The reliable recovery turn must be created before:

- `agent_end` / `stop` is emitted for the failed unit;
- GSD `runUnit` handles the failure;
- `newSession()` / `agent.reset()` can clear queues or switch context;
- official GSD auto-mode marks the unit/session as failed.

In short:

> AutoContinue cannot create a reliable next turn after GSD has already stolen the session. The next turn must be created inside the current agent loop before GSD gets a terminal failure.

## Correct fix direction

Prefer converting GSD-owned tool validation failures into transport-level successful tool results with semantic failure content.

The distinction matters:

- The tool call transport succeeds from Pi core's perspective.
- The GSD operation does not succeed.
- The tool result tells the model, loudly and explicitly, that the operation did not run and must be retried with valid arguments.

For example, instead of emitting a preparation/tool result that Pi core counts as an error:

```text
Validation failed for tool "gsd_plan_slice": missing required property "tasks"
```

Pi/GSD should return a successful tool message whose content is a hard corrective instruction:

```text
🚨 GSD TOOL CALL DID NOT RUN.

Your previous gsd_plan_slice call was invalid because required arguments were missing:
- milestoneId
- sliceId
- goal
- tasks

This is not a completed planning step. Retry gsd_plan_slice now with the complete payload. Do not call gsd_plan_slice with an empty object.
```

This avoids the schema-overload path without creating a fake GSD success. The model remains in the same session and same unit, sees the failure as normal conversation context, and can repair the next tool call before GSD/Pi marks the unit terminally failed.

The plugin can implement this without modifying `gsd-2` by patching the runtime `Agent` class at extension load time:

1. During `Agent.prompt()` / `Agent.continue()`, check whether GSD auto-mode is currently active.
2. If not active, do nothing.
3. If active, temporarily wrap active `gsd_*` tools for that single agent run.
4. Each wrapper exposes a permissive provider schema so malformed calls reach `execute()` instead of failing during Pi preparation.
5. Inside `execute()`, validate against the original runtime `tool.parameters` with the installed GSD runtime's own `validateToolArguments()`.
6. If validation passes, call the original tool with validated arguments.
7. If validation fails, return the semantic failure result as a normal tool result.
8. Restore the original tools when the run exits.

This keeps the fix in the plugin while still moving the recovery point before Pi's schema-overload counter increments.

The wrapper must not hardcode any `gsd_*` schema fields. It should only use the current runtime tool object's `parameters`, so upstream GSD tool schema changes are naturally picked up without plugin code changes.

Conceptually:

```ts
if (isGsdTool(toolName) && validationFailed) {
  return {
    toolCall,
    result: {
      isError: false,
      content: [{ type: "text", text: renderScaryGsdValidationFailure(toolName, validationIssues) }],
    },
  };
}
```

A correct implementation should ensure:

- only `gsd_*` tools get this treatment;
- only while GSD auto-mode is active;
- ordinary tools still fail normally;
- no GSD DB/state mutation occurs for invalid calls;
- the message says the GSD operation did not run;
- validation uses the current runtime tool schema, not hardcoded field names;
- repeated invalid GSD calls are still capped by a GSD-specific retry limit;
- if the plugin cannot find the required runtime patch points, it fails open with a visible diagnostic.

A broader Pi core recovery hook at the schema-overload risk point is still viable, but it is heavier than the semantic-failure tool-result approach. The important behavior is keeping recovery inside the same `runLoop`, `AgentSession`, and GSD unit before GSD official auto-mode sees a terminal failure.

## Desired recovery policy

For this specific failure class:

- Trigger only for GSD-owned tool preparation/schema failures, such as `gsd_plan_slice({})`.
- Do not take over ordinary tool validation failures like malformed `lsp` calls.
- Return a transport-successful tool result with explicit semantic failure content, for example:

```text
🚨 GSD TOOL CALL DID NOT RUN.

The previous gsd_plan_slice call failed validation before execution. This is not a completed GSD operation. No GSD DB/state changes were made. Read the validation problem below, then retry the same tool with a complete valid payload.
```

- Do not hardcode schema-specific recovery instructions; surface the current validator output so upstream schema changes are handled automatically.
- Limit retries to avoid infinite recovery loops.
- If semantic-failure recovery fails repeatedly, allow the official hard stop path to proceed visibly.

## Non-solutions

Do not rely on these as the primary fix:

- `sendUserMessage()` after `stop`;
- `followUp` before abort;
- `steer` alone;
- hidden `triggerTurn` messages;
- UI string matching for pause/recovery detection;
- broad recovery for every `stop.reason === "error"`;
- changing ordinary non-GSD tool validation behavior;
- marking the GSD operation itself as successful when validation failed.

## Implication for `gsd-auto-continue`

`gsd-auto-continue` can still handle recoverable outer-loop failures, visible retries, and GSD paused-state recovery. It should not pretend it can solve this specific session-steal problem purely from extension hooks.

The fix is implemented in the plugin by temporarily wrapping runtime `gsd_*` tools during active GSD auto-mode runs. It does not require editing `gsd-2` files, and it is resilient to upstream `gsd_*` schema changes because it reuses the live tool schema and live GSD validator.
