import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerAutoModeStopRouter } from "./auto-mode-stop-router.ts";

export default async function registerExtension(pi: ExtensionAPI) {
  registerAutoModeStopRouter(pi);
}
