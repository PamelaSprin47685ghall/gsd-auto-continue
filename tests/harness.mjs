import assert from "node:assert/strict";

let importCounter = 0;

async function importExtension() {
  const module = await import(new URL(`../index.ts?test=${Date.now()}-${importCounter++}`, import.meta.url).href);
  assert.equal(typeof module.default, "function");
  return module.default;
}

function createFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];

  globalThis.setTimeout = (callback, delayMs = 0, ...args) => {
    const timer = { callback, delayMs, args, cancelled: false, fired: false };
    timers.push(timer);
    return timer;
  };

  globalThis.clearTimeout = (handle) => {
    const timer = timers.find((candidate) => candidate === handle);
    if (timer) timer.cancelled = true;
  };

  return {
    pending: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    async flushNext() {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);
      assert.ok(timer, "expected a pending timer");
      timer.fired = true;
      await timer.callback(...timer.args);
      return timer;
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function createPi({ throwSendMessage = false, throwSendUserMessage = false } = {}) {
  const handlers = new Map();
  const systemMessages = [];
  const userMessages = [];
  const triggerTurns = [];

  const userMessageCalls = [];

  const pi = {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    sendMessage(message, options) {
      if (throwSendMessage) throw new Error("synthetic sendMessage failure");
      systemMessages.push({ message, options });
      if (options?.triggerTurn) triggerTurns.push({ message, options });
    },
    sendUserMessage(content, options) {
      userMessages.push(content);
      userMessageCalls.push({ content, options });
      if (throwSendUserMessage) throw new Error("synthetic send failure");
    },
  };

  return {
    pi,
    handlers,
    systemMessages,
    userMessages,
    userMessageCalls,
    triggerTurns,
    handler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler ${eventName}`);
      return handler;
    },
  };
}

export function createContext() {
  const aborts = [];
  const notifications = [];
  return {
    aborts,
    notifications,
    ctx: {
      abort() {
        aborts.push({});
      },
      isIdle() {
        return true;
      },
      getContextUsage() {
        return undefined;
      },
      ui: {
        notify(content, type) {
          notifications.push({ content, type });
        },
      },
    },
  };
}

export async function createHarness(t, options) {
  const timers = createFakeTimers();
  t.after(() => timers.restore());

  const pi = createPi(options);
  const registerExtension = await importExtension();
  await registerExtension(pi.pi);

  return { ...pi, timers };
}

export async function notify(harness, message, kind = "error") {
  await harness.handler("notification")({ type: "notification", kind, message });
}

export async function stop(harness, reason, errorMessage = "", ctx) {
  await harness.handler("stop")(
    {
      type: "stop",
      reason,
      lastMessage: errorMessage ? { errorMessage } : undefined,
    },
    ctx,
  );
}
