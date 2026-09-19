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
        .filter(([, value]) => value.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      const [id, value] = due;
      this.timers.delete(id);
      this.time = value.at;
      value.callback();
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

function host(events, messages = []) {
  const handlers = new Map();
  return {
    events,
    messages,
    on(name, handler) {
      const group = handlers.get(name) ?? [];
      group.push(handler);
      handlers.set(name, group);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) handler();
    },
    handlerCount(name) {
      return (handlers.get(name) ?? []).length;
    },
  };
}

test("one watchdog per event bus survives owner handoff and disposes with its last owner", async () => {
  let registerSubagentWatchdog;
  try {
    ({ default: registerSubagentWatchdog } = await import("../packages/pi/extensions/subagent-watchdog-lifecycle.js"));
  } catch {}
  assert.equal(typeof registerSubagentWatchdog, "function");

  const clock = new FakeClock();
  const events = new FakeEvents();
  const first = host(events);
  const survivor = host(events);
  const isolated = host(new FakeEvents());
  const record = {
    id: "agent-1",
    status: "running",
    startedAt: 0,
    session: { messages: [], subscribe: () => () => {} },
  };
  const dependencies = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getManager: () => ({ getRecord: (id) => id === record.id ? record : undefined }),
    timeouts: { startupMs: 10, idleMs: 0, totalMs: 0 },
  };
  events.on("subagents:rpc:stop", ({ requestId }) => {
    record.status = "stopped";
    events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
  });

  const firstWatchdog = registerSubagentWatchdog(first, dependencies);
  assert.equal(registerSubagentWatchdog(first), firstWatchdog);
  const duplicate = registerSubagentWatchdog(survivor, { timeouts: { startupMs: 0, idleMs: 0, totalMs: 0 } });
  const isolatedWatchdog = registerSubagentWatchdog(isolated, { timeouts: { startupMs: 0, idleMs: 0, totalMs: 0 } });
  assert.equal(duplicate, firstWatchdog);
  assert.notEqual(isolatedWatchdog, firstWatchdog);
  assert.equal(first.handlerCount("session_shutdown"), 1);
  assert.equal(survivor.handlerCount("session_shutdown"), 1);
  assert.equal(events.handlers.get("subagents:started").size, 1);

  first.shutdown();
  events.emit("subagents:started", { id: record.id, type: "worker", description: "survive handoff" });
  await clock.advance(10);
  assert.equal(first.messages.length, 0);
  assert.equal(survivor.messages[0].message.customType, "subagent-watchdog-blocked");

  survivor.shutdown();
  for (const name of ["subagents:started", "subagents:completed", "subagents:failed"]) {
    assert.equal(events.handlers.get(name).size, 0, name);
  }
  const replacement = host(events);
  assert.notEqual(registerSubagentWatchdog(replacement, dependencies), firstWatchdog);
  replacement.shutdown();
  isolated.shutdown();
});
