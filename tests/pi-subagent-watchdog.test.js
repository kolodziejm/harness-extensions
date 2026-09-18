import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubagentWatchdog,
  default as subagentWatchdog,
  meaningfulProgressKind,
  watchdogTimeoutsFromEnv,
} from "../packages/pi/extensions/subagent-watchdog.js";

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

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

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

  emit(event) {
    for (const handler of [...this.handlers]) handler(event);
  }
}

function watchdogFixture(overrides = {}) {
  const clock = new FakeClock();
  const events = new FakeEvents();
  const messages = [];
  const emitted = [];
  const originalEmit = events.emit.bind(events);
  events.emit = (name, payload) => {
    emitted.push([name, payload]);
    originalEmit(name, payload);
  };
  const session = new FakeSession();
  const record = {
    id: "agent-1",
    type: "debugger",
    description: "Find the startup deadlock",
    status: "running",
    startedAt: 0,
    session,
  };
  const manager = {
    getRecord(id) {
      return id === record.id ? record : undefined;
    },
  };
  const stopped = [];
  const consumed = [];
  events.on("subagents:rpc:stop", ({ requestId, agentId }) => {
    stopped.push(agentId);
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
    timeouts: { startupMs: 100, idleMs: 150, totalMs: 300 },
    ...overrides,
  });
  return { clock, consumed, emitted, events, manager, messages, pi, record, session, stopped, watchdog };
}

function startAgent(fixture) {
  fixture.events.emit("subagents:started", {
    id: fixture.record.id,
    type: fixture.record.type,
    description: fixture.record.description,
  });
}

function blockedDetails(fixture) {
  const item = fixture.messages.find(({ message }) => message.customType === "subagent-watchdog-blocked");
  return item?.message.details;
}

test("timeout configuration is bounded and independently disableable", () => {
  assert.deepEqual(watchdogTimeoutsFromEnv({}), {
    startupMs: 120_000,
    idleMs: 300_000,
    totalMs: 1_800_000,
  });
  assert.deepEqual(watchdogTimeoutsFromEnv({
    PI_SUBAGENT_WATCHDOG_STARTUP_MS: "250",
    PI_SUBAGENT_WATCHDOG_IDLE_MS: "0",
    PI_SUBAGENT_WATCHDOG_TOTAL_MS: "900",
  }), {
    startupMs: 250,
    idleMs: 0,
    totalMs: 900,
  });
  assert.deepEqual(watchdogTimeoutsFromEnv({
    PI_SUBAGENT_WATCHDOG_STARTUP_MS: "-1",
    PI_SUBAGENT_WATCHDOG_IDLE_MS: "not-a-number",
    PI_SUBAGENT_WATCHDOG_TOTAL_MS: "999999999999",
  }), {
    startupMs: 120_000,
    idleMs: 300_000,
    totalMs: 1_800_000,
  });
});

test("meaningful progress excludes lifecycle noise and accepts content or tool movement", () => {
  assert.equal(meaningfulProgressKind({ type: "turn_start" }), undefined);
  assert.equal(meaningfulProgressKind({
    type: "message_update",
    assistantMessageEvent: { type: "start" },
  }), undefined);
  assert.equal(meaningfulProgressKind({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "" },
  }), undefined);
  assert.equal(meaningfulProgressKind({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
  }), "thinking_delta");
  assert.equal(meaningfulProgressKind({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start" },
  }), "toolcall_start");
  assert.equal(meaningfulProgressKind({ type: "tool_execution_start", toolName: "bash" }), "tool_execution_start:bash");
  assert.equal(meaningfulProgressKind({ type: "bash_execution_update", delta: "line" }), "bash_execution_update");
  assert.equal(meaningfulProgressKind({ type: "compaction_start" }), "compaction_start");
});

