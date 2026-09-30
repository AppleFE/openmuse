export type StoredThreadSelections = Record<string, string>;

export function parseStoredThreadSelections(value: string): StoredThreadSelections {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          entry[0].length > 0 &&
          typeof entry[1] === "string" &&
          entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function storeThreadSelection(
  selections: StoredThreadSelections,
  runtimeUrl: string,
  threadId: string,
): StoredThreadSelections {
  return { ...selections, [runtimeUrl]: threadId };
}

export function mergeThreadPages<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) merged.set(thread.id, thread);
  return [...merged.values()];
}

export function messageSpeakerLabel(message: {
  role?: unknown;
  name?: unknown;
  speakerRole?: unknown;
}) {
  if (message.role === "user") return "";
  const label =
    typeof message.name === "string"
      ? message.name
      : typeof message.speakerRole === "string"
        ? message.speakerRole
        : "";
  return label.toLowerCase() === "assistant" ? "" : label;
}
