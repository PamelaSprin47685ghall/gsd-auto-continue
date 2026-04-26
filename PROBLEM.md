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

Add a Pi core or GSD core recovery hook at the schema-overload risk point, before the hard stop. Conceptually:

```ts
if (consecutiveAllToolErrorTurns >= MAX_CONSECUTIVE_VALIDATION_FAILURES) {
  const recovery = await config.onSchemaOverloadRisk?.({
    consecutiveAllToolErrorTurns,
    message,
    toolResults,
    context: currentContext,
  });

  if (recovery?.messages?.length) {
    stream.push({ type: "turn_end", message, toolResults });
    pendingMessages = recovery.messages;
    consecutiveAllToolErrorTurns = 0;
    continue;
  }

  hardStop();
}
```

The important behavior is `continue`, not `agent_end` / `stop`.

A correct implementation should ensure the recovery message runs:

- in the same `runLoop`;
- in the same `AgentSession`;
- in the same GSD unit;
- before GSD official auto-mode sees a terminal failure;
- with the schema-overload counter reset or explicitly moved into a recovery state.

## Desired recovery policy

For this specific failure class:

- Trigger only for GSD-owned tool preparation/schema failures, such as `gsd_plan_slice({})`.
- Do not take over ordinary tool validation failures like malformed `lsp` calls.
- Inject a visible, explicit recovery message into the next in-loop turn, for example:

```text
The previous GSD tool call failed before execution because required parameters were missing. Retry the same planning operation now with a complete gsd_plan_slice payload. Do not call gsd_plan_slice with an empty object. Include milestoneId, sliceId, goal, and tasks.
```

- Limit retries to avoid infinite recovery loops.
- If in-loop recovery fails, allow the official hard stop path to proceed visibly.

## Non-solutions

Do not rely on these as the primary fix:

- `sendUserMessage()` after `stop`;
- `followUp` before abort;
- `steer` alone;
- hidden `triggerTurn` messages;
- UI string matching for pause/recovery detection;
- broad recovery for every `stop.reason === "error"`;
- changing ordinary non-GSD tool validation behavior.

## Implication for `gsd-auto-continue`

`gsd-auto-continue` can still handle recoverable outer-loop failures, visible retries, and GSD paused-state recovery. It should not pretend it can solve this specific session-steal problem purely from extension hooks.

The fix belongs in `gsd-2` / Pi core, or in an explicit GSD-core hook that runs before Pi core emits terminal failure for repeated preparation/schema errors.
