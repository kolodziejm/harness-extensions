const STATUS_KEY = "agent-orchestration-codex-pace";
const CODEX_PROVIDER = "openai-codex";
const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_USAGE_URL = `${CODEX_ORIGIN}/backend-api/wham/usage`;
const REFRESH_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const WEEK_MINUTES = 7 * 24 * 60;
const MIN_WEEK_MINUTES = 6 * 24 * 60;
const MAX_WEEK_MINUTES = 8 * 24 * 60;
const MAX_REPORT_AGE_MS = 15 * 60 * 1000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function asNumber(value) {
  if (finiteNumber(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function hasOfficialCodexOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === CODEX_ORIGIN;
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === expected && typeof value === "string" && value) return value;
  }
  return undefined;
}

function signedPercentPoints(value) {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${Object.is(rounded, -0) ? 0 : rounded}pp`;
}

export function codexWeeklyPace(report, now = Date.now()) {
  if (!report || report.providerId !== CODEX_PROVIDER || !Array.isArray(report.buckets)) return null;
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

export function normalizeCodexUsage(payload, capturedAt = Date.now()) {
  const root = asObject(payload);
  const rateLimit = asObject(root?.rate_limit);
  const buckets = [];
  for (const [position, raw] of [
    ["primary", rateLimit?.primary_window],
    ["secondary", rateLimit?.secondary_window],
  ]) {
    const window = asObject(raw);
    const used = asNumber(window?.used_percent);
    if (used === undefined) continue;
    const seconds = asNumber(window?.limit_window_seconds);
    const resetsAt = asNumber(window?.reset_at);
    buckets.push({
      id: `codex:${position}`,
      unit: "percent",
      used,
      ...(seconds !== undefined && seconds > 0
        ? { windowMinutes: Math.ceil(seconds / 60) }
        : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return { providerId: CODEX_PROVIDER, capturedAt, buckets };
}

async function readBoundedJson(response) {
  if (response.redirected) throw new Error("Codex usage redirected");
  if (!response.ok) throw new Error("Codex usage request failed");
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Codex usage response too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Codex usage response too large");
  }
  const payload = JSON.parse(text);
  if (!asObject(payload)) throw new Error("Codex usage response malformed");
  return payload;
}

export async function queryCodexUsage(ctx, signal, dependencies = {}) {
  if (ctx.model?.provider !== CODEX_PROVIDER || !hasOfficialCodexOrigin(ctx.model.baseUrl)) {
    throw new Error("Official Codex model required");
  }
  const registry = ctx.modelRegistry;
  const provider = registry.getProvider(CODEX_PROVIDER);
  if (provider?.baseUrl && !hasOfficialCodexOrigin(provider.baseUrl)) {
    throw new Error("Official Codex provider required");
  }
  const resolved = await registry.getProviderAuth(CODEX_PROVIDER);
  const auth = resolved?.auth;
  if (!auth) throw new Error("Codex usage auth unavailable");
  if (auth.baseUrl && !hasOfficialCodexOrigin(auth.baseUrl)) {
    throw new Error("Official Codex auth origin required");
  }

  const headers = { Accept: "application/json" };
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }
  if (!headerValue(headers, "authorization")) {
    if (typeof auth.apiKey !== "string" || !auth.apiKey) {
      throw new Error("Codex usage authorization unavailable");
    }
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  const requestController = new AbortController();
  const abortFromParent = () => requestController.abort(signal.reason);
  if (signal.aborted) abortFromParent();
  else signal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = (dependencies.setTimeout ?? setTimeout)(
    () => requestController.abort(),
    dependencies.timeoutMs ?? QUERY_TIMEOUT_MS,
  );
  try {
    const response = await (dependencies.fetch ?? fetch)(CODEX_USAGE_URL, {
      method: "GET",
      headers,
      redirect: "error",
      signal: requestController.signal,
    });
    return normalizeCodexUsage(
      await readBoundedJson(response),
      (dependencies.now ?? Date.now)(),
    );
  } finally {
    (dependencies.clearTimeout ?? clearTimeout)(timeout);
    signal.removeEventListener("abort", abortFromParent);
  }
}

export default function codexPaceStatus(pi, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setInterval ?? setInterval;
  const unschedule = dependencies.clearInterval ?? clearInterval;
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
    const requestController = new AbortController();
    controller = requestController;
    if (model?.provider !== CODEX_PROVIDER) {
      publish(ctx, undefined);
      return;
    }
    try {
      const report = await queryCodexUsage(ctx, requestController.signal, {
        fetch: dependencies.fetch,
        now,
        setTimeout: dependencies.setTimeout,
        clearTimeout: dependencies.clearTimeout,
        timeoutMs: dependencies.timeoutMs,
      });
      if (currentGeneration !== generation || requestController.signal.aborted) return;
      publish(ctx, codexWeeklyPace(report, now()) ?? "pace unavailable");
    } catch {
      if (currentGeneration === generation && !requestController.signal.aborted) {
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
