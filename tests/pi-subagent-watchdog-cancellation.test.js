import assert from "node:assert/strict";
import test from "node:test";

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

class FakeEvents {
  constructor() {
    this.handlers = new Map();
  }

  on(name, handler) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }

  emit(name, payload) {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(payload);
  }
}

class FakeSession {
  constructor() {
    this.handlers = new Set();
    this.messages = [];
  }

  subscribe(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

async function watchdogFixture(overrides = {}) {
  let createSubagentWatchdog;
  try {
    ({ createSubagentWatchdog } = await import("../packages/pi/extensions/subagent-watchdog.js"));
  } catch {}
  assert.equal(typeof createSubagentWatchdog, "function");
  const clock = new FakeClock();
  const events = new FakeEvents();
  const messages = [];
  const session = new FakeSession();
  const record = {
    id: "agent-1",
    type: "debugger",
    description: "Find the startup deadlock",
    status: "running",
    startedAt: 0,
    session,
  };
  const manager = { getRecord: (id) => id === record.id ? record : undefined };
  const stopped = [];
  const consumed = [];
  const { stopHandler, ...dependencyOverrides } = overrides;
  events.on("subagents:rpc:stop", ({ requestId, agentId }) => {
    stopped.push(agentId);
    if (stopHandler) {
      stopHandler({ agentId, events, record, requestId });
      return;
    }
    record.status = "stopped";
    events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });
  events.on("subagents:rpc:consume", ({ requestId, agentId }) => {
    consumed.push(agentId);
    events.emit(`subagents:rpc:consume:reply:${requestId}`, { success: true });
  });
  const pi = {
    events,
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const watchdog = createSubagentWatchdog(pi, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getManager: () => manager,
    pollIntervalMs: 5,
    rpcTimeoutMs: 10,
    cancellationRetryMs: 20,
    timeouts: { startupMs: 100, idleMs: 150, totalMs: 300 },
    ...dependencyOverrides,
  });
  return { clock, consumed, events, messages, record, stopped, watchdog };
}

function startAgent(fixture) {
  fixture.events.emit("subagents:started", {
    id: fixture.record.id,
    type: fixture.record.type,
    description: fixture.record.description,
  });
}

function blockedDetails(fixture) {
  return fixture.messages.find(({ message }) => message.customType === "subagent-watchdog-blocked")?.message.details;
}

test("acknowledged expiration stops the child and reports terminal BLOCKED evidence", async () => {
  const fixture = await watchdogFixture();
  startAgent(fixture);

  await fixture.clock.advance(100);

  assert.deepEqual(fixture.stopped, ["agent-1"]);
  assert.deepEqual(blockedDetails(fixture), {
    agentId: "agent-1",
    type: "debugger",
    description: "Find the startup deadlock",
    status: "BLOCKED",
    reason: "startup_timeout",
    timeoutMs: 100,
    startedAt: 0,
    lastProgressAt: null,
    lastProgressKind: null,
    blockedAt: 100,
    cancellation: "confirmed",
  });
  assert.equal(fixture.messages.at(-1).options.triggerTurn, true);

  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });
  assert.deepEqual(fixture.consumed, ["agent-1"]);
  assert.equal(fixture.messages.length, 1);
  fixture.watchdog.dispose();
});

test("failed cancellation reports once and retries without publishing BLOCKED", async () => {
  let attempts = 0;
  const fixture = await watchdogFixture({
    stopHandler({ events, record, requestId }) {
      attempts += 1;
      if (attempts === 1) {
        events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "transport down" });
        return;
      }
      record.status = "stopped";
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  });
  startAgent(fixture);

  await fixture.clock.advance(100);

  assert.equal(attempts, 1);
  assert.equal(blockedDetails(fixture), undefined);
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].message.customType, "subagent-watchdog-error");
  assert.match(fixture.messages[0].message.content, /transport down/);
  assert.equal(fixture.messages[0].options.triggerTurn, false);

  await fixture.clock.advance(20);

  assert.equal(attempts, 2);
  assert.equal(blockedDetails(fixture).cancellation, "confirmed");
  assert.equal(fixture.messages.filter(({ message }) => message.customType === "subagent-watchdog-error").length, 1);
  fixture.watchdog.dispose();
});

test("a retry fails closed when the manager silently replaces the ID", async () => {
  let attempts = 0;
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      attempts += 1;
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "transport down" });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(attempts, 1);
  fixture.record.startedAt = 110;
  fixture.record.status = "running";

  await fixture.clock.advance(20);

  assert.equal(attempts, 1);
  assert.equal(blockedDetails(fixture), undefined);
  assert.equal(fixture.messages.filter(({ message }) => message.customType === "subagent-watchdog-error").length, 1);
  fixture.watchdog.dispose();
});

test("a stopped terminal arriving before acknowledgement is consumed after success", async () => {
  let pendingReply;
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      pendingReply = () => events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.record.status = "stopped";
  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });

  assert.deepEqual(fixture.consumed, []);
  assert.equal(fixture.messages.length, 0);
  pendingReply();
  await fixture.clock.advance(0);

  assert.equal(blockedDetails(fixture).cancellation, "confirmed");
  assert.deepEqual(fixture.consumed, ["agent-1"]);
  fixture.watchdog.dispose();
});