test("startup timeout cancels a zero-progress child and reports terminal BLOCKED evidence", async () => {
  const fixture = watchdogFixture();
  startAgent(fixture);

  await fixture.clock.advance(99);
  assert.deepEqual(fixture.stopped, []);
  await fixture.clock.advance(1);

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

test("idle timeout resets only on meaningful progress and records its timestamp", async () => {
  const fixture = watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(40);
  fixture.session.emit({ type: "turn_start" });
  await fixture.clock.advance(10);
  fixture.session.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "working" },
  });

  await fixture.clock.advance(149);
  assert.deepEqual(fixture.stopped, []);
  await fixture.clock.advance(1);

  assert.deepEqual(fixture.stopped, ["agent-1"]);
  assert.equal(blockedDetails(fixture).reason, "idle_timeout");
  assert.equal(blockedDetails(fixture).lastProgressAt, 50);
  assert.equal(blockedDetails(fixture).lastProgressKind, "text_delta");
  assert.equal(blockedDetails(fixture).blockedAt, 200);
  fixture.watchdog.dispose();
});

test("total runtime wins while steady progress keeps the idle deadline moving", async () => {
  const fixture = watchdogFixture();
  startAgent(fixture);
  for (const target of [80, 160, 240]) {
    await fixture.clock.advance(target - fixture.clock.time);
    fixture.session.emit({ type: "tool_execution_update", toolName: "bash" });
  }

  await fixture.clock.advance(59);
  assert.deepEqual(fixture.stopped, []);
  await fixture.clock.advance(1);

  assert.deepEqual(fixture.stopped, ["agent-1"]);
  assert.equal(blockedDetails(fixture).reason, "total_timeout");
  assert.equal(blockedDetails(fixture).lastProgressAt, 240);
  assert.equal(blockedDetails(fixture).lastProgressKind, "tool_execution_update:bash");
  assert.equal(blockedDetails(fixture).blockedAt, 300);
  fixture.watchdog.dispose();
});

test("a session that appears after started is attached without extending startup", async () => {
  const fixture = watchdogFixture();
  fixture.record.session = undefined;
  startAgent(fixture);
  await fixture.clock.advance(20);
  fixture.record.session = fixture.session;
  await fixture.clock.advance(5);
  fixture.session.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ready" },
  });
  await fixture.clock.advance(99);
  assert.deepEqual(fixture.stopped, []);
  await fixture.clock.advance(51);
  assert.equal(blockedDetails(fixture).reason, "idle_timeout");
  assert.equal(blockedDetails(fixture).lastProgressAt, 25);
  fixture.watchdog.dispose();
});

test("late attachment recovers progress already present in the current run", async () => {
  const fixture = watchdogFixture();
  fixture.record.session = undefined;
  startAgent(fixture);
  await fixture.clock.advance(20);
  fixture.session.messages.push(
    { role: "user", content: "prompt" },
    { role: "assistant", content: [{ type: "thinking", thinking: "already emitted" }] },
  );
  fixture.record.session = fixture.session;
  await fixture.clock.advance(5);
  await fixture.clock.advance(74);
  assert.deepEqual(fixture.stopped, []);
  await fixture.clock.advance(76);
  assert.equal(blockedDetails(fixture).reason, "idle_timeout");
  assert.equal(blockedDetails(fixture).lastProgressAt, 25);
  assert.equal(blockedDetails(fixture).lastProgressKind, "recovered:thinking");
  fixture.watchdog.dispose();
});

test("historical messages from a resumed session do not satisfy startup progress", async () => {
  const fixture = watchdogFixture();
  fixture.session.messages.push(
    { role: "user", content: "old prompt" },
    { role: "assistant", content: [{ type: "text", text: "old result" }] },
  );
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(blockedDetails(fixture).reason, "startup_timeout");
  assert.equal(blockedDetails(fixture).lastProgressAt, null);
  fixture.watchdog.dispose();
});

test("normal completion removes every watchdog deadline", async () => {
  const fixture = watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(50);
  fixture.record.status = "completed";
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  await fixture.clock.advance(1_000);
  assert.deepEqual(fixture.stopped, []);
  assert.deepEqual(fixture.messages, []);
  fixture.watchdog.dispose();
});

