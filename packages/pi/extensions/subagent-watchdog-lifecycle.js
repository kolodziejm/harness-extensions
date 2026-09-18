import { createSubagentWatchdog } from "./subagent-watchdog.js";

const watchdogsByEventBus = new WeakMap();

export default function registerSubagentWatchdog(pi, dependencies = {}) {
  let entry = watchdogsByEventBus.get(pi.events);
  if (!entry) {
    entry = {
      owners: new Set(),
      notificationOwner: pi,
    };
    const bridge = {
      events: pi.events,
      sendMessage(...args) {
        return entry.notificationOwner?.sendMessage(...args);
      },
    };
    entry.watchdog = createSubagentWatchdog(bridge, dependencies);
    watchdogsByEventBus.set(pi.events, entry);
  }

  if (entry.owners.has(pi)) return entry.watchdog;
  entry.owners.add(pi);
  pi.on("session_shutdown", () => {
    if (watchdogsByEventBus.get(pi.events) !== entry || !entry.owners.delete(pi)) return;
    if (entry.notificationOwner === pi) {
      entry.notificationOwner = entry.owners.values().next().value;
    }
    if (entry.owners.size > 0) return;
    entry.watchdog.dispose();
    watchdogsByEventBus.delete(pi.events);
  });
  return entry.watchdog;
}
