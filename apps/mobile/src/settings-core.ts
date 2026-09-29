export interface AvailableModel {
  id: string;
  enabled: boolean;
}

export function chooseAvailableModel(
  current: string | undefined,
  serverDefault: string | null | undefined,
  models: AvailableModel[],
) {
  if (current && models.some((model) => model.id === current && model.enabled)) return current;
  if (serverDefault && models.some((model) => model.id === serverDefault && model.enabled))
    return serverDefault;
  return models.find((model) => model.enabled)?.id;
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
