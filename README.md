# GSD Auto Continue

A robust error-recovery extension for GSD that keeps `auto-mode` moving. It classifies failures into three tiers and adds a dedicated schema-overload continuation path so core guardrails do not permanently kill automation.

## 🚀 Recovery Tiers

### Type 1: Network Transient / Timeout
*   **Symptoms**: `ECONNRESET`, `fetch failed`, idle watchdogs, or hard timeouts.
*   **Strategy**: Exponential backoff (2s to 30s) with in-place retry.
*   **Limit**: 10 attempts.
*   **Scope**: Active in both `auto` and `manual` modes.

### Type 2: Provider / Syntax / Context
*   **Symptoms**: Rate limits (429), API overloads (503), context overflows, or LLM-generated JSON syntax errors.
*   **Strategy**: 5-second cooldown followed by `/gsd auto` to refresh the execution context.
*   **Limit**: 5 attempts.

### Type 3: State Corruption / Logic Blocker
*   **Symptoms**: Failed pre/post-execution checks, verification gate failures, UAT blocks, or git conflicts.
*   **Strategy**: Escalates to the LLM with a diagnostic prompt. The agent is instructed to fix the root cause (e.g., edit files, resolve conflicts). Auto-mode resumes automatically once the fix turn completes.
*   **Limit**: 3 attempts.

### Schema-Overload Continuation (core 3x tool-validation cap)
*   **Symptoms**: `Schema overload: consecutive tool validation failures exceeded cap` or `consecutive turns with all tool calls failing`.
*   **Strategy**: No `/gsd auto` restart. The plugin schedules in-place `retryLastTurn` so context stays hot and auto-loop does not die on the first 3x cap event.
*   **Limit**: Unlimited by default. Optional cap via `GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES` (>0 enables cap).

## 🛠 Installation

Run the following command in your project root:

```bash
gsd install .
```

## 🔍 Verbose Mode

This implementation is intentionally "noisy" to facilitate debugging and observability:
- **Internal Logs**: Check your terminal for `[AutoContinue]` prefixed messages tracking every notification and state transition.
- **System Messages**: Real-time recovery status is displayed directly in the chat interface as system notifications.
- **Intervention Detection**: Automatically stands down only on explicit manual-intervention signals (e.g., stop directives, queued user interruption, or cancelled stops).

## S02 Lifecycle Failure-Path Regression Matrix (S03 Reuse)

> Scope: forced-reactive lifecycle behavior across `completed`, `blocked`, `manual-stop`, `provider`, and `transient` paths.

| Path | Trigger Signature | Expected Auto-Continue Action | Expected Hints Action | Unified Diagnostic Keywords |
|---|---|---|---|---|
| completed | `stop.reason === "completed"` and not in Type3 fix loop | `standDown("stop:completed")`; cancel timers; reset `type1/type2/type3` counters | No extra visible injection in-place; next new session still keeps startup dedupe (`session_start` + bootstrap `session_switch:new` suppression) | `plugin=gsd-auto-continue`, `phase=hook_stop`, `reason=completed`; `phase=mode_transition`; hints may show `reason=bootstrap_duplicate_after_session_start` |
| blocked | `stop.reason === "blocked"` or Type3 classifier hit | Enter Type3, schedule `type3_fix_*` (`attempt <= 3`), then `type3_resume_*` on fix completion; stand down on exhaustion | Type3 fix turns should rely on idempotent `before_agent_start` upsert (`append/replace/noop`), not duplicate visible boundary spam | `retryType=type3`, `phase=type3_fix_scheduled|type3_fix_fired|type3_resume_scheduled`, `reason=type3_fix_completed|type3_exhausted` |
| manual-stop | `stop.reason === "cancelled"`, user-intervention regex hit, or interactive input while active mode | Immediate stand down with no retry scheduling; clear pending timers and counters | No forced visible reinjection in same boundary; skip reasons should be explicit when a boundary is ignored | `phase=hook_input_manual_intervention|stop_stand_down_user_intervention`, `reason=stop:cancelled|stop:user_intervention_detected` |
| provider | Type2 classifier (`429/503/context overflow/syntax/tool invocation`) | Schedule `type2_retry_*` every 5s (`attempt <= 5`), then escalate to Type3 | Repeated retry turns keep one logical hints block (upsert idempotent), avoiding multi-append noise | `retryType=type2`, `phase=type2_retry_scheduled|type2_retry_fired`, `reason=type2_exhausted`, `escalation=type2_to_type3` |
| transient | Type1/default fallback (`network/timeout/econnreset/fetch failed`) | Exponential `type1_retry_*` backoff (2s→30s, `attempt <= 10`); `retryLastTurn` fallback to resume command; exhaustion escalates to Type2 | Same boundary/session/hash should suppress repeated visible hints; prompt upsert remains stable across retry turns | `retryType=type1`, `phase=type1_retry_scheduled|type1_retry_fired|type1_escalate_to_type2_scheduled`, `reason=network_or_timeout|type1_exhausted` |

## Re-runnable Verification Steps (for S03 Integration)

```bash
# 0) task contract artifacts
test -f gsd-auto-continue/README.md && test -f gsd-hints-injector/README.md

# 1) plugin regression tests
node --test gsd-auto-continue/index.test.mjs
node --test gsd-hints-injector/index.test.mjs

# 2) auto-continue failure-path coverage markers
rg -n "stop:completed|stop:cancelled|stop:user_intervention_detected|type1_retry|type1_escalate_to_type2|type2_retry|type2_exhausted|type3_fix|type3_resume|timer_cancel" gsd-auto-continue/index.ts

# 3) hints boundary suppression + prompt upsert markers
rg -n "session_start|session_switch|before_agent_start|bootstrap_duplicate_after_session_start|boundary_hash_duplicate|system_prompt_(append|replace|noop)|conversation_inject_skip" gsd-hints-injector/index.ts

# 4) unified diagnostics contract shared by both plugins
rg -n "plugin:\s*PLUGIN|phase,|retryType,|attempt,|reason," gsd-auto-continue/index.ts gsd-hints-injector/index.ts
```

Pass criteria:
- All commands exit with code `0`.
- Step (2) and step (3) both return matches for every listed path marker.
- Step (4) confirms both plugins emit the shared lifecycle keys (`plugin/phase/retryType/attempt/reason`) required for automated diffing.

## 📄 File Structure

- `index.ts`: The core logic implementing the 3-tier recovery and event listeners.
- `package.json`: Extension metadata and GSD integration config.

## ⚖️ License

MIT
