import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { createActionDependencies } from "./src/actions.ts";
import { createClassifierDependencies } from "./src/classifiers.ts";
import { createRuntimeConfig } from "./src/config.ts";
import { createDiagnostics } from "./src/diagnostics.ts";
import { registerLifecycleHooks } from "./src/lifecycle.ts";
import { createRecoveryOperations } from "./src/recovery.ts";
import { createRuntimeState } from "./src/runtime-state.ts";
import { createTimerDependencies } from "./src/timers.ts";

export default async function registerExtension(pi: ExtensionAPI) {
  const config = createRuntimeConfig();
  const state = createRuntimeState();
  const diagnostics = createDiagnostics(config, state);
  const timers = createTimerDependencies(state, diagnostics);
  const actions = createActionDependencies(diagnostics);
  const classifiers = createClassifierDependencies();
  const recovery = createRecoveryOperations({ pi, state, config, diagnostics, timers, actions, classifiers });

  diagnostics.logLifecycle("factory_registered", {
    reason: "extension_factory_initialized",
  });

  registerLifecycleHooks(pi, {
    state,
    config,
    diagnostics,
    classifiers,
    recovery,
  });
}
