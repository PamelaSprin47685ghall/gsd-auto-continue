# GSD Auto Continue

A robust error-recovery extension for GSD that ensures `auto-mode` stays automatic. It classifies failures into three tiers and applies specific recovery strategies, minimizing manual intervention.

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

## 🛠 Installation

Run the following command in your project root:

```bash
gsd install .
```

## 🔍 Verbose Mode

This implementation is intentionally "noisy" to facilitate debugging and observability:
- **Internal Logs**: Check your terminal for `[AutoContinue]` prefixed messages tracking every notification and state transition.
- **System Messages**: Real-time recovery status is displayed directly in the chat interface as system notifications.
- **Intervention Detection**: Automatically stands down if it detects manual user intervention (e.g., Escape key or stop directives).

## 📄 File Structure

- `index.ts`: The core logic implementing the 3-tier recovery and event listeners.
- `package.json`: Extension metadata and GSD integration config.

## ⚖️ License

MIT
