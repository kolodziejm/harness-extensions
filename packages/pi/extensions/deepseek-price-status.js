const STATUS_KEY = "agent-orchestration-deepseek-price";
const REFRESH_MS = 60_000;

export function millisecondsToNextUtcMinute(now = Date.now()) {
  return REFRESH_MS - (now % REFRESH_MS);
}

export function deepseekPricePeriod(now = new Date()) {
  const day = now.getUTCDay();
  const weekday = day >= 1 && day <= 5;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const peak = weekday && ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600));
  return peak ? "DS peak ×1" : "DS off-peak ×0.5";
}

export default function deepseekPriceStatus(pi) {
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
      context.ui.setStatus(STATUS_KEY, deepseekPricePeriod());
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
