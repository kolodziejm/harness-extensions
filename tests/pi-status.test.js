import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import harnessStatusExtension, {
  statusExtensionForProfile,
} from "../packages/pi/index.js";
import {
  codexWeeklyPace,
  resolvePiUsageEntrypoint,
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

test("Codex usage integration resolves only a configured pi-usage package", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-extensions-"));
  const packageRoot = join(root, "shared", "@narumitw", "pi-usage");
  const profileRoot = join(root, "profile");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(profileRoot);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@narumitw/pi-usage" }));
  writeFileSync(join(packageRoot, "dist", "index.ts"), "export {};\n");
  writeFileSync(join(profileRoot, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
  assert.equal(
    resolvePiUsageEntrypoint(profileRoot),
    new URL(`file://${join(packageRoot, "dist", "index.ts")}`).href,
  );
});
