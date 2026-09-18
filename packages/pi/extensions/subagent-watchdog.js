const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const WATCHDOGS = new WeakMap();

export const DEFAULT_SUBAGENT_WATCHDOG_TIMEOUTS = Object.freeze({
  startupMs: 120_000,
  idleMs: 300_000,
  totalMs: 1_800_000,
});

function timeoutFromEnv(env, name, fallback) {
  if (!(name in env)) return fallback;
  const value = Number(env[name]);
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

function terminalRecord(record) {
  return record && !["queued", "running"].includes(record.status);
}

function timer(setTimer, callback, delay) {
  const handle = setTimer(callback, Math.max(0, delay));
  handle?.unref?.();
  return handle;
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function boundedText(value, maximum = 240) {
  if (typeof value !== "string") return "";
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function blockedMessage(details) {
  const label = details.type ? `${details.type} (${details.agentId})` : details.agentId;
  const reason = details.reason.replace("_", " ");
  const lastProgress = details.lastProgressAt === null
    ? "none"
    : `${isoTime(details.lastProgressAt)} (${details.lastProgressKind})`;
  return [
    `Subagent BLOCKED: ${label} exceeded its ${reason} after ${details.timeoutMs} ms and was cancelled.`,
    `Last meaningful progress: ${lastProgress}.`,
    `Started: ${isoTime(details.startedAt)}. Blocked: ${isoTime(details.blockedAt)}.`,
  ].join("\n");
}

export function createSubagentWatchdog(pi, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  const getManager = dependencies.getManager ?? (() => globalThis[MANAGER_KEY]);
  const timeouts = dependencies.timeouts ?? watchdogTimeoutsFromEnv();
  const pollIntervalMs = dependencies.pollIntervalMs ?? 25;
  const rpcTimeoutMs = dependencies.rpcTimeoutMs ?? 1_000;
  const cancellationRetryMs = dependencies.cancellationRetryMs ?? 30_000;
  const watches = new Map();
  const blockedPendingTerminal = new Map();
  const unsubscribers = [];
  let requestSequence = 0;
  let disposed = false;

  function clearWatch(id, expectedWatch) {
    const watch = watches.get(id);
    if (!watch || (expectedWatch && watch !== expectedWatch)) return false;
    watches.delete(id);
    for (const handle of [
      watch.startupTimer,
      watch.idleTimer,
      watch.totalTimer,
      watch.attachTimer,
      watch.retryTimer,
    ]) {
      if (handle !== undefined) clearTimer(handle);
    }
    watch.unsubscribeSession?.();
    return true;
  }

  function request(channel, payload) {
    const requestId = `subagent-watchdog-${now()}-${++requestSequence}`;
    const replyChannel = `${channel}:reply:${requestId}`;
    return new Promise((resolve) => {
      let settled = false;
      let timeout;
      let unsubscribe = () => {};
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timeout !== undefined) clearTimer(timeout);
        resolve(reply);
      };
      unsubscribe = pi.events.on(replyChannel, finish);
      timeout = timer(setTimer, () => finish({
        success: false,
        error: `No reply on ${channel} within ${rpcTimeoutMs} ms`,
      }), rpcTimeoutMs);
      pi.events.emit(channel, { requestId, ...payload });
    });
  }

  function consumeTerminal(id) {
    pi.events.emit("subagents:rpc:consume", {
      requestId: `subagent-watchdog-consume-${now()}-${++requestSequence}`,
      agentId: id,
    });
  }

  function reportError(watch, reason, error) {
    const details = {
      agentId: watch.id,
      type: watch.type,
      description: watch.description,
      status: "WATCHDOG_ERROR",
      reason,
      error: boundedText(error),
      observedAt: now(),
      cancellation: "failed",
    };
    pi.events.emit("subagents:watchdog:error", details);
    pi.sendMessage({
      customType: "subagent-watchdog-error",
      content: `Subagent watchdog could not cancel ${watch.type || "agent"} (${watch.id}): ${details.error}`,
      display: true,
      details,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  async function cancel(watch, state) {
    if (disposed || watches.get(watch.id) !== watch || blockedPendingTerminal.get(watch.id) !== state) return;

    state.active = true;
    const reply = await request("subagents:rpc:stop", { agentId: watch.id });
    if (disposed || blockedPendingTerminal.get(watch.id) !== state) return;
    state.active = false;

    if (!reply?.success) {
      if (state.cancellationTerminal) {
        blockedPendingTerminal.delete(watch.id);
        return;
      }
      if (watches.get(watch.id) !== watch) {
        blockedPendingTerminal.delete(watch.id);
        return;
      }
      if (!watch.errorReported) {
        watch.errorReported = true;
        reportError(watch, state.details.reason, reply?.error ?? "Subagent cancellation failed");
      }
      watch.retryTimer = timer(setTimer, () => {
        watch.retryTimer = undefined;
        void cancel(watch, state);
      }, cancellationRetryMs);
      return;
    }

    if (watches.get(watch.id) !== watch && !state.cancellationTerminal) {
      blockedPendingTerminal.delete(watch.id);
      return;
    }
    state.details.cancellation = "confirmed";
    state.confirmed = true;
    if (state.cancellationTerminal) consumeTerminal(watch.id);
    clearWatch(watch.id, watch);
    pi.events.emit("subagents:watchdog:blocked", state.details);
    pi.sendMessage({
      customType: "subagent-watchdog-blocked",
      content: blockedMessage(state.details),
      display: true,
      details: state.details,
    }, { deliverAs: "followUp", triggerTurn: true });
    if (state.cancellationTerminal) blockedPendingTerminal.delete(watch.id);
  }

  async function block(watch, reason, timeoutMs) {
    if (disposed || watch.blocking || watches.get(watch.id) !== watch) return;

    const observedAt = now();
    if (reason === "startup_timeout" && watch.lastProgressAt !== null) return;
    if (reason === "idle_timeout") {
      if (watch.lastProgressAt === null) return;
      const remaining = watch.lastProgressAt + timeoutMs - observedAt;
      if (remaining > 0) {
        watch.idleTimer = timer(setTimer, () => void block(watch, reason, timeoutMs), remaining);
        return;
      }
    }
    if (reason === "total_timeout") {
      const remaining = watch.startedAt + timeoutMs - observedAt;
      if (remaining > 0) {
        watch.totalTimer = timer(setTimer, () => void block(watch, reason, timeoutMs), remaining);
        return;
      }
    }

    const record = getManager()?.getRecord?.(watch.id);
    if (terminalRecord(record)) {
      clearWatch(watch.id);
      return;
    }

    watch.blocking = true;
    const details = {
      agentId: watch.id,
      type: watch.type,
      description: watch.description,
      status: "BLOCKED",
      reason,
      timeoutMs,
      startedAt: watch.startedAt,
      lastProgressAt: watch.lastProgressAt,
      lastProgressKind: watch.lastProgressKind,
      blockedAt: observedAt,
      cancellation: "pending",
    };
    const state = {
      watch,
      details,
      active: false,
      confirmed: false,
      cancellationTerminal: false,
    };
    blockedPendingTerminal.set(watch.id, state);
    await cancel(watch, state);
  }

  function recoverProgress(watch, session) {
    const messages = Array.isArray(session.messages) ? session.messages.slice(watch.initialMessageCount) : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
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

  function noteProgress(watch, event) {
    const kind = event?.type === "recovered" ? event.kind : meaningfulProgressKind(event);
    if (!kind || watches.get(watch.id) !== watch || watch.blocking) return;
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
        () => void block(watch, "idle_timeout", timeouts.idleMs),
        timeouts.idleMs,
      );
    }
  }

  function attachSession(watch) {
    if (disposed || watches.get(watch.id) !== watch || watch.blocking) return;
    const record = getManager()?.getRecord?.(watch.id);
    if (terminalRecord(record)) {
      clearWatch(watch.id);
      return;
    }
    if (record?.session) {
      if (watch.session !== record.session) {
        watch.unsubscribeSession?.();
        watch.session = record.session;
        watch.unsubscribeSession = record.session.subscribe((event) => noteProgress(watch, event));
        recoverProgress(watch, record.session);
      }
      return;
    }
    watch.attachTimer = timer(setTimer, () => attachSession(watch), pollIntervalMs);
  }

  function start(event) {
    if (disposed || !event?.id) return;
    clearWatch(event.id);
    blockedPendingTerminal.delete(event.id);
    const record = getManager()?.getRecord?.(event.id);
    const observedAt = now();
    const watch = {
      id: event.id,
      type: boundedText(event.type, 80),
      description: boundedText(event.description),
      startedAt: Number.isFinite(record?.startedAt) ? record.startedAt : observedAt,
      lastProgressAt: null,
      lastProgressKind: null,
      blocking: false,
      initialMessageCount: Array.isArray(record?.session?.messages) ? record.session.messages.length : 0,
    };
    watches.set(watch.id, watch);
    if (timeouts.startupMs > 0) {
      watch.startupTimer = timer(
        setTimer,
        () => void block(watch, "startup_timeout", timeouts.startupMs),
        watch.startedAt + timeouts.startupMs - observedAt,
      );
    }
    if (timeouts.totalMs > 0) {
      watch.totalTimer = timer(
        setTimer,
        () => void block(watch, "total_timeout", timeouts.totalMs),
        watch.startedAt + timeouts.totalMs - observedAt,
      );
    }
    attachSession(watch);
  }

  function finish(event) {
    if (!event?.id) return;
    const watch = watches.get(event.id);
    const state = blockedPendingTerminal.get(event.id);
    const record = getManager()?.getRecord?.(event.id);
    if (watch && record && !terminalRecord(record)) return;
    const cancellationTerminal = ["stopped", "aborted"].includes(event.status);
    if (state && cancellationTerminal && (state.watch === watch || state.confirmed)) {
      state.cancellationTerminal = true;
      clearWatch(event.id, watch);
      if (state.confirmed) {
        consumeTerminal(event.id);
        blockedPendingTerminal.delete(event.id);
      } else if (!state.active) {
        blockedPendingTerminal.delete(event.id);
      }
      return;
    }
    if (state?.confirmed) {
      clearWatch(event.id, watch);
      blockedPendingTerminal.delete(event.id);
      return;
    }
    clearWatch(event.id, watch);
    if (state?.watch === watch) {
      blockedPendingTerminal.delete(event.id);
    }
  }

  unsubscribers.push(
    pi.events.on("subagents:started", start),
    pi.events.on("subagents:completed", finish),
    pi.events.on("subagents:failed", finish),
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...watches.keys()]) clearWatch(id);
      blockedPendingTerminal.clear();
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    },
  };
}

export default function subagentWatchdog(pi, dependencies = {}) {
  let entry = WATCHDOGS.get(pi.events);
  if (!entry) {
    entry = {
      owners: new Set(),
      notificationOwner: pi,
    };
    const bridge = {
      events: pi.events,
      sendMessage(...args) {
        return entry.notificationOwner?.sendMessage(...args);
      },
    };
    entry.watchdog = createSubagentWatchdog(bridge, dependencies);
    WATCHDOGS.set(pi.events, entry);
  }
  if (entry.owners.has(pi)) return entry.watchdog;
  entry.owners.add(pi);
  pi.on("session_shutdown", () => {
    if (WATCHDOGS.get(pi.events) !== entry || !entry.owners.delete(pi)) return;
    if (entry.notificationOwner === pi) {
      entry.notificationOwner = entry.owners.values().next().value;
    }
    if (entry.owners.size > 0) return;
    entry.watchdog.dispose();
    WATCHDOGS.delete(pi.events);
  });
  return entry.watchdog;
}