test("a failed cancellation never claims terminal BLOCKED", async () => {
  const fixture = watchdogFixture();
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    ({ requestId }) => fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
      success: false,
      error: "Agent is not running",
    }),
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(blockedDetails(fixture), undefined);
  assert.equal(fixture.emitted.some(([name]) => name === "subagents:watchdog:error"), true);
  assert.equal(fixture.messages.at(-1).message.customType, "subagent-watchdog-error");
  assert.equal(fixture.messages.at(-1).message.details.status, "WATCHDOG_ERROR");
  assert.equal(fixture.messages.at(-1).message.details.cancellation, "failed");
  fixture.watchdog.dispose();
});

test("failed and missing stop acknowledgements retry without repeating WATCHDOG_ERROR", async () => {
  const fixture = watchdogFixture({ cancellationRetryMs: 20 });
  let attempts = 0;
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    ({ requestId, agentId }) => {
      fixture.stopped.push(agentId);
      attempts += 1;
      if (attempts === 1) {
        fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
          success: false,
          error: "Temporarily unavailable",
        });
      } else if (attempts === 3) {
        fixture.record.status = "stopped";
        fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
      }
    },
  ]));
  startAgent(fixture);

  await fixture.clock.advance(100);
  assert.equal(fixture.messages.filter(({ message }) => message.customType === "subagent-watchdog-error").length, 1);
  await fixture.clock.advance(20);
  await fixture.clock.advance(10);
  assert.equal(fixture.messages.filter(({ message }) => message.customType === "subagent-watchdog-error").length, 1);
  await fixture.clock.advance(20);

  assert.deepEqual(fixture.stopped, ["agent-1", "agent-1", "agent-1"]);
  assert.equal(blockedDetails(fixture).cancellation, "confirmed");
  assert.equal(fixture.messages.filter(({ message }) => message.customType === "subagent-watchdog-error").length, 1);
  fixture.watchdog.dispose();
});

test("a natural terminal event remains visible while stop acknowledgement is pending", async () => {
  const fixture = watchdogFixture();
  let pendingRequest;
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    (request) => {
      fixture.stopped.push(request.agentId);
      pendingRequest = request;
    },
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);

  fixture.record.status = "completed";
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  fixture.events.emit(`subagents:rpc:stop:reply:${pendingRequest.requestId}`, { success: true });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(fixture.consumed, []);
  assert.equal(blockedDetails(fixture), undefined);
  fixture.watchdog.dispose();
});

test("a stopped terminal event is consumed when it precedes the successful acknowledgement", async () => {
  const fixture = watchdogFixture();
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    ({ requestId, agentId }) => {
      fixture.stopped.push(agentId);
      fixture.record.status = "stopped";
      fixture.events.emit("subagents:failed", { id: agentId, status: "stopped" });
      fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    },
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);

  assert.deepEqual(fixture.consumed, ["agent-1"]);
  assert.equal(blockedDetails(fixture).cancellation, "confirmed");
  fixture.watchdog.dispose();
});

test("a stopped terminal event is not consumed before a failed acknowledgement", async () => {
  const fixture = watchdogFixture();
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    ({ requestId, agentId }) => {
      fixture.stopped.push(agentId);
      fixture.record.status = "stopped";
      fixture.events.emit("subagents:failed", { id: agentId, status: "stopped" });
      fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
        success: false,
        error: "Agent is not running",
      });
    },
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);

  assert.deepEqual(fixture.consumed, []);
  assert.equal(blockedDetails(fixture), undefined);
  fixture.watchdog.dispose();
});

