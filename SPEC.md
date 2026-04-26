# GSD Auto Continue Specification

## Overview
`gsd-auto-continue` is an extension for the Pi/GSD coding agent. Its primary purpose is to keep `auto-mode` moving after recoverable stops by intercepting engine events, determining the cause of the stop, and programmatically resuming execution via two distinct recovery strategies: **With-Context Continuation** and **Without-Context Recovery**.

It also implements preemptive guards against tool-call loops and schema validation failures, and uses a runtime monkey-patch to expose tool validation errors directly to the LLM instead of crashing the core agent.

## Architecture

The plugin is structured around three main pillars:
1. **Event Router (`auto-mode-stop-router.ts`)**: Listens to core Pi events (`stop`, `tool_call`, `tool_execution_end`, `notification`, `unit_start`, `unit_end`, etc.) and routes them to the appropriate recovery handler or state tracker.
2. **Recovery Handlers**:
   - `With-Context Continuation`: Retries the failed operation in the current conversational context.
   - `Without-Context Recovery`: Starts a new conversational turn to diagnose and fix a failed auto-mode state, then issues the command to resume auto-mode.
3. **Semantic Validation Patch (`semantic-gsd-validation.ts`)**: Monkey-patches the Pi core `Agent.prototype.prompt` and `continue` methods to catch tool argument validation errors and feed them back to the LLM as text, preventing core interruptions.

---

## 1. Event Routing and State Management

### 1.1 Local Run State (`local-gsd-auto-state.ts`)
Tracks whether auto-mode is active.
- **`unit_start`**: Sets `active = true`, records if it's `stepMode` (`unitType === "step"`).
- **`unit_end`**: Sets `active = false`. If the status is `"failed"` or `"blocked"`, stores a `recoverable` object with a category and message.
- **`session_start`**: Resets all state.

### 1.2 Notifications Drain
- Subscribes to `notification` events.
- Maintains a rolling buffer of the last 5 error/blocked notifications (ignoring empty ones).
- When a `stop` event occurs, drains this buffer and joins it with the `stop` event's error message to form a detailed `detail` string for recovery prompts.

### 1.3 Stop Event Handling
When a `stop` event is received:
1. **Completion Check**: If `stop.reason === "completed"`:
   - If currently in a without-context recovery loop, triggers `resumeAutoMode()`.
   - Otherwise, stands down (cancels all timers/state).
2. **Unit Failure Check**: If `localState.recoverable` is set, triggers a **Without-Context Recovery** with the detail, clearing the state.
3. **Programmatic Abort Check**: If `withContext.handleProgrammaticAbort()` returns true (an abort we triggered internally), it proceeds with the scheduled retry.
4. **Manual Intervention Check**: Checks the detail string against `MANUAL_INTERVENTION_RULES` (e.g., user typing "stop", "pause", "manual intervention required"). If matched, stands down completely.
5. **Context Overflow Check**: Imports `overflow.js` from Pi core. If `isContextOverflow(lastMessage)`, it delegates to core for the first occurrence, and triggers **Without-Context Recovery** on the second occurrence.
6. **Blocked/Error Stop Check**: 
   - If `stop.reason === "blocked"`, triggers **Without-Context Recovery**.
   - If `stop.reason === "error"`, triggers **With-Context Continuation**.
7. **Fallback**: Stands down.

---

## 2. Recovery Strategies

### 2.1 With-Context Continuation (`with-context-continuation.ts`)
Used for transient errors and programmatic aborts during a turn. It schedules a retry by sending a system notification and then a user message via `pi.sendUserMessage()`.

- **Retry Limit**: Max 10 attempts.
- **Backoff**: Exponential, starting at 1000ms base up to 60000ms max.
- **Prompt**: 
  ```text
  Continue from the current context. The previous turn failed ({reason}):
  
  {detail}
  
  Retry only the failed operation. If tool arguments were invalid, regenerate valid arguments. Do not restart /gsd auto.
  ```

#### 2.1.1 Tool Call Loop Guards
Intercepts `tool_call` and `tool_execution_end` events.
- **Identical Tool Calls**: Hashes the `toolName` and normalized `input` arguments. If a tool (other than `ask_user_questions`) is called with identical arguments 4 times consecutively, it calls `ctx.abort()` and arms an abort reason `"identical_tool_call_guard"`.
- **Preparation/Schema Errors**: Tracks consecutive tool executions where `isError === true` due to validation failures or "semantic failures". If it hits 2 consecutive preparation errors, it calls `ctx.abort()` and arms an abort reason `"tool_schema_guard"`.

