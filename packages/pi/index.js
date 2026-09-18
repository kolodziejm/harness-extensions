import codexPaceStatus from "./extensions/codex-pace-status.js";
import deepseekPriceStatus from "./extensions/deepseek-price-status.js";
import glmPriceStatus from "./extensions/glm-price-status.js";

export const PI_STATUS_PROFILES = Object.freeze({
  hybrid: deepseekPriceStatus,
  openai: codexPaceStatus,
  deepseek: deepseekPriceStatus,
  glm: glmPriceStatus,
});

export function statusExtensionForProfile(profile) {
  return typeof profile === "string" ? PI_STATUS_PROFILES[profile] : undefined;
}

export default function harnessStatusExtension(pi) {
  const profile = process.env.AGENT_ORCHESTRATION_PROFILE;
  const extension = statusExtensionForProfile(profile);
  if (extension) extension(pi);
}
