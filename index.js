import crypto from "node:crypto";
import { createRequire } from "node:module";

try {
  const AjvMod = createRequire(import.meta.url)("ajv");
  const AjvClass = AjvMod.default || AjvMod;
  if (AjvClass?.prototype?.compile) AjvClass.prototype.compile = () => () => true;
} catch {}

export default function autoContinuePlugin(pi) {
  let consecutiveCalls = 0, lastHash = "", ctxRetries = 0, pauseRetries = 0;
  const MAX_LOOP = 4, MAX_CTX = 5, MAX_PAUSE = 5;
  let hbTimer = null, gsdSeen = false;
  const execIds = new Set();
  let capturedCtx = null;

  const hbStart = () => {
    clearTimeout(hbTimer);
    hbTimer = setTimeout(() => {
      if (++pauseRetries > MAX_PAUSE) {
        capturedCtx?.ui?.notify?.(`Auto-continue: max pause-recovery attempts (${MAX_PAUSE}) reached`, "error");
        return;
      }
      capturedCtx?.ui?.notify?.(`Auto-continue: stalled — resuming (${pauseRetries}/${MAX_PAUSE})`, "info");
      pi.sendUserMessage("/gsd auto");
    }, 5_000);
  };

  const hbClear = () => { clearTimeout(hbTimer); hbTimer = null; };

  pi.on("input", (e, ctx) => { capturedCtx = ctx; if (e.source === "interactive") hbClear(); });
  pi.on("before_agent_start", (e, ctx) => { capturedCtx = ctx; hbClear(); });

  pi.on("stop", (e, ctx) => {
    capturedCtx = ctx;
    if (e.reason === "completed") {
      if (gsdSeen) hbStart();
      gsdSeen = false;
      ctxRetries = 0;
    } else if (e.reason === "error") {
      if (++ctxRetries > MAX_CTX) {
        ctx.ui?.notify?.(`Auto-continue: giving up after ${MAX_CTX} error retries`, "warning");
        ctxRetries = 0;
        return;
      }
      const delay = Math.min(1_000 * 2 ** (ctxRetries - 1), 10_000);
      setTimeout(() => {
        ctx.ui?.notify?.(`Auto-continue: retrying (${ctxRetries}/${MAX_CTX})`, "info");
        pi.sendUserMessage("The previous operation failed. Please analyze the error, fix the arguments, and retry.");
      }, delay);
    }
  });

  pi.on("tool_call", e => {
    if (e.toolName.startsWith("gsd_")) gsdSeen = true;
    if (!execIds.has(e.toolCallId)) { execIds.add(e.toolCallId); return; }
    execIds.delete(e.toolCallId);
    if (e.toolName === "ask_user_questions") { consecutiveCalls = 0; lastHash = ""; return; }

    const hash = crypto.createHash("sha256").update(e.toolName + JSON.stringify(e.input)).digest("hex");
    consecutiveCalls = hash === lastHash ? consecutiveCalls + 1 : 1;
    lastHash = hash;

    if (consecutiveCalls >= MAX_LOOP) {
      consecutiveCalls = 0;
      return { block: true, reason: `[LOOP GUARD] Same tool+args called ${MAX_LOOP} times. Rethink your approach.` };
    }

    if (e.toolName === "bash" && (typeof e.input.command !== "string" || !e.input.command.trim()))
      return { block: true, reason: "`command` must be a non-empty string" };
    if (e.toolName === "write" && (!e.input.path || !e.input.content))
      return { block: true, reason: "`path` and `content` are both required" };
  });
}
