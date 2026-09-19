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

async function deadlineFixture(overrides = {}) {
  const { createSubagentDeadlineTracker } = await import("../packages/pi/extensions/subagent-watchdog-core.js");
  assert.equal(typeof createSubagentDeadlineTracker, "function");
  const clock = new FakeClock();
  const session = new FakeSession();
  const record = {
    id: "agent-1",
    status: "running",
    startedAt: 0,
    session,
  };
  const expirations = [];
  const tracker = createSubagentDeadlineTracker({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getRecord: (id) => id === record.id ? record : undefined,
    onExpire: (watch, deadline) => expirations.push({ watch, deadline }),
    pollIntervalMs: 5,
    timeouts: { startupMs: 100, idleMs: 150, totalMs: 300 },
    ...overrides,
  });
  return { clock, expirations, record, session, tracker };
}

test("watchdog timeout configuration is bounded and independently disableable", async () => {
  let watchdogTimeoutsFromEnv;
  try {
    ({ watchdogTimeoutsFromEnv } = await import("../packages/pi/extensions/subagent-watchdog-core.js"));
  } catch {}

  assert.equal(typeof watchdogTimeoutsFromEnv, "function");
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
    PI_SUBAGENT_WATCHDOG_STARTUP_MS: "",
    PI_SUBAGENT_WATCHDOG_IDLE_MS: "not-a-number",
    PI_SUBAGENT_WATCHDOG_TOTAL_MS: "999999999999",
  }), {
    startupMs: 120_000,
    idleMs: 300_000,
    totalMs: 1_800_000,
  });
});

test("meaningful progress excludes lifecycle noise and accepts content or tool movement", async () => {
  const { meaningfulProgressKind } = await import("../packages/pi/extensions/subagent-watchdog-core.js");

  assert.equal(typeof meaningfulProgressKind, "function");
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

test("startup deadline expires a zero-progress child with evidence", async () => {
  const fixture = await deadlineFixture();
  fixture.tracker.start({
    id: fixture.record.id,
    type: "debugger",
    description: "Find the startup deadlock",
  });

  await fixture.clock.advance(99);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(1);

  assert.deepEqual(fixture.expirations[0].deadline, {
    agentId: "agent-1",
    type: "debugger",
    description: "Find the startup deadlock",
    reason: "startup_timeout",
    timeoutMs: 100,
    startedAt: 0,
    lastProgressAt: null,
    lastProgressKind: null,
    expiredAt: 100,
  });
  fixture.tracker.dispose();
});

test("idle deadline moves only on meaningful progress", async () => {
  const fixture = await deadlineFixture();
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(40);
  fixture.session.emit({ type: "turn_start" });
  await fixture.clock.advance(10);
  fixture.session.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "working" },
  });

  await fixture.clock.advance(149);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(1);

  assert.equal(fixture.expirations[0].deadline.reason, "idle_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, 50);
  assert.equal(fixture.expirations[0].deadline.lastProgressKind, "text_delta");
  assert.equal(fixture.expirations[0].deadline.expiredAt, 200);
  fixture.tracker.dispose();
});

test("total runtime expires despite steady progress", async () => {
  const fixture = await deadlineFixture();
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  for (const target of [80, 160, 240]) {
    await fixture.clock.advance(target - fixture.clock.time);
    fixture.session.emit({ type: "tool_execution_update", toolName: "bash" });
  }

  await fixture.clock.advance(59);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(1);

  assert.equal(fixture.expirations.length, 1);
  assert.equal(fixture.expirations[0].deadline.reason, "total_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, 240);
  assert.equal(fixture.expirations[0].deadline.expiredAt, 300);
  fixture.tracker.dispose();
});

test("a session that appears after start attaches without extending startup", async () => {
  const fixture = await deadlineFixture();
  fixture.record.session = undefined;
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(20);
  fixture.record.session = fixture.session;
  await fixture.clock.advance(5);
  fixture.session.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ready" },
  });

  await fixture.clock.advance(99);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(51);
  assert.equal(fixture.expirations[0].deadline.reason, "idle_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, 25);
  fixture.tracker.dispose();
});

