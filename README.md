# GSD Auto Continue

Small Pi/GSD extension that keeps `auto-mode` moving after recoverable stops.

## Behavior

- Ordinary failures schedule a with-context retry in the current conversation.
- Official auto-mode pause banners (`auto-mode paused`, `step-mode paused`, `paused (escape)`) start without-context recovery.
- After without-context recovery completes, the extension sends `/gsd auto` to resume automation.
- Repeated schema/preparation tool-call failures are aborted after two all-preparation-error turns, one turn before Pi core's three-turn schema-overload interrupt.
- Repeated identical tool calls are aborted on the fourth identical call, one call before GSD's fifth-call loop guard blocks execution.
- Manual/operator intervention cancels pending recovery; self-triggered `ctx.abort()` stops are consumed by the retry guard instead of being treated as manual intervention.

## Shape

The implementation is intentionally small:

- `index.ts` — extension entrypoint.
- `continuation-policy.ts` — retry limits and stop-phrase policy.
- `auto-mode-stop-router.ts` — Pi hook registration, stop classification, and shared notification draining.
- `with-context-continuation.ts` — current-conversation retries and tool-error guard.
- `without-context-recovery.ts` — recovery turn scheduling after official auto-mode exits, then `/gsd auto` resume.
- `tests/*.test.mjs` — behavior tests split by continuation path.
- `tests/harness.mjs` — fake Pi runtime and timer helpers.

Older versions split this across many tiny modules and a boundary-verifier script. That was too much structure for the feature; the current version keeps the useful seam without locking in ceremonial architecture.

## Installation

```bash
gsd install <git repo>
```

`package.json` declares `index.ts` as the Pi extension entrypoint.

## Verification

```bash
npm --prefix gsd-auto-continue run verify
```
