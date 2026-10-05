export interface AvailableModel {
  id: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: "disabled" | "missing_credentials" | "provider_removed";
}

export function modelAvailabilityLabel(model: AvailableModel) {
  if (model.available) return "Available";
  if (model.unavailableReason === "missing_credentials") return "Server key required";
  if (model.unavailableReason === "provider_removed") return "OpenCodex 목록에서 제거됨";
  return "Disabled";
}

export function chooseAvailableModel(
  current: string | undefined,
  serverDefault: string | null | undefined,
  models: AvailableModel[],
) {
  if (current && models.some((model) => model.id === current && model.available)) return current;
  if (serverDefault && models.some((model) => model.id === serverDefault && model.available))
    return serverDefault;
  return models.find((model) => model.available)?.id;
}

export function compactSettings(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== undefined && (typeof value !== "string" || value.trim() !== ""),
    ),
  );
}

export function executionDependencies(roleIds: string[], execution: "sequential" | "parallel") {
  return roleIds.map((_, index) =>
    execution === "parallel" || index === 0 ? [] : [roleIds[index - 1]],
  );
}
