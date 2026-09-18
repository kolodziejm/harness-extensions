import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const STATUS_KEY = "agent-orchestration-codex-pace";
const REFRESH_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;
const WEEK_MINUTES = 7 * 24 * 60;
const MIN_WEEK_MINUTES = 6 * 24 * 60;
const MAX_WEEK_MINUTES = 8 * 24 * 60;
const MAX_REPORT_AGE_MS = 15 * 60 * 1000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function signedPercentPoints(value) {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${Object.is(rounded, -0) ? 0 : rounded}pp`;
}

export function codexWeeklyPace(report, now = Date.now()) {
  if (!report || report.providerId !== "openai-codex" || !Array.isArray(report.buckets)) return null;
  if (!finiteNumber(report.capturedAt) || report.capturedAt > now + 60_000) return null;
  if (now - report.capturedAt > MAX_REPORT_AGE_MS) return null;

  const weekly = report.buckets
    .filter((bucket) =>
      bucket && bucket.unit === "percent" && finiteNumber(bucket.used) &&
      bucket.used >= 0 && bucket.used <= 100 && finiteNumber(bucket.windowMinutes) &&
      bucket.windowMinutes >= MIN_WEEK_MINUTES && bucket.windowMinutes <= MAX_WEEK_MINUTES &&
      finiteNumber(bucket.resetsAt))
    .sort((left, right) =>
      Math.abs(left.windowMinutes - WEEK_MINUTES) - Math.abs(right.windowMinutes - WEEK_MINUTES))[0];
  if (!weekly) return null;

  const windowMs = weekly.windowMinutes * 60_000;
  const remainingMs = weekly.resetsAt * 1000 - now;
  if (remainingMs < 0 || remainingMs > windowMs) return null;
  const elapsedPercent = 100 * (1 - remainingMs / windowMs);
  const ahead = weekly.used - elapsedPercent;
  const projection = elapsedPercent >= 1
    ? `${Math.round((weekly.used / elapsedPercent) * 100)}%`
    : "—";
  return `pace ${signedPercentPoints(ahead)} · proj ${projection}`;
}

export function resolvePiUsageEntrypoint(root) {
  const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
  if (!Array.isArray(settings.packages)) throw new Error("Pi packages are unavailable");
  for (const entry of settings.packages) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string" || !source.startsWith("/")) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
      if (manifest.name === "@narumitw/pi-usage") {
        return pathToFileURL(join(source, "dist", "index.ts")).href;
      }
    } catch {
      // Ignore unrelated malformed package entries and fail closed below.
    }
  }
  throw new Error("Configured pi-usage package is unavailable");
}

async function loadUsageApi() {
  const root = process.env.PI_CODING_AGENT_DIR;
  if (!root) throw new Error("Pi profile root is unavailable");
  return import(resolvePiUsageEntrypoint(root));
}

export default function codexPaceStatus(pi, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setInterval ?? setInterval;
  const unschedule = dependencies.clearInterval ?? clearInterval;
  let usageApiPromise;
  const getUsageApi = () => {
    if (dependencies.usageApi) return Promise.resolve(dependencies.usageApi);
    usageApiPromise ??= loadUsageApi();
    return usageApiPromise;
  };
  let timer;
  let controller;
  let generation = 0;
  let context;

  const publish = (ctx, value) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch {
      // Pi clears status owned by stale extension contexts.
    }
  };
  const stop = () => {
    generation += 1;
    controller?.abort();
    controller = undefined;
    if (timer) unschedule(timer);
    timer = undefined;
  };
  const refresh = async (ctx, model = ctx.model) => {
    const currentGeneration = ++generation;
    controller?.abort();
    controller = new AbortController();
    if (model?.provider !== "openai-codex") {
      publish(ctx, undefined);
      return;
    }
    try {
      const usageApi = await getUsageApi();
      const adapter = usageApi.adapterForProvider("openai-codex");
      if (!adapter) throw new Error("Codex usage adapter unavailable");
      const auth = await usageApi.resolveUsageAuth(ctx, adapter);
      if (!auth) throw new Error("Codex usage auth unavailable");
      const report = await usageApi.queryProviderUsage(
        adapter, auth, controller.signal, QUERY_TIMEOUT_MS,
      );
      if (currentGeneration !== generation || controller.signal.aborted) return;
      publish(ctx, codexWeeklyPace(report, now()) ?? "pace unavailable");
    } catch {
      if (currentGeneration === generation && !controller?.signal.aborted) {
        publish(ctx, "pace unavailable");
      }
    }
  };
  const startTimer = () => {
    if (timer) unschedule(timer);
    timer = schedule(() => refresh(context), REFRESH_MS);
    timer.unref?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    context = ctx;
    startTimer();
    await refresh(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    context = ctx;
    await refresh(ctx, event.model);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    context = undefined;
    publish(ctx, undefined);
  });
}
