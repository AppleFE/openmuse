/** Both CopilotKit values and Pi text-content envelopes are used in persisted threads. */
export function toolResultValue(result: unknown): unknown {
  let value = result;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    } else if (
      value &&
      typeof value === "object" &&
      "content" in value &&
      Array.isArray(value.content)
    ) {
      const text = value.content.find(
        (part) => part?.type === "text" && typeof part.text === "string",
      );
      if (!text) return undefined;
      value = text.text;
    } else return value;
  }
  return value;
}
