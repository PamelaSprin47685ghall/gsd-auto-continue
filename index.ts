import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerAutoModeStopRouter } from "./auto-mode-stop-router.ts";
import { installSemanticGsdValidationPatch } from "./semantic-gsd-validation.ts";
import { isLocalGsdAutoActive, resetLocalGsdAutoRunState } from "./local-gsd-auto-state.ts";

const INSTALL_FAILURE_REPORTED = Symbol.for("gsd-auto-continue.semantic-gsd-validation.install-failure-reported");

const reportInstallFailureOnce = (error: unknown) => {
  const globalState = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  if (globalState[INSTALL_FAILURE_REPORTED]) return;
  globalState[INSTALL_FAILURE_REPORTED] = true;
  console.error(`[AutoContinue] Failed to install semantic GSD validation patch: ${error instanceof Error ? error.message : String(error)}`);
};

export default async function registerExtension(pi: ExtensionAPI) {
  resetLocalGsdAutoRunState();
  try {
    await installSemanticGsdValidationPatch({ isEnabled: isLocalGsdAutoActive });
  } catch (error) {
    reportInstallFailureOnce(error);
  }

  registerAutoModeStopRouter(pi);
}
