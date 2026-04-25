# GSD Auto Continue

Auto Continue is a Pi/GSD extension that turns recoverable automation failures into explicit recovery turns instead of letting `auto-mode` stall. The extension follows the source specification preserved in [`SPEC-ORIGIN.md`](./SPEC-ORIGIN.md): first preserve the hot context whenever possible, then fall back to root-cause repair loops when the context can no longer be trusted.

## What It Does

- Watches Pi lifecycle events for stop, notification, turn-end, and session boundary signals.
- Treats every non-completed, non-cancelled, non-human-intervention stop as Type 1 first unless Pi/GSD has already emitted an official auto-mode pause banner.
- Aborts after two consecutive all-error tool-call turns so the core three-strike schema/tool interrupt does not take over first.
- Escalates to an LLM recovery turn only when the current stop diagnostics contain an official auto-mode pause/exit signal; manual/ordinary failures never enter Type 2.
- Resumes `/gsd auto` automatically after a successful discard-context recovery turn.
- Emits structured `[AutoContinue]` diagnostics through `ctx.ui.notify`, not stdout/stderr.

## Recovery Model

### Type 1 — Preserve Context

Use this for every failure while the current auto-mode context is still hot, and for every manual/ordinary failure. The extension does not classify failures by error text. If Pi/GSD has already emitted an official auto-mode pause banner in the current stop diagnostics, the hot context is considered lost and the failure goes directly to Type 2.

**Behavior:**

- Schedules the retry for the next turn; it does **not** perform same-turn `retryLastTurn` recovery.
- Shows a visible system message before retrying.
- Uses exponential backoff: `1000ms * 60 ** (attempt / 10)`, capped at 60 seconds.
- Gives up after 10 failed attempts outside official auto-mode exit handling; it does not escalate manual/ordinary failures to Type 2.
- Keeps the active context hot and explicitly avoids restarting `/gsd auto`.


### Type 2 — Discard Context

Use this only when the current stop diagnostics contain an official Pi/GSD auto-mode pause/exit signal such as `auto-mode paused`, `step-mode paused`, or `paused (escape)`. Manual/ordinary failures do not have Type 2; if Type 1 cannot repair them, Auto Continue stops and requires manual intervention.

**Behavior:**

- Dispatches an LLM recovery prompt with the captured failure detail.
- Marks the prompt with `Recovery Loop: N/unlimited`.
- Instructs the agent to diagnose and fix the root cause without asking for confirmation.
- Waits for that recovery turn to complete.
- Resumes auto-mode by sending `/gsd auto`.
- Has no attempt cap; it keeps looping until the problem is fixed or a human interrupts.

## Manual Intervention

Auto Continue stands down when it sees explicit human/operator intervention while recovery is active. It cancels pending timers, clears retry state, and sends a visible system notification that recovery has stopped.

Plain completed stops also clear recovery state. Programmatic session boundaries preserve active recovery timers so a scheduled recovery can continue across the session boundary.

## Runtime Diagnostics

Diagnostics are intentionally structured and noisy enough for future agents to inspect behavior from the UI stream.

Every diagnostic payload includes:

- `plugin`
- `phase`
- `retryType`
- `attempt`
- `reason`
- `fixingType2`

Optional fields include `detail` and `delayMs`. Details are truncated before display to keep notifications readable.

## Architecture

`index.ts` is a composition-only entrypoint. It builds dependencies and delegates lifecycle registration; it does not own recovery decisions, timers, dispatch fallbacks, or hook bodies.

Implementation modules:

- `src/config.ts` — runtime constants, manual-intervention phrases, retry limits, and backoff settings.
- `src/runtime-state.ts` — mutable counters, guard state, notification stash, and pending timer registry helpers.
- `src/diagnostics.ts` — structured `[AutoContinue]` lifecycle diagnostics through `ctx.ui.notify`.
- `src/timers.ts` — retry timer scheduling, replacement, cancellation, and stale-timer protection.
- `src/actions.ts` — safe Pi dispatch helpers for user messages, hidden trigger-turn fallback, and optional `retryLastTurn` dispatch support.
- `src/recovery.ts` — Type 1 / Type 2 state machine, stop handling, tool-error guard, Type 2 auto-resume, and error-message extraction.
- `src/lifecycle.ts` — Pi lifecycle hook registration and event forwarding.
- `src/types.ts` — shared runtime contracts.

There is intentionally no `src/classifiers.ts`. The recovery state machine does not guess the error type from text signals; every manual/ordinary failure gets Type 1 only, while current stop diagnostics containing an official auto-mode pause/exit signal go directly to Type 2.

## Installation

```bash
gsd install <git repo>
```

The package declares `index.ts` as the Pi extension entrypoint in `package.json`.

## Verification

Run from the repository root:

```bash
npm --prefix gsd-auto-continue run verify
! rg "readFileSync|readFile\(|source\.includes|assert\.match\(source" gsd-auto-continue/index.test.mjs
node gsd-auto-continue/scripts/verify-boundaries.mjs
git diff -- gsd-2 --exit-code
```

Verification coverage:

- Behavior tests import the real public `index.ts` entrypoint and assert lifecycle behavior through mocked Pi APIs.
- The test source-read guard keeps the suite black-box.
- The boundary verifier ensures ownership stays modular, `index.ts` remains thin, timer primitives stay in `src/timers.ts`, dispatch fallbacks stay in `src/actions.ts`, official auto-mode exit handling remains current-diagnostic-based rather than history-based, and signal classifier/Type 3 structure does not return.
- The upstream diff check protects the read-only `gsd-2/` dependency boundary.

## Known Node Warning

Node may print `[MODULE_TYPELESS_PACKAGE_JSON]` while importing the TypeScript entrypoint during tests. That warning is expected and non-fatal for this package unless a future task intentionally changes package metadata and proves the Pi extension entrypoint contract remains safe.

## License

MIT
