import { createSubagentDeadlineTracker } from "./subagent-watchdog-core.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function timer(setTimer, callback, delay) {
  const handle = setTimer(callback, delay);
  handle?.unref?.();
  return handle;
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function boundedText(value, maximum = 300) {
  const text = typeof value === "string" && value ? value : "cancellation was not acknowledged";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
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
  const rpcTimeoutMs = dependencies.rpcTimeoutMs ?? 1_000;
  const cancellationRetryMs = dependencies.cancellationRetryMs ?? 30_000;
  const pending = new Map();
  const generations = new Map();
  const activeRequests = new Set();
  const unsubscribers = [];
  let requestSequence = 0;
  let disposed = false;
  let tracker;

  function request(channel, payload) {
    const requestId = `subagent-watchdog-${now()}-${++requestSequence}`;
    const replyChannel = `${channel}:reply:${requestId}`;
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      let timeout;
      const operation = { cancel: () => finish({ success: false, error: "Watchdog disposed" }) };
      const finish = (reply) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimer(timeout);
        activeRequests.delete(operation);
        resolve(reply);
      };
      unsubscribe = pi.events.on(replyChannel, finish);
      timeout = timer(setTimer, () => finish({
        success: false,
        error: `No reply on ${channel} within ${rpcTimeoutMs} ms`,
      }), rpcTimeoutMs);
      activeRequests.add(operation);
      pi.events.emit(channel, { requestId, ...payload });
    });
  }

  function consumeTerminal(id) {
    pi.events.emit("subagents:rpc:consume", {
      requestId: `subagent-watchdog-consume-${now()}-${++requestSequence}`,
      agentId: id,
    });
  }

  function clearPending(id, expectedState) {
    const state = pending.get(id);
    if (!state || (expectedState && state !== expectedState)) return false;
    if (state.retryTimer !== undefined) clearTimer(state.retryTimer);
    pending.delete(id);
    return true;
  }

  function reportCancellationError(state, error, willRetry = true) {
    if (state.errorReported || disposed) return;
    state.errorReported = true;
    const detail = boundedText(error);
    pi.sendMessage({
      customType: "subagent-watchdog-error",
      content: [
        `Subagent watchdog could not confirm cancellation for ${state.watch.id}: ${detail}.`,
        willRetry
          ? `BLOCKED was not emitted; retrying in ${cancellationRetryMs} ms.`
          : "BLOCKED was not emitted; the terminal result remains visible and no retry is scheduled.",
      ].join("\n"),
      display: true,
      details: { agentId: state.watch.id, error: detail, retryMs: willRetry ? cancellationRetryMs : null },
    }, { deliverAs: "followUp", triggerTurn: false });
  }

  function scheduleRetry(state) {
    if (disposed || state.retryTimer !== undefined || pending.get(state.watch.id) !== state) return;
    state.retryTimer = timer(setTimer, () => {
      state.retryTimer = undefined;
      void cancel(state.watch, state);
    }, cancellationRetryMs);
  }

  async function cancel(watch, state) {
    if (disposed || tracker.current(watch.id) !== watch || pending.get(watch.id) !== state) return;
    const target = getManager()?.getRecord?.(watch.id);
    if (!target || !Number.isFinite(target.startedAt) || target.startedAt !== watch.startedAt) {
      reportCancellationError(state, "target run identity changed or is unavailable", false);
      tracker.release(watch.id, watch);
      clearPending(watch.id, state);
      return;
    }
    if (!["queued", "running"].includes(target.status)) {
      tracker.release(watch.id, watch);
      clearPending(watch.id, state);
      return;
    }
    state.active = true;
    const reply = await request("subagents:rpc:stop", { agentId: watch.id });
    if (disposed || pending.get(watch.id) !== state) return;
    state.active = false;
    if (!reply?.success) {
      if (state.cancellationTerminal) {
        reportCancellationError(state, reply?.error, false);
        clearPending(watch.id, state);
        return;
      }
      const record = getManager()?.getRecord?.(watch.id);
      if (record && !["queued", "running"].includes(record.status)) {
        tracker.release(watch.id, watch);
        clearPending(watch.id, state);
        return;
      }
      reportCancellationError(state, reply?.error);
      scheduleRetry(state);
      return;
    }
    state.confirmed = true;
    state.details.cancellation = "confirmed";
    tracker.release(watch.id, watch);
    pi.events.emit("subagents:watchdog:blocked", state.details);
    pi.sendMessage({
      customType: "subagent-watchdog-blocked",
      content: blockedMessage(state.details),
      display: true,
      details: state.details,
    }, { deliverAs: "followUp", triggerTurn: true });
    if (state.cancellationTerminal) {
      consumeTerminal(watch.id);
      clearPending(watch.id, state);
    }
  }

  function onExpire(watch, deadline) {
    const { expiredAt, ...evidence } = deadline;
    const state = {
      watch,
      active: false,
      confirmed: false,
      cancellationTerminal: false,
      details: {
        ...evidence,
        status: "BLOCKED",
        blockedAt: expiredAt,
        cancellation: "pending",
      },
    };
    pending.set(watch.id, state);
    void cancel(watch, state);
  }

  tracker = createSubagentDeadlineTracker({
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    getRecord: (id) => getManager()?.getRecord?.(id),
    onExpire,
    pollIntervalMs: dependencies.pollIntervalMs,
    timeouts: dependencies.timeouts,
  });

  function start(event) {
    if (disposed || !event?.id) return;
    clearPending(event.id);
    const generation = (generations.get(event.id) ?? 0) + 1;
    generations.set(event.id, generation);
    const watch = tracker.start(event);
    if (watch) watch.generation = generation;
  }

  function terminalMatches(event, watch, record) {
    if (!watch) return true;
    if (Number.isFinite(record?.startedAt) && record.startedAt !== watch.startedAt) return false;
    if (watch.generation > 1) {
      return Number.isFinite(event.durationMs)
        && Number.isFinite(record?.startedAt)
        && Number.isFinite(record?.completedAt)
        && event.durationMs === record.completedAt - record.startedAt;
    }
    if (Number.isFinite(event.durationMs)) {
      if (Number.isFinite(record?.completedAt) && Number.isFinite(record?.startedAt)) {
        return event.durationMs === record.completedAt - record.startedAt;
      }
      return now() - event.durationMs === watch.startedAt;
    }
    return watch.generation <= 1;
  }

  function finish(event) {
    if (!event?.id) return;
    const state = pending.get(event.id);
    const watch = state?.watch ?? tracker.current(event.id);
    const record = getManager()?.getRecord?.(event.id);
    if (!terminalMatches(event, watch, record)) return;
    if (state?.confirmed) {
      if (["stopped", "aborted"].includes(event.status)) consumeTerminal(event.id);
      clearPending(event.id, state);
      return;
    }
    if (record && ["queued", "running"].includes(record.status)) return;
    if (state && !state.confirmed && state.active && ["stopped", "aborted"].includes(event.status)) {
      state.cancellationTerminal = true;
      tracker.release(event.id, state.watch);
      return;
    }
    tracker.release(event.id);
    clearPending(event.id, state);
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
      tracker.dispose();
      for (const id of [...pending.keys()]) clearPending(id);
      for (const operation of [...activeRequests]) operation.cancel();
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    },
  };
}
