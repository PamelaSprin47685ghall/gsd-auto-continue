# GSD Auto Continue

A robust error-recovery extension for GSD that keeps `auto-mode` moving. It classifies failures into three recovery tiers and adds a dedicated schema-overload continuation path so core guardrails do not permanently kill automation.

## Recovery Tiers

### Type 1: Network Transient / Timeout

- **Symptoms**: `ECONNRESET`, `fetch failed`, idle watchdogs, or hard timeouts.
- **Strategy**: Exponential backoff from 2s to 30s with in-place retry.
- **Limit**: 10 attempts.
- **Scope**: Active in both `auto` and `manual` modes.

### Type 2: Provider / Syntax / Context

- **Symptoms**: Rate limits (429), API overloads (503), context overflows, or LLM-generated JSON syntax errors.
- **Strategy**: 5-second cooldown followed by `/gsd auto` to refresh the execution context.
- **Limit**: 5 attempts.

### Type 3: State Corruption / Logic Blocker

- **Symptoms**: Failed pre/post-execution checks, verification gate failures, UAT blocks, or git conflicts.
- **Strategy**: Escalate to the LLM with a diagnostic prompt. The agent is instructed to fix the root cause, and auto-mode resumes automatically once the fix turn completes.
- **Limit**: 3 attempts.

### Schema-Overload Continuation

- **Symptoms**: `Schema overload: consecutive tool validation failures exceeded cap` or `consecutive turns with all tool calls failing`.
- **Strategy**: No `/gsd auto` restart. The extension schedules in-place `retryLastTurn` so context stays hot and the auto loop does not die on the first 3x cap event.
- **Limit**: Unlimited by default. Set `GSD_AUTO_CONTINUE_SCHEMA_OVERLOAD_MAX_RETRIES` to a positive integer to enable a cap.

## Installation

Run the installer from the repository root:

```bash
gsd install .
```

The package declares `index.ts` as the Pi extension entrypoint.

## Runtime Diagnostics

This implementation is intentionally noisy so future agents can diagnose recovery behavior without reading ignored runtime artifacts.

- **Internal logs**: Terminal output uses `[AutoContinue]` JSON lifecycle diagnostics.
- **System messages**: Recovery status is displayed in chat-facing system notifications.
- **Intervention detection**: The extension stands down only on explicit manual-intervention signals such as stop directives, queued user interruption, or cancelled stops.

## Modular Architecture

`index.ts` is a thin public hub. It creates the runtime dependencies, wires them together, and delegates lifecycle registration; it should not own retry decisions, timer primitives, dispatch fallbacks, or hook bodies.

The implementation owners live under `gsd-auto-continue/src/`:

- `src/config.ts` builds runtime configuration, including schema-overload retry limits.
- `src/runtime-state.ts` owns mutable counters, armed guard state, and pending timer handles.
- `src/diagnostics.ts` emits the `[AutoContinue]` lifecycle diagnostics and user-visible recovery status.
- `src/timers.ts` owns retry timer scheduling and cancellation primitives.
- `src/actions.ts` owns safe Pi dispatch helpers, including user messages, hidden trigger-turn fallback, and `retryLastTurn`.
- `src/classifiers.ts` classifies stop reasons, provider failures, transient failures, manual intervention, and schema-overload signatures.
- `src/recovery.ts` owns the recovery state machine for Type 1, Type 2, Type 3, and schema-overload continuation paths.
- `src/lifecycle.ts` registers Pi lifecycle hooks and forwards events to recovery operations.
- `src/types.ts` defines shared types used across the package modules.

The boundary verifier enforces this layout so future refactors can move code within owner modules without turning `index.ts` back into a god file.

## Verification from the Repository Root

Run these commands from the repository root before claiming the extension is ready:

```bash
# 1) Public-entrypoint behavior suite plus structural boundary verifier.
npm --prefix gsd-auto-continue run verify

# 2) Optional explicit source-read guard for the behavior suite.
! rg "readFileSync|readFile\(|source\.includes|assert\.match\(source" gsd-auto-continue/index.test.mjs

# 3) Standalone boundary verification when investigating ownership drift.
node gsd-auto-continue/scripts/verify-boundaries.mjs

# 4) Upstream immutability contract.
git diff -- gsd-2 --exit-code
```

What each surface proves:

- `npm --prefix gsd-auto-continue run verify` runs the package-local behavior tests and boundary verifier through the public npm script. The behavior suite imports the real `index.ts` entrypoint, captures lifecycle hooks through mocked Pi APIs, and asserts externally visible dispatches and `[AutoContinue]` diagnostics.
- The source-read guard keeps `gsd-auto-continue/index.test.mjs` black-box: tests must not inspect implementation source text with `readFileSync`, `readFile(`, `source.includes`, or `assert.match(source)`.
- `node gsd-auto-continue/scripts/verify-boundaries.mjs` checks structural module ownership, including `src/recovery.ts` owning recovery decisions, `src/timers.ts` owning timer primitives, `src/actions.ts` owning dispatch fallbacks, and `index.ts` remaining a thin hub.
- `git diff -- gsd-2 --exit-code` preserves the read-only upstream `gsd-2/` contract. A non-empty diff means this package change accidentally modified upstream sources and must be investigated before close-out.

Failure interpretation:

- Behavior test failures point to a public-entrypoint regression in lifecycle registration, recovery scheduling, dispatch fallback behavior, or emitted diagnostics.
- Source-read guard failures mean the behavior suite is becoming implementation-coupled and should be rewritten back to public-boundary assertions.
- Boundary verifier failures point to module ownership drift or stale package metadata.
- Upstream diff failures point to an accidental change outside this package's ownership boundary.

## Known Node Warning

Node may print `[MODULE_TYPELESS_PACKAGE_JSON]` while importing the TypeScript entrypoint during tests. That warning is expected and non-fatal for this package unless a future task intentionally changes package metadata and proves the Pi extension entrypoint contract remains safe.

## License

MIT
