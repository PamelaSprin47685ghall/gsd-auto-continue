import crypto from "node:crypto";

export default function autoContinuePlugin(pi) {
  let mode = "manual";
  let notificationBuffer = [];
  
  let inRecoveryLoop = false;
  let recoveryLoopCount = 0;
  let withContextRetryCount = 0;

  let consecutiveToolCalls = 0;
  let lastToolHash = "";
  let preparationErrors = 0;

  // 1.1 Local Run State
  pi.on("unit_start", (e) => {
    mode = e.mode === "step" ? "step" : "auto";
  });

  pi.on("unit_end", (e) => {
    mode = "manual";
    if (e.status === "failed" || e.status === "blocked") {
      // Future category/message tracking could go here
    }
  });

  // 1.2 Notifications Drain
  pi.on("notification", (e) => {
    const msg = e.message || e.content;
    if (msg && msg.trim() !== "" && (e.type === "error" || e.type === "blocked")) {
      notificationBuffer.push(msg);
      if (notificationBuffer.length > 10) notificationBuffer.shift();
    }
  });

  // 1.3 Stop Event Handling
  pi.on("stop", (e) => {
    const errorMessages = notificationBuffer.join("\n");
    const fullMessage = [e.error || e.message, errorMessages].filter(Boolean).join("\n").trim();
    notificationBuffer = [];

    if (e.reason === "completed") {
      if (mode === "manual" && inRecoveryLoop) {
        pi.sendUserMessage(mode === "step" ? "/gsd next" : "/gsd auto");
      } else {
        inRecoveryLoop = false;
        recoveryLoopCount = 0;
        withContextRetryCount = 0;
      }
    } else if (e.reason === "abort" || e.reason === "interrupt") {
      inRecoveryLoop = false;
      recoveryLoopCount = 0;
      withContextRetryCount = 0;
    } else if (e.reason === "context_overflow") {
      if (recoveryLoopCount === 0) {
        recoveryLoopCount++;
      } else {
        triggerWithoutContextRecovery(pi, e.reason, fullMessage);
      }
    } else if (e.reason === "blocked") {
      triggerWithoutContextRecovery(pi, e.reason, fullMessage);
    } else if (e.reason === "error") {
      triggerWithContextContinuation(pi, e.reason, fullMessage);
    }
  });

  // 2.1 With-Context Continuation
  function triggerWithContextContinuation(pi, reason, message) {
    if (mode !== "auto") return;
    withContextRetryCount++;
    if (withContextRetryCount > 5) {
      triggerWithoutContextRecovery(pi, reason, message);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, withContextRetryCount - 1), 10000);
    setTimeout(() => {
      try {
        if (pi.ui && pi.ui.notify) {
          pi.ui.notify(`Auto-continue with context (attempt ${withContextRetryCount}/5)`, "info");
        }
        pi.sendUserMessage(`The previous operation failed with error:\n${message}\n\nPlease analyze the error and retry. Make sure to fix any invalid tool arguments.`);
      } catch (err) {
        if (pi.ui && pi.ui.notify) pi.ui.notify(`Internal extension error: ${err.message}`, "error");
        inRecoveryLoop = false;
      }
    }, delay);
  }

  // 2.2 Without-Context Recovery
  function triggerWithoutContextRecovery(pi, reason, message) {
    inRecoveryLoop = true;
    recoveryLoopCount++;
    const msg = `Auto-mode exited abnormally.\nReason: ${reason}\nDetails:\n${message}\n\nRecovery loop: ${recoveryLoopCount}/unlimited.\nPlease diagnose the issue, fix the failed state, and prepare for resumption.`;
    try {
      if (pi.ui && pi.ui.notify) {
        pi.ui.notify(`Starting without-context recovery (loop ${recoveryLoopCount})`, "warning");
      }
      pi.sendUserMessage(msg);
    } catch (err) {
      if (pi.ui && pi.ui.notify) pi.ui.notify(`Internal extension error: ${err.message}`, "error");
      inRecoveryLoop = false;
    }
  }

  // 2.1.1 Tool Call Loop Guards
  pi.on("tool_call", (e) => {
    if (e.toolName === "ask_user_questions") {
      consecutiveToolCalls = 0;
      lastToolHash = "";
      return;
    }
    const hash = crypto.createHash("sha256").update(e.toolName + JSON.stringify(e.input)).digest("hex");
    if (hash === lastToolHash) {
      consecutiveToolCalls++;
    } else {
      consecutiveToolCalls = 1;
      lastToolHash = hash;
    }
  });

  pi.on("tool_execution_end", (e) => {
    if (e.isError) {
      preparationErrors++;
    } else {
      preparationErrors = 0;
    }
  });

  // 3. Semantic Validation Patch
  pi.on("before_agent_start", (e) => {
    if (pi.tools) {
      for (const tool of pi.tools) {
        if (tool.name.startsWith("gsd_") && !tool.__patched) {
          tool.__patched = true;
          const origExecute = tool.execute;
          
          tool.execute = async function(args) {
            // Normalize JSON-encoded arrays/objects
            const normalizedArgs = { ...args };
            for (const key in normalizedArgs) {
              if (typeof normalizedArgs[key] === "string") {
                try {
                  const parsed = JSON.parse(normalizedArgs[key]);
                  if (typeof parsed === "object" && parsed !== null) {
                    normalizedArgs[key] = parsed;
                  }
                } catch (err) {}
              }
            }

            // Guard: Identical Tool Calls
            if (consecutiveToolCalls >= 4) {
              consecutiveToolCalls = 0;
              return {
                output: `[SEMANTIC VALIDATION ERROR / LOOP GUARD TRIGGERED]\nYou have called this tool identically 4 times without success.\nPlease rethink your approach, correct the arguments according to the schema, and try again.`
              };
            }
            
            // Guard: Preparation/Schema Errors
            if (preparationErrors >= 2) {
              preparationErrors = 0;
              return {
                output: `[SEMANTIC VALIDATION ERROR / LOOP GUARD TRIGGERED]\nYou have encountered 2 consecutive preparation/validation errors.\nPlease carefully review the tool schema and fix your arguments.`
              };
            }

            try {
              if (pi.core && pi.core.validateToolArguments) {
                pi.core.validateToolArguments(tool, normalizedArgs);
              }
              
              // Conditional requirements check for slices
              if (normalizedArgs.slices) {
                const slices = Array.isArray(normalizedArgs.slices) ? normalizedArgs.slices : [];
                for (const slice of slices) {
                  if (slice.isSketch === true) continue;
                  if ((tool.name === "gsd_plan_milestone" || tool.name === "gsd_plan_slice") && !slice.integrationClosure) {
                     throw new Error("integrationClosure is required for full slices; omit for sketches.");
                  }
                }
              }
              
              return await origExecute.call(this, normalizedArgs);
            } catch (err) {
              if (err.message && (err.message.includes("validation") || err.message.includes("required") || err.name === "ValidationError")) {
                return {
                  output: `[SEMANTIC VALIDATION FAILED]\nError: ${err.message}\n\nPlease fix the arguments to match the required schema exactly and try again.`
                };
              }
              throw err;
            }
          };
        }
      }
    }
  });
}
