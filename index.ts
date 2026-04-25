import type { ExtensionAPI, StopEvent, AssistantMessage, NotificationEvent } from "@gsd/pi-coding-agent";

export default async function registerExtension(pi: ExtensionAPI) {
  console.log("[AutoContinue] Extension registering...");
  
  let isAutoMode = false;
  let lastNotifications: string[] = [];
  let type1Retries = 0;
  let type2Retries = 0;
  let type3Retries = 0;
  let isFixingType3 = false;

  pi.sendMessage({
    customType: "system",
    content: "🚀 [AutoContinue] Verbose mode enabled. Listening for GSD lifecycle events...",
    display: true
  });

  // 1. 持续收集 GSD 内部发出的 Notification，以精准捕获 pauseAuto 的原因
  pi.events.on("notification", (data: any) => {
    const event = data as NotificationEvent;
    const msg = String(event.message || "");
    const kind = event.kind || "info";

    console.log(`[AutoContinue] Notification [${kind}]: ${msg}`);

    if (msg.includes("Auto-mode started") || msg.includes("Step-mode started")) {
      console.log("[AutoContinue] Auto-mode detected via notification.");
      isAutoMode = true;
      lastNotifications = []; // 新阶段，清空旧日志
    }

    if (kind === "warning" || kind === "error" || kind === "blocked") {
      console.log(`[AutoContinue] Stashing important notification: ${msg}`);
      lastNotifications.push(msg);
      if (lastNotifications.length > 5) lastNotifications.shift();
    }
  });

  // 2. 拦截核心 Stop 事件
  pi.events.on("stop", async (data: any) => {
    const event = data as StopEvent;
    const reason = event.reason;
    
    console.log(`[AutoContinue] Stop event received. Reason: ${reason}, isAutoMode: ${isAutoMode}, isFixingType3: ${isFixingType3}`);

    // --- Type 3 修复回合结束，恢复 Auto-mode ---
    if (isFixingType3 && reason === "completed") {
      console.log("[AutoContinue] Type 3 fix loop detected 'completed'. Resuming auto-mode.");
      isFixingType3 = false;
      type3Retries = 0;
      lastNotifications = [];
      pi.sendMessage({ 
        customType: "system", 
        content: "✅ [AutoContinue] Type 3 fix completed. Resuming Auto-mode...", 
        display: true 
      });
      setTimeout(() => {
        console.log("[AutoContinue] Sending /gsd auto...");
        pi.sendUserMessage("/gsd auto");
      }, 1500);
      return;
    }

    // --- GSD 正常完成所有里程碑，重置状态 ---
    if (reason === "completed") {
      console.log("[AutoContinue] GSD completed naturally. Resetting counters.");
      type1Retries = 0; type2Retries = 0; type3Retries = 0; isAutoMode = false;
      return;
    }

    // 仅在 Auto mode 下被中断才触发兜底
    if (!isAutoMode) {
      console.log("[AutoContinue] Stop event ignored because isAutoMode is false.");
      // 特殊情况：如果是 Type 1 网络错误，非 auto mode 也可以原地重试一次
      const lastMsg = event.lastMessage as AssistantMessage | undefined;
      const errorMsg = lastMsg?.errorMessage || "";
      const isNetwork = /network|timeout|econnreset|socket|fetch failed|stream idle/i.test(errorMsg);
      
      if (isNetwork && type1Retries < 10) {
          console.log("[AutoContinue] Non-auto mode network error. Triggering Type 1 retry.");
          handleType1(event, errorMsg);
      }
      return;
    }

    const lastMsg = event.lastMessage as AssistantMessage | undefined;
    const errorMsg = lastMsg?.errorMessage || "";
    const combinedLog = (lastNotifications.join(" | ") + " " + errorMsg).toLowerCase();

    console.log(`[AutoContinue] Analyzing combined logs: ${combinedLog}`);

    // ==========================================
    // 0. Exclude: 用户主动介入 (绝不恢复)
    // ==========================================
    if (
      combinedLog.includes("auto-mode paused (escape)") ||
      combinedLog.includes("stop directive detected") ||
      combinedLog.includes("queued user message interrupted")
    ) {
      console.log("[AutoContinue] User intervention detected. Standing down.");
      pi.sendMessage({
        customType: "system",
        content: "ℹ️ [AutoContinue] User intervention detected. Auto-recovery disabled.",
        display: true
      });
      isAutoMode = false;
      return; 
    }

    // ==========================================
    // Type 3: State Corruption / Code Blocker 
    // ==========================================
    const isType3 = 
      reason === "blocked" ||
      /pre-execution checks (failed|error)|post-execution checks failed|verification gate failed|needs-remediation|blocking progression|unresolved code conflicts|pre-dispatch health check failed|reconciliation failed/i.test(combinedLog);

    if (isType3) {
      console.log("[AutoContinue] Classified as Type 3 (State/Blocker).");
      if (type3Retries < 3) {
        type3Retries++;
        isFixingType3 = true;
        pi.sendMessage({ 
          customType: "system", 
          content: `🚨 [AutoContinue] Blocker/State Corruption detected. Dispatching Type 3 LLM fix (Attempt ${type3Retries}/3)...`, 
          display: true 
        });
        
        const prompt = `Auto-mode was paused due to a blocking issue or failed verification:\n\n${combinedLog}\n\nPlease diagnose and fix this specific issue. Use the necessary tools (e.g., edit files, resolve git conflicts, fix tests or adjust the plan). I will resume auto-mode automatically once you finish this turn. Do not ask for confirmation.`;
        
        console.log(`[AutoContinue] Sending Type 3 prompt: ${prompt}`);
        setTimeout(() => pi.sendUserMessage(prompt, { triggerTurn: true }), 2000);
      } else {
        console.log("[AutoContinue] Type 3 retries exhausted.");
        pi.sendMessage({ customType: "system", content: `❌ [AutoContinue] Type 3 fix exhausted (3/3). Manual intervention required.`, display: true });
        isAutoMode = false; isFixingType3 = false;
      }
      return;
    }

    // ==========================================
    // Type 2: Provider / Context / LLM Syntax
    // ==========================================
    const isType2 =
      /tool invocation failed|structured argument generation failed|context overflow|auto-compaction failed|empty-turn recovery|rate.?limit|429|quota|unauthorized|overloaded|500|502|503/i.test(combinedLog);

    if (isType2) {
      console.log("[AutoContinue] Classified as Type 2 (Provider/Syntax).");
      if (type2Retries < 5) {
        type2Retries++;
        pi.sendMessage({ customType: "system", content: `⚠️ [AutoContinue] Provider/Syntax error. Type 2 auto-restart in 5s (Attempt ${type2Retries}/5)...`, display: true });
        // 发送 /gsd auto 可以刷新一次底层上下文，跳过导致死循环的坏节点
        console.log("[AutoContinue] Scheduling /gsd auto in 5s...");
        setTimeout(() => pi.sendUserMessage("/gsd auto"), 5000);
      } else {
        console.log("[AutoContinue] Type 2 exhausted. Escalating to Type 3.");
        type2Retries = 0;
        pi.sendMessage({ customType: "system", content: `⚠️ [AutoContinue] Type 2 exhausted. Escalating to Type 3...`, display: true });
        setTimeout(() => pi.sendUserMessage("Auto-mode encountered persistent provider or syntax errors. Please review the recent state and take actions to bypass the issue, then finish your turn.", { triggerTurn: true }), 2000);
        isFixingType3 = true;
      }
      return;
    }

    // ==========================================
    // Type 1: Network Transient / Timeout
    // ==========================================
    console.log("[AutoContinue] Defaulting to Type 1 (Network/Timeout).");
    handleType1(event, combinedLog);
  });

  function handleType1(event: StopEvent, combinedLog: string) {
    if (type1Retries < 10) {
      type1Retries++;
      // 指数退避: 2s, 4s, 8s... 封顶 30s
      const delayMs = Math.min(2000 * Math.pow(2, type1Retries - 1), 30000);
      console.log(`[AutoContinue] Type 1 retry scheduled in ${delayMs}ms. Attempt ${type1Retries}/10.`);
      pi.sendMessage({ customType: "system", content: `📶 [AutoContinue] Transient error. Type 1 in-place retry in ${delayMs/1000}s (Attempt ${type1Retries}/10)...`, display: true });
      
      setTimeout(() => {
        if (typeof (pi as any).retryLastTurn === 'function') {
          console.log("[AutoContinue] Executing pi.retryLastTurn().");
          (pi as any).retryLastTurn();
        } else {
          console.log("[AutoContinue] pi.retryLastTurn not available. Sending user message to retry.");
          pi.sendUserMessage("A transient network or timeout error occurred. Please retry your last action.", { triggerTurn: true });
        }
      }, delayMs);
    } else {
      console.log("[AutoContinue] Type 1 exhausted. Escalating to Type 2.");
      type1Retries = 0;
      pi.sendMessage({ customType: "system", content: `⚠️ [AutoContinue] Type 1 exhausted. Escalating to Type 2...`, display: true });
      setTimeout(() => pi.sendUserMessage("/gsd auto"), 2000);
    }
  }
}