test("a late acknowledgement cannot clear or report for a replacement watch with the same ID", async () => {
  const fixture = watchdogFixture();
  let firstRequest;
  let attempts = 0;
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    ({ requestId, agentId }) => {
      fixture.stopped.push(agentId);
      attempts += 1;
      if (attempts === 1) {
        firstRequest = requestId;
      } else {
        fixture.record.status = "stopped";
        fixture.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
      }
    },
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);

  fixture.record.status = "running";
  fixture.record.startedAt = 100;
  startAgent(fixture);
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  fixture.events.emit(`subagents:rpc:stop:reply:${firstRequest}`, { success: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(blockedDetails(fixture), undefined);

  await fixture.clock.advance(100);
  assert.deepEqual(fixture.stopped, ["agent-1", "agent-1"]);
  assert.equal(blockedDetails(fixture).blockedAt, 200);
  fixture.watchdog.dispose();
});

test("singleton ownership is isolated per event bus and notifications follow a surviving owner", async () => {
  function host(events, messages = []) {
    const handlers = new Map();
    return {
      events,
      on(name, handler) {
        handlers.set(name, handler);
      },
      sendMessage(message) {
        messages.push(message);
      },
      shutdown() {
        handlers.get("session_shutdown")?.();
      },
    };
  }

  const firstEvents = new FakeEvents();
  const firstMessages = [];
  const childMessages = [];
  const firstHost = host(firstEvents, firstMessages);
  const childReactivation = host(firstEvents, childMessages);
  const secondHost = host(new FakeEvents());
  const clock = new FakeClock();
  const record = {
    id: "singleton-agent",
    status: "running",
    startedAt: 0,
    session: new FakeSession(),
  };
  firstEvents.on("subagents:rpc:stop", ({ requestId }) => {
    record.status = "stopped";
    firstEvents.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });
  const first = subagentWatchdog(firstHost, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getManager: () => ({ getRecord: (id) => id === record.id ? record : undefined }),
    timeouts: { startupMs: 10, idleMs: 0, totalMs: 0 },
  });
  const duplicate = subagentWatchdog(childReactivation, { timeouts: { startupMs: 0, idleMs: 0, totalMs: 0 } });
  const second = subagentWatchdog(secondHost, { timeouts: { startupMs: 0, idleMs: 0, totalMs: 0 } });

  assert.equal(duplicate, first);
  assert.notEqual(second, first);
  firstHost.shutdown();
  assert.equal(subagentWatchdog(childReactivation), first);
  firstEvents.emit("subagents:started", {
    id: record.id,
    type: "debugger",
    description: "survive root shutdown",
  });
  await clock.advance(10);
  assert.deepEqual(firstMessages, []);
  assert.equal(childMessages.at(-1).customType, "subagent-watchdog-blocked");
  childReactivation.shutdown();
  const replacementHost = host(firstEvents);
  assert.notEqual(subagentWatchdog(replacementHost), first);
  replacementHost.shutdown();
  secondHost.shutdown();
});

test("a natural terminal event clears confirmed cancellation state without consuming later events", async () => {
  const fixture = watchdogFixture();
  startAgent(fixture);
  await fixture.clock.advance(100);
  assert.equal(blockedDetails(fixture).cancellation, "confirmed");

  fixture.record.status = "completed";
  fixture.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
  fixture.events.emit("subagents:failed", { id: "agent-1", status: "stopped" });

  assert.deepEqual(fixture.consumed, []);
  fixture.watchdog.dispose();
});

test("shutdown during cancellation cannot publish into the disposed session", async () => {
  const fixture = watchdogFixture();
  let pendingRequest;
  fixture.events.handlers.set("subagents:rpc:stop", new Set([
    (request) => {
      pendingRequest = request;
      fixture.record.status = "stopped";
    },
  ]));
  startAgent(fixture);
  await fixture.clock.advance(100);
  fixture.watchdog.dispose();
  fixture.events.emit(`subagents:rpc:stop:reply:${pendingRequest.requestId}`, { success: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fixture.messages, []);
  assert.equal(fixture.emitted.some(([name]) => name === "subagents:watchdog:blocked"), false);
});
