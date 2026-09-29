import type { RuntimeSettingsView } from "../../../packages/domain/src/agent";

export const runtimeLimits = {
  jevTimeoutMs: { min: 1_000, max: 30_000 },
  piMaxIterations: { min: 1, max: 8 },
  piTimeoutMs: { min: 5_000, max: 15 * 60 * 1_000 },
} as const;

export function parseRuntimeInteger(
  value: string,
  label: string,
  limits: { min: number; max: number },
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < limits.min || parsed > limits.max)
    throw new Error(`${label} must be a whole number from ${limits.min} to ${limits.max}.`);
  return parsed;
}

export function runtimeReadiness(settings: RuntimeSettingsView) {
  return {
    jev: !settings.jev.enabled ? "Off" : settings.jev.configured ? "Ready" : "API key required",
    pi: settings.pi.enabled ? "Enabled" : "Off",
  };
}
