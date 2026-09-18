import assert from "node:assert/strict";
import test from "node:test";

import harnessStatusExtension, {
  statusExtensionForProfile,
} from "../packages/pi/index.js";
import codexPaceStatus, {
  codexWeeklyPace,
  normalizeCodexUsage,
} from "../packages/pi/extensions/codex-pace-status.js";
import {
  deepseekPricePeriod,
  millisecondsToNextUtcMinute as deepseekRefresh,
} from "../packages/pi/extensions/deepseek-price-status.js";
import {
  glmPricePeriod,
  millisecondsToNextUtcMinute as glmRefresh,
} from "../packages/pi/extensions/glm-price-status.js";

test("profile dispatch selects exactly one native Pi status extension", () => {
  assert.equal(statusExtensionForProfile("hybrid")?.name, "deepseekPriceStatus");
  assert.equal(statusExtensionForProfile("deepseek")?.name, "deepseekPriceStatus");
  assert.equal(statusExtensionForProfile("openai")?.name, "codexPaceStatus");
  assert.equal(statusExtensionForProfile("glm")?.name, "glmPriceStatus");
  assert.equal(statusExtensionForProfile("unknown"), undefined);
});

test("entrypoint registers only the selected profile handlers", () => {
  const previous = process.env.AGENT_ORCHESTRATION_PROFILE;
  try {
    for (const [profile, expected] of [
      ["hybrid", ["session_start", "session_shutdown"]],
      ["deepseek", ["session_start", "session_shutdown"]],
      ["openai", ["session_start", "model_select", "session_shutdown"]],
      ["glm", ["session_start", "session_shutdown"]],
      ["unknown", []],
    ]) {
      process.env.AGENT_ORCHESTRATION_PROFILE = profile;
      const events = [];
      harnessStatusExtension({ on(name) { events.push(name); } });
      assert.deepEqual(events, expected, profile);
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_ORCHESTRATION_PROFILE;
    else process.env.AGENT_ORCHESTRATION_PROFILE = previous;
  }
});

test("DeepSeek pricing follows weekday UTC half-open windows", () => {
  const cases = [
    ["2026-09-07T00:59:59.999Z", "DS off-peak ×0.5"],
    ["2026-09-07T01:00:00.000Z", "DS peak ×1"],
    ["2026-09-07T03:59:59.999Z", "DS peak ×1"],
    ["2026-09-07T04:00:00.000Z", "DS off-peak ×0.5"],
    ["2026-09-07T06:00:00.000Z", "DS peak ×1"],
    ["2026-09-07T10:00:00.000Z", "DS off-peak ×0.5"],
    ["2026-09-12T02:00:00.000Z", "DS off-peak ×0.5"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(deepseekPricePeriod(new Date(value)), expected, value);
  }
  assert.deepEqual([
    deepseekRefresh(Date.parse("2026-09-07T00:59:00.000Z")),
    deepseekRefresh(Date.parse("2026-09-07T00:59:00.500Z")),
    deepseekRefresh(Date.parse("2026-09-07T00:59:59.999Z")),
  ], [60_000, 59_500, 1]);
});

test("GLM pricing follows its weekday UTC half-open window", () => {
  const cases = [
    ["2026-09-11T05:59:00.000Z", "GLM off-peak ×1"],
    ["2026-09-11T06:00:00.000Z", "GLM peak ×3"],
    ["2026-09-11T09:59:00.000Z", "GLM peak ×3"],
    ["2026-09-11T10:00:00.000Z", "GLM off-peak ×1"],
    ["2026-09-12T07:00:00.000Z", "GLM off-peak ×1"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(glmPricePeriod(new Date(value)), expected, value);
  }
  assert.deepEqual([
    glmRefresh(Date.parse("2026-09-11T06:00:00.000Z")),
    glmRefresh(Date.parse("2026-09-11T06:00:00.500Z")),
    glmRefresh(Date.parse("2026-09-11T06:00:59.999Z")),
  ], [60_000, 59_500, 1]);
});

test("Codex weekly pace accepts a current seven-day bucket and rejects stale data", () => {
  const now = 1_800_000_000_000;
  const valid = {
    providerId: "openai-codex",
    capturedAt: now - 60_000,
    buckets: [{
      unit: "percent",
      used: 60,
      windowMinutes: 7 * 24 * 60,
      resetsAt: (now + 3.5 * 24 * 60 * 60 * 1000) / 1000,
    }],
  };
  assert.equal(codexWeeklyPace(valid, now), "pace +10pp · proj 120%");
  assert.equal(codexWeeklyPace({ ...valid, capturedAt: now - 16 * 60_000 }, now), null);
  assert.equal(codexWeeklyPace({ ...valid, buckets: [] }, now), null);
});

function codexContext(overrides = {}) {
  const statuses = [];
  const auth = overrides.auth === undefined
    ? { apiKey: "test-token", baseUrl: "https://chatgpt.com/backend-api" }
    : overrides.auth;
  return {
    statuses,
    context: {
      model: overrides.model ?? {
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      modelRegistry: {
        getProvider() {
          return overrides.provider ?? { baseUrl: "https://chatgpt.com/backend-api" };
        },
        async getProviderAuth() {
          return auth ? { auth } : undefined;
        },
      },
      ui: {
        setStatus(key, value) {
          statuses.push([key, value]);
        },
      },
    },
  };
}

function codexHandlers(dependencies) {
  const handlers = new Map();
  codexPaceStatus({ on(name, handler) { handlers.set(name, handler); } }, {
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    ...dependencies,
  });
  return handlers;
}

function usageResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const WEEKLY_PAYLOAD = {
  rate_limit: {
    primary_window: {
      used_percent: "60",
      limit_window_seconds: String(7 * 24 * 60 * 60),
      reset_at: String((1_800_000_000_000 + 3.5 * 24 * 60 * 60 * 1000) / 1000),
    },
  },
};

test("Codex usage normalization accepts numeric strings", () => {
  const report = normalizeCodexUsage(WEEKLY_PAYLOAD, 1_800_000_000_000);
  assert.equal(codexWeeklyPace(report, 1_800_000_000_000), "pace +10pp · proj 120%");
});

test("Codex pace reads resolved official auth and publishes weekly pace", async () => {
  const { context, statuses } = codexContext();
  let requested;
  const handlers = codexHandlers({
    now: () => 1_800_000_000_000,
    async fetch(url, options) {
      requested = { url, options };
      return usageResponse(WEEKLY_PAYLOAD);
    },
  });

  await handlers.get("session_start")({}, context);

  assert.equal(requested.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requested.options.method, "GET");
  assert.equal(requested.options.redirect, "error");
  assert.equal(requested.options.headers.Authorization.startsWith("Bearer "), true);
  assert.deepEqual(statuses.at(-1), [
    "agent-orchestration-codex-pace",
    "pace +10pp · proj 120%",
  ]);
});

test("Codex pace fails closed on custom credential origins", async () => {
  const cases = [
    { model: { provider: "openai-codex", baseUrl: "https://proxy.invalid" } },
    { provider: { baseUrl: "https://proxy.invalid" } },
    { auth: { apiKey: "test-token", baseUrl: "https://proxy.invalid" } },
  ];
  for (const overrides of cases) {
    const { context, statuses } = codexContext(overrides);
    let fetchCalls = 0;
    const handlers = codexHandlers({
      async fetch() {
        fetchCalls += 1;
        return usageResponse(WEEKLY_PAYLOAD);
      },
    });
    await handlers.get("session_start")({}, context);
    assert.equal(fetchCalls, 0);
    assert.equal(statuses.at(-1)?.[1], "pace unavailable");
  }
});

test("Codex pace degrades safely for missing auth, HTTP errors, and malformed data", async () => {
  const cases = [
    { auth: null, fetch: async () => usageResponse(WEEKLY_PAYLOAD) },
    { fetch: async () => usageResponse({ message: "sensitive" }, 401) },
    { fetch: async () => usageResponse({ rate_limit: {} }) },
  ];
  for (const item of cases) {
    const { context, statuses } = codexContext({ auth: item.auth });
    const handlers = codexHandlers({ fetch: item.fetch });
    await handlers.get("session_start")({}, context);
    assert.equal(statuses.at(-1)?.[1], "pace unavailable");
  }
});

test("Codex pace preserves resolved string headers and existing authorization", async () => {
  const { context } = codexContext({
    auth: {
      apiKey: "unused-token",
      headers: {
        authorization: "Bearer resolved-token",
        "ChatGPT-Account-Id": "account-id",
        "X-Ignored": null,
      },
      baseUrl: "https://chatgpt.com/backend-api",
    },
  });
  let requestHeaders;
  const handlers = codexHandlers({
    now: () => 1_800_000_000_000,
    async fetch(_url, options) {
      requestHeaders = options.headers;
      return usageResponse(WEEKLY_PAYLOAD);
    },
  });
  await handlers.get("session_start")({}, context);
  assert.equal(requestHeaders.authorization.startsWith("Bearer "), true);
  assert.equal(requestHeaders.Authorization, undefined);
  assert.equal(requestHeaders["ChatGPT-Account-Id"], "account-id");
  assert.equal(requestHeaders["X-Ignored"], undefined);
});

test("Codex pace bounds responses and enforces the request timeout", async () => {
  for (const dependencies of [
    {
      setTimeout(callback) {
        callback();
        return 1;
      },
      clearTimeout() {},
      async fetch(_url, options) {
        assert.equal(options.signal.aborted, true);
        throw new Error("aborted");
      },
    },
    {
      async fetch() {
        return usageResponse({ padding: "x".repeat(65 * 1024) });
      },
    },
  ]) {
    const { context, statuses } = codexContext();
    const handlers = codexHandlers(dependencies);
    await handlers.get("session_start")({}, context);
    assert.equal(statuses.at(-1)?.[1], "pace unavailable");
  }
});

test("Codex pace shutdown aborts an in-flight request without unhandled rejection", async () => {
  const { context, statuses } = codexContext();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    const handlers = codexHandlers({
      fetch(_url, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const starting = handlers.get("session_start")({}, context);
    await Promise.resolve();
    handlers.get("session_shutdown")({}, context);
    await starting;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
    assert.deepEqual(statuses.at(-1), ["agent-orchestration-codex-pace", undefined]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
