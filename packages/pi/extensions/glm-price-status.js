const STATUS_KEY = "agent-orchestration-glm-price";
const REFRESH_MS = 60_000;

export function millisecondsToNextUtcMinute(now = Date.now()) {
  return REFRESH_MS - (now % REFRESH_MS);
}

export function glmPricePeriod(now = new Date()) {
  const day = now.getUTCDay();
  const weekday = day >= 1 && day <= 5;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const peak = weekday && minute >= 6 * 60 && minute < 10 * 60;
  return peak ? "GLM peak ×3" : "GLM off-peak ×1";
}

export default function glmPriceStatus(pi) {
  let timer;
  let context;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    timer = setTimeout(() => {
      publish();
      schedule();
    }, millisecondsToNextUtcMinute());
    timer.unref?.();
  };
  const publish = () => {
    if (!context) return;
    try {
      context.ui.setStatus(STATUS_KEY, glmPricePeriod());
    } catch {
      stop();
    }
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    stop();
    publish();
    schedule();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    context = undefined;
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // A stale UI context is already cleared by Pi.
    }
  });
}