When `ctx.abort()` fires, it triggers a `stop` event, which the router identifies as a programmatic abort and routes back to the `With-Context Continuation` to issue a retry prompt advising the LLM to fix its tool arguments.

### 2.2 Without-Context Recovery (`without-context-recovery.ts`)
Used when auto-mode exits completely (e.g., blocked or unit failed).

- **Behavior**: Sends a user message that starts a diagnostic loop.
- **Prompt**:
  ```text
  Auto-mode stopped after the official engine exited auto-mode.

  Failure detail:
  {detail}

  Without-context recovery loop: {loop}/unlimited.

  Diagnose and fix the root cause without asking for confirmation. When this recovery turn completes, AutoContinue will resume auto-mode.
  ```
- **Resumption**: When the engine finishes this recovery turn (emits `stop` with `reason: "completed"`), it waits 1.5s and sends `/gsd auto` (or `/gsd next` if in step mode).

---

## 3. Semantic Validation Patch (`semantic-gsd-validation.ts`)

To prevent core Pi interruptions from invalid tool schemas (which hard-crash the loop after 3 attempts), this module monkey-patches `Agent.prototype.prompt` and `continue`.

- **Condition**: Only applies if `isLocalGsdAutoActive()` is true or if the first argument has `customType === "gsd-auto"`.
- **Wrapping**: Wraps all tools starting with `gsd_`.
- **Validation**: 
  - Normalizes JSON-encoded arrays/objects in arguments.
  - Invokes Pi core's `validateToolArguments`.
  - Checks conditional requirements (e.g., fields marked "required for full slices" must not be empty unless `isSketch === true`).
- **Failure Injection**: 
  - If validation fails, it catches the error and **returns a successful result object to the LLM** with the text:
    ```text
    🚨 GSD TOOL CALL DID NOT RUN.
    
    The previous {toolName} call failed validation before execution. This is a semantic failure result, not a successful GSD operation. No GSD DB/state changes were made.
    
    Validation problem:
    {summary}
    
    Retry {toolName} now with a complete, valid payload...
    ```
  - It tags the result details with `{ semanticFailure: true }`. This tag is read by the **Preparation Error Guard** in the `With-Context Continuation` logic.
- **Provider Passthrough**: Exposes original unpatched schemas to the LLM provider `streamFn` so the LLM sees the correct original JSON schema, but the wrapped `execute` function handles validation.

---

## 4. Configuration and Constants (`continuation-policy.ts`)

| Policy | Value | Description |
|---|---|---|
| `maxNotifications` | 5 | Max previous notifications to store for detail strings. |
| `withContextMaxAttempts` | 10 | Max retry loops inside a single context. |
| `withContextBackoffBaseMs`| 1000 | Base for exponential backoff calculation. |
| `maxWithContextDelayMs` | 60000 | Cap for exponential backoff. |
| `maxPreparationErrorTurnsBeforeAbort` | 2 | Max validation errors before `ctx.abort()` is called. |
| `maxIdenticalToolCallsBeforeAbort` | 4 | Max identical tool calls before `ctx.abort()` is called. |
| `resumeCommand` | `"/gsd auto"` | Command to send to resume after without-context recovery. |

### Manual Intervention Rules
RegEx patterns checked against the stop detail. If *all* regexes in any array match, intervention is manual and recovery stands down.
- `\b(?:stop|backtrack)\b` AND `\bdirective\b`
- `\bqueued\b` AND `\buser message\b`
- `\b(?:manual|human|operator)\b` AND `\b(?:intervention|review|action|input|required|needed)\b`
- `\bpaus(?:e|ed|ing)\b` AND `\b(?:manual|human|operator)\b`
- `\buser\b` AND `\b(?:interruption|interrupted|requested stop|cancelled|canceled)\b`

---

## 5. Fallbacks and System Messages
- `notifyFallback`: Tries `ctx.ui.notify(content, type)`. If it fails, falls back to `console.error`.
- Internal extension errors during event handling are caught, logged via `notifyFallback` as `"error"`, and the extension stands down to prevent silent blocking.