test("a stopped terminal remains visible when cancellation is not acknowledged", async () => {
  let pendingReply;
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      pendingReply = () => events.emit(`subagents:rpc:stop:reply:${requestId}`, {
        success: false,
        error: "stop rejected",
      });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.record.status = "stopped";
  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });
  pendingReply();
  await fixture.clock.advance(0);

  assert.equal(blockedDetails(fixture), undefined);
  assert.deepEqual(fixture.consumed, []);
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0].message.customType, "subagent-watchdog-error");
  assert.doesNotMatch(fixture.messages[0].message.content, /retrying/);
  await fixture.clock.advance(100);
  assert.equal(fixture.stopped.length, 1);
  fixture.watchdog.dispose();
});

test("a natural completion before acknowledgement keeps its real terminal result", async () => {
  let pendingReply;
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      pendingReply = () => events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.record.status = "completed";
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  pendingReply();
  await fixture.clock.advance(0);

  assert.equal(fixture.messages.length, 0);
  assert.deepEqual(fixture.consumed, []);
  fixture.watchdog.dispose();
});

test("a stale terminal event cannot release a replacement watch", async () => {
  const fixture = await watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(50);
  fixture.record.startedAt = 50;
  fixture.record.status = "running";
  startAgent(fixture);

  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });
  await fixture.clock.advance(100);

  assert.deepEqual(fixture.stopped, ["agent-1"]);
  assert.equal(blockedDetails(fixture).startedAt, 50);
  fixture.watchdog.dispose();
});

test("terminal duration prevents an old run from consuming a replacement result", async () => {
  const fixture = await watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(10);
  fixture.record.startedAt = 10;
  fixture.record.status = "running";
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.record.completedAt = 110;
  assert.equal(blockedDetails(fixture).startedAt, 10);

  fixture.events.emit("subagents:failed", {
    id: "agent-1",
    status: "stopped",
    durationMs: 110,
  });
  assert.deepEqual(fixture.consumed, []);
  fixture.events.emit("subagents:failed", {
    id: "agent-1",
    status: "stopped",
    durationMs: 100,
  });
  assert.deepEqual(fixture.consumed, ["agent-1"]);
  fixture.watchdog.dispose();
});

test("a reused ID fails closed when manager completion identity is unavailable", async () => {
  const fixture = await watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(10);
  fixture.record.startedAt = 10;
  fixture.record.status = "running";
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(blockedDetails(fixture).startedAt, 10);
  fixture.record.completedAt = undefined;
  await fixture.clock.advance(20);

  fixture.events.emit("subagents:failed", {
    id: "agent-1",
    status: "stopped",
    durationMs: 120,
  });

  assert.deepEqual(fixture.consumed, []);
  fixture.watchdog.dispose();
});

test("a late acknowledgement cannot publish or clear a replacement watch", async () => {
  let firstReply;
  let attempts = 0;
  const fixture = await watchdogFixture({
    stopHandler({ events, record, requestId }) {
      attempts += 1;
      if (attempts === 1) {
        firstReply = () => events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
        return;
      }
      record.status = "stopped";
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.record.startedAt = 105;
  fixture.record.status = "running";
  await fixture.clock.advance(5);
  startAgent(fixture);

  firstReply();
  await fixture.clock.advance(0);
  assert.equal(fixture.messages.length, 0);
  await fixture.clock.advance(100);

  assert.equal(attempts, 2);
  assert.equal(fixture.messages.length, 1);
  assert.equal(blockedDetails(fixture).startedAt, 105);
  fixture.watchdog.dispose();
});

test("a missing acknowledgement times out and retries at bounded cadence", async () => {
  let attempts = 0;
  const fixture = await watchdogFixture({
    stopHandler() {
      attempts += 1;
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(110);

  assert.equal(attempts, 1);
  assert.equal(blockedDetails(fixture), undefined);
  assert.equal(fixture.messages.length, 1);
  assert.match(fixture.messages[0].message.content, /No reply/);
  await fixture.clock.advance(20);

  assert.equal(attempts, 2);
  assert.equal(fixture.messages.length, 1);
  fixture.watchdog.dispose();
});

test("dispose suppresses a late successful acknowledgement", async () => {
  let pendingReply;
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      pendingReply = () => events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.watchdog.dispose();
  pendingReply();
  await fixture.clock.advance(0);

  assert.equal(fixture.messages.length, 0);
  assert.deepEqual(fixture.consumed, []);
});

test("dispose cancels an in-flight RPC timeout and reply subscription", async () => {
  const fixture = await watchdogFixture({ stopHandler() {} });
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(fixture.clock.timers.size, 1);
  assert.equal(
    [...fixture.events.handlers.entries()].filter(([name, handlers]) => name.includes(":reply:") && handlers.size > 0).length,
    1,
  );

  fixture.watchdog.dispose();

  assert.equal(fixture.clock.timers.size, 0);
  assert.equal(
    [...fixture.events.handlers.entries()].filter(([name, handlers]) => name.includes(":reply:") && handlers.size > 0).length,
    0,
  );
});

test("dispose clears a scheduled cancellation retry", async () => {
  const fixture = await watchdogFixture({
    stopHandler({ events, requestId }) {
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "transport down" });
    },
  });
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(fixture.clock.timers.size, 1);

  fixture.watchdog.dispose();

  assert.equal(fixture.clock.timers.size, 0);
});

test("a natural terminal event clears confirmed ownership of later stop events", async () => {
  const fixture = await watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(blockedDetails(fixture).cancellation, "confirmed");

  fixture.record.status = "completed";
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  fixture.record.status = "stopped";
  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });

  assert.deepEqual(fixture.consumed, []);
  fixture.watchdog.dispose();
});