test("late attachment recovers progress emitted during the current run", async () => {
  const fixture = await deadlineFixture();
  fixture.record.session = undefined;
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(20);
  fixture.session.messages.push(
    { role: "user", content: "prompt", timestamp: 20 },
    { role: "assistant", content: [{ type: "thinking", thinking: "already emitted" }], timestamp: 20 },
  );
  fixture.record.session = fixture.session;
  await fixture.clock.advance(5);

  await fixture.clock.advance(74);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(76);
  assert.equal(fixture.expirations[0].deadline.reason, "idle_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, 25);
  assert.equal(fixture.expirations[0].deadline.lastProgressKind, "recovered:thinking");
  fixture.tracker.dispose();
});

test("historical messages from a resumed session do not satisfy startup", async () => {
  const fixture = await deadlineFixture();
  fixture.session.messages.push(
    { role: "user", content: "old prompt", timestamp: -2 },
    { role: "assistant", content: [{ type: "text", text: "old result" }], timestamp: -1 },
  );
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });

  await fixture.clock.advance(100);

  assert.equal(fixture.expirations[0].deadline.reason, "startup_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, null);
  fixture.tracker.dispose();
});

test("history in a session attached late does not satisfy startup", async () => {
  const fixture = await deadlineFixture();
  fixture.record.session = undefined;
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(20);
  fixture.session.messages.push(
    { role: "user", content: "old prompt", timestamp: -2 },
    { role: "assistant", content: [{ type: "text", text: "old result" }], timestamp: -1 },
  );
  fixture.record.session = fixture.session;
  await fixture.clock.advance(80);

  assert.equal(fixture.expirations.length, 1);
  assert.equal(fixture.expirations[0].deadline.reason, "startup_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, null);
  fixture.tracker.dispose();
});

test("expiration detaches progress and clears remaining deadlines", async () => {
  const fixture = await deadlineFixture();
  const watch = fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  assert.equal(fixture.session.handlers.size, 1);

  await fixture.clock.advance(100);

  assert.equal(fixture.expirations.length, 1);
  assert.equal(fixture.tracker.current(fixture.record.id), watch);
  assert.equal(fixture.session.handlers.size, 0);
  assert.equal(fixture.clock.timers.size, 0);
  fixture.tracker.dispose();
  assert.equal(fixture.tracker.current(fixture.record.id), undefined);
});

test("stale deadline callbacks recheck the latest progress", async () => {
  const fixture = await deadlineFixture({ clearTimeout() {} });
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(50);
  fixture.session.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "first" },
  });
  await fixture.clock.advance(50);
  fixture.session.emit({ type: "tool_execution_update", toolName: "bash" });

  await fixture.clock.advance(149);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(1);
  assert.equal(fixture.expirations.length, 1);
  assert.equal(fixture.expirations[0].deadline.reason, "idle_timeout");
  assert.equal(fixture.expirations[0].deadline.lastProgressAt, 100);
  fixture.tracker.dispose();
});

test("release removes deadlines and session subscriptions", async () => {
  const fixture = await deadlineFixture();
  const watch = fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  assert.equal(fixture.session.handlers.size, 1);

  assert.equal(fixture.tracker.release(fixture.record.id, watch), true);
  await fixture.clock.advance(1_000);

  assert.equal(fixture.expirations.length, 0);
  assert.equal(fixture.session.handlers.size, 0);
  assert.equal(fixture.tracker.current(fixture.record.id), undefined);
  fixture.tracker.dispose();
});

test("a replacement watch owns the reused agent ID deadlines", async () => {
  const fixture = await deadlineFixture();
  const first = fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(50);
  fixture.record.startedAt = 50;
  const replacement = fixture.tracker.start({ id: fixture.record.id, type: "debugger" });

  assert.notEqual(replacement, first);
  assert.equal(fixture.tracker.current(fixture.record.id), replacement);
  await fixture.clock.advance(99);
  assert.equal(fixture.expirations.length, 0);
  await fixture.clock.advance(1);
  assert.equal(fixture.expirations.length, 1);
  assert.equal(fixture.expirations[0].watch, replacement);
  fixture.tracker.dispose();
});

test("a terminal record at the deadline is released without expiration", async () => {
  const fixture = await deadlineFixture();
  fixture.tracker.start({ id: fixture.record.id, type: "worker" });
  await fixture.clock.advance(99);
  fixture.record.status = "completed";
  await fixture.clock.advance(1);

  assert.equal(fixture.expirations.length, 0);
  assert.equal(fixture.tracker.current(fixture.record.id), undefined);
  fixture.tracker.dispose();
});
