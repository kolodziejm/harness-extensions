const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SUBAGENT_WATCHDOG_TIMEOUTS = Object.freeze({
  startupMs: 120_000,
  idleMs: 300_000,
  totalMs: 1_800_000,
});

function timeoutFromEnv(env, name, fallback) {
  if (!(name in env)) return fallback;
  const raw = env[name];
  if (typeof raw === "string" && raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS
    ? value
    : fallback;
}

export function watchdogTimeoutsFromEnv(env = process.env) {
  return {
    startupMs: timeoutFromEnv(
      env,
      "PI_SUBAGENT_WATCHDOG_STARTUP_MS",
      DEFAULT_SUBAGENT_WATCHDOG_TIMEOUTS.startupMs,
    ),
    idleMs: timeoutFromEnv(
      env,
      "PI_SUBAGENT_WATCHDOG_IDLE_MS",
      DEFAULT_SUBAGENT_WATCHDOG_TIMEOUTS.idleMs,
    ),
    totalMs: timeoutFromEnv(
      env,
      "PI_SUBAGENT_WATCHDOG_TOTAL_MS",
      DEFAULT_SUBAGENT_WATCHDOG_TIMEOUTS.totalMs,
    ),
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function meaningfulProgressKind(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object") return undefined;
    if (["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type)) {
      return nonEmpty(update.delta) ? update.type : undefined;
    }
    if (update.type === "text_end") return nonEmpty(update.content) ? update.type : undefined;
    if (update.type === "thinking_end") return nonEmpty(update.content) ? update.type : undefined;
    if (["toolcall_start", "toolcall_end", "done"].includes(update.type)) return update.type;
    return undefined;
  }
  if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
    return `${event.type}${typeof event.toolName === "string" && event.toolName ? `:${event.toolName}` : ""}`;
  }
  if (event.type === "bash_execution_update") {
    return nonEmpty(event.delta) ? event.type : undefined;
  }
  if (["turn_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"].includes(event.type)) {
    return event.type;
  }
  return undefined;
}

function timer(setTimer, callback, delay) {
  const handle = setTimer(callback, Math.max(0, delay));
  handle?.unref?.();
  return handle;
}

function boundedText(value, maximum = 240) {
  if (typeof value !== "string") return "";
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function terminalRecord(record) {
  return record && !["queued", "running"].includes(record.status);
}

export function createSubagentDeadlineTracker(options = {}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const getRecord = options.getRecord ?? (() => undefined);
  const onExpire = options.onExpire ?? (() => {});
  const timeouts = options.timeouts ?? watchdogTimeoutsFromEnv();
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const watches = new Map();
  let disposed = false;

  function clearResources(watch) {
    for (const name of ["startupTimer", "idleTimer", "totalTimer", "attachTimer"]) {
      if (watch[name] !== undefined) clearTimer(watch[name]);
      watch[name] = undefined;
    }
    watch.unsubscribeSession?.();
    watch.unsubscribeSession = undefined;
    watch.session = undefined;
  }

  function release(id, expectedWatch) {
    const watch = watches.get(id);
    if (!watch || (expectedWatch && watch !== expectedWatch)) return false;
    watches.delete(id);
    clearResources(watch);
    return true;
  }

  function expire(watch, reason, timeoutMs) {
    if (disposed || watch.expired || watches.get(watch.id) !== watch) return;
    const observedAt = now();
    if (reason === "startup_timeout" && watch.lastProgressAt !== null) return;
    if (reason === "idle_timeout") {
      if (watch.lastProgressAt === null) return;
      const remaining = watch.lastProgressAt + timeoutMs - observedAt;
      if (remaining > 0) {
        watch.idleTimer = timer(setTimer, () => expire(watch, reason, timeoutMs), remaining);
        return;
      }
    }
    if (reason === "total_timeout") {
      const remaining = watch.startedAt + timeoutMs - observedAt;
      if (remaining > 0) {
        watch.totalTimer = timer(setTimer, () => expire(watch, reason, timeoutMs), remaining);
        return;
      }
    }
    const record = getRecord(watch.id);
    if (terminalRecord(record)) {
      release(watch.id, watch);
      return;
    }
    watch.expired = true;
    clearResources(watch);
    onExpire(watch, {
      agentId: watch.id,
      type: watch.type,
      description: watch.description,
      reason,
      timeoutMs,
      startedAt: watch.startedAt,
      lastProgressAt: watch.lastProgressAt,
      lastProgressKind: watch.lastProgressKind,
      expiredAt: observedAt,
    });
  }

  function noteProgress(watch, event) {
    const kind = event?.type === "recovered" ? event.kind : meaningfulProgressKind(event);
    if (!kind || watch.expired || watches.get(watch.id) !== watch) return;
    watch.lastProgressAt = now();
    watch.lastProgressKind = kind;
    if (watch.startupTimer !== undefined) {
      clearTimer(watch.startupTimer);
      watch.startupTimer = undefined;
    }
    if (watch.idleTimer !== undefined) clearTimer(watch.idleTimer);
    if (timeouts.idleMs > 0) {
      watch.idleTimer = timer(
        setTimer,
        () => expire(watch, "idle_timeout", timeouts.idleMs),
        timeouts.idleMs,
      );
    }
  }

  function recoverProgress(watch, session) {
    const messages = Array.isArray(session.messages) ? session.messages.slice(watch.initialMessageCount) : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      if (!Number.isFinite(message.timestamp) || message.timestamp < watch.startedAt) continue;
      const part = [...message.content].reverse().find((item) => {
        if (item?.type === "thinking") return nonEmpty(item.thinking);
        if (item?.type === "text") return nonEmpty(item.text);
        return item?.type === "toolCall" || item?.type === "toolcall";
      });
      if (!part) continue;
      noteProgress(watch, { type: "recovered", kind: `recovered:${part.type}` });
      return;
    }
  }

  function attachSession(watch) {
    if (disposed || watch.expired || watches.get(watch.id) !== watch) return;
    const record = getRecord(watch.id);
    if (terminalRecord(record)) {
      release(watch.id, watch);
      return;
    }
    const session = record?.session;
    if (!session) {
      watch.attachTimer = timer(setTimer, () => attachSession(watch), pollIntervalMs);
      return;
    }
    if (watch.session === session) return;
    watch.unsubscribeSession?.();
    watch.session = session;
    watch.unsubscribeSession = session.subscribe((event) => noteProgress(watch, event));
    recoverProgress(watch, session);
  }

  function start(event) {
    if (disposed || !event?.id) return undefined;
    release(event.id);
    const record = getRecord(event.id);
    const observedAt = now();
    const watch = {
      id: event.id,
      type: boundedText(event.type, 80),
      description: boundedText(event.description),
      startedAt: Number.isFinite(record?.startedAt) ? record.startedAt : observedAt,
      lastProgressAt: null,
      lastProgressKind: null,
      expired: false,
      initialMessageCount: Array.isArray(record?.session?.messages) ? record.session.messages.length : 0,
    };
    watches.set(watch.id, watch);
    if (timeouts.startupMs > 0) {
      watch.startupTimer = timer(
        setTimer,
        () => expire(watch, "startup_timeout", timeouts.startupMs),
        watch.startedAt + timeouts.startupMs - observedAt,
      );
    }
    if (timeouts.totalMs > 0) {
      watch.totalTimer = timer(
        setTimer,
        () => expire(watch, "total_timeout", timeouts.totalMs),
        watch.startedAt + timeouts.totalMs - observedAt,
      );
    }
    attachSession(watch);
    return watch;
  }

  return {
    start,
    release,
    current: (id) => watches.get(id),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...watches.keys()]) release(id);
    },
  };
}
